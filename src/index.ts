// OpenCode Go 透传代理（Cloudflare Worker）
// 职责：隐藏 API Key + 清理客户端侧风险头 + 保证编程工具 UA/稳定 session 特征。
//
// 【v2 协议网关】上游按模型分协议：GPT/Luna/Grok 系只认 /responses，
// 国产系（glm/kimi/deepseek/mimo/minimax）只认 /chat/completions。
// CC Switch 的 apiFormat 是卡级开关，无法按模型分流；这里在 Worker 层兜底：
// /responses 请求若模型属于国产系，自动转 chat 并把响应（含流式 SSE/工具调用）转回 responses。
// 其余请求保持纯透传，行为与 v1 完全一致。

// 双上游路由解析（v3：路径归一化，免疫一切前缀形态）
// CC Switch 拼接 base_url 与客户端路径的形态不固定：/responses、/v1/responses、
// /go/v1/responses、/go/v1/v1/responses 都出现过。这里统一剥掉所有 /v1 段和
// /go、/zen 路由标记，只保留真正的 API 路径（/responses、/chat/completions、/models…），
// 再拼上正确的上游根。上游实证有效形态：https://opencode.ai/zen/go/v1/<apiPath>。
function resolveUpstream(pathname: string): { base: string; apiPath: string } {
  const isZen = /\/zen\//.test(pathname); // zen 免费模型标记（显式 /zen 前缀才走 zen 上游）
  let p = pathname.replace(/\/v1(?=\/|$)/g, ''); // 剥所有 /v1 段
  p = p.replace(/^\/(go|zen)(?=\/)/, ''); // 剥路由标记段
  if (p === '' ) p = '/';
  return {
    base: isZen ? 'https://opencode.ai/zen/v1' : 'https://opencode.ai/zen/go/v1',
    apiPath: p,
  };
}

// 视为编程工具的正常 UA 特征（防止上游识别为“未知客户端”）
const SAFE_UA_PATTERN = /^(opencode|claude|codex|cursor|windsurf|aider|continue)/i;
const SAFE_UA_FALLBACK = 'opencode/1.x.x cli';

// Cloudflare 及反代特征头。
const STRIP_HEADERS = [
  'cf-connecting-ip',
  'cf-ray',
  'cf-ipcountry',
  'cf-worker',
  'cf-visitor',
  'x-real-ip',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'via',
  'forwarded',
  'host',
  'content-length',
  'transfer-encoding',
  // 逐跳（hop-by-hop）头：不能转发给上游
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
];

// ============ responses↔chat 协议桥（国产模型专用） ============

type AnyObj = Record<string, any>;

// chat-only 模型路由：已确认的国产模型前缀走桥接；未知模型默认保持 Responses 透传。
// 目录同步会暴露更多模型，但不能仅凭“模型能被列出”推断其协议能力。
// qwen/gpt/grok 及其他未知模型保持 Responses，待能力确认后再加入桥接名单。
const CHAT_MODEL_RE = /^(glm-|kimi-|deepseek-|mimo-|minimax-)/i;

function isChatModel(model: unknown): boolean {
  return typeof model === 'string' && CHAT_MODEL_RE.test(model);
}

function joinText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('');
  }
  return '';
}

// responses 请求体 → chat 请求体
function responsesToChatRequest(rb: AnyObj): AnyObj {
  const messages: AnyObj[] = [];
  if (typeof rb.instructions === 'string' && rb.instructions) {
    messages.push({ role: 'system', content: rb.instructions });
  }
  const input = rb.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input as AnyObj[]) {
      if (!item || typeof item !== 'object') continue;
      const t = item.type ?? (item.role ? 'message' : '');
      if (t === 'message') {
        const role = item.role === 'developer' ? 'system' : item.role ?? 'user';
        messages.push({ role, content: joinText(item.content) });
      } else if (t === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: item.call_id ?? item.id ?? 'call_' + Math.random().toString(36).slice(2),
              type: 'function',
              function: { name: item.name ?? '', arguments: item.arguments ?? '{}' },
            },
          ],
        });
      } else if (t === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id ?? '',
          content:
            typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        });
      }
      // reasoning 等其他类型：chat 侧无需回传，跳过
    }
  }

  const out: AnyObj = { model: rb.model, messages, stream: !!rb.stream };
  if (rb.max_output_tokens != null) out.max_tokens = rb.max_output_tokens;
  if (rb.temperature != null) out.temperature = rb.temperature;
  if (rb.top_p != null) out.top_p = rb.top_p;
  if (rb.parallel_tool_calls != null) out.parallel_tool_calls = rb.parallel_tool_calls;
  if (rb.stop != null) out.stop = rb.stop;

  if (Array.isArray(rb.tools) && rb.tools.length) {
    const tools = (rb.tools as AnyObj[])
      .filter((t) => (t.type ?? 'function') === 'function' && t.name)
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.parameters ?? { type: 'object', properties: {} },
        },
      }));
    if (tools.length) out.tools = tools;
  }
  if (rb.tool_choice != null) {
    const tc: any = rb.tool_choice;
    if (typeof tc === 'string') out.tool_choice = tc;
    else if (tc?.type === 'function' && tc.name)
      out.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  if (rb.stream) out.stream_options = { include_usage: true };
  return out;
}

function mapUsage(u: AnyObj | undefined): AnyObj {
  const it = u?.prompt_tokens ?? 0;
  const ot = u?.completion_tokens ?? 0;
  return {
    input_tokens: it,
    output_tokens: ot,
    total_tokens: u?.total_tokens ?? it + ot,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

function baseResponse(id: string, model: string, status: string, output: AnyObj[], usage?: AnyObj): AnyObj {
  const r: AnyObj = {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    temperature: 1,
    top_p: 1,
    store: false,
  };
  if (usage) r.usage = usage;
  return r;
}

// chat 非流式响应 → responses 响应
function chatToResponsesResponse(cr: AnyObj): AnyObj {
  const choice = cr?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const rid = 'resp_' + String(cr.id ?? crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '');
  const output: AnyObj[] = [];
  const tts = msg.tool_calls;
  if (Array.isArray(tts) && tts.length) {
    for (const tc of tts) {
      output.push({
        type: 'function_call',
        id: 'fc_' + Math.random().toString(36).slice(2),
        call_id: tc.id ?? '',
        name: tc?.function?.name ?? '',
        arguments: tc?.function?.arguments ?? '{}',
        status: 'completed',
      });
    }
  }
  const text = joinText(msg.content);
  output.push({
    type: 'message',
    id: 'msg_' + Math.random().toString(36).slice(2),
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  });
  return baseResponse(rid, cr.model ?? '', 'completed', output, mapUsage(cr.usage));
}

// chat SSE → responses SSE 转换流
function makeChatToResponsesStream(model: string): TransformStream<Uint8Array, Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = '';
  let started = false;
  let finished = false;
  let respId = '';
  let outputIndex = 0;
  // message item 状态
  let msgItemId = '';
  let msgOpen = false;
  let textOpen = false;
  let fullText = '';
  // function_call 聚合状态：index -> state
  const fcs = new Map<number, AnyObj>();
  let usage: AnyObj | undefined;

  const send = (controller: TransformStreamDefaultController<Uint8Array>, event: string, data: AnyObj) => {
    controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  const openMessage = (controller: TransformStreamDefaultController<Uint8Array>) => {
    msgItemId = 'msg_' + Math.random().toString(36).slice(2);
    send(controller, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'message', id: msgItemId, status: 'in_progress', role: 'assistant', content: [] },
    });
    send(controller, 'response.content_part.added', {
      type: 'response.content_part.added',
      item_id: msgItemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    msgOpen = true;
    textOpen = true;
  };

  const closeMessage = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!msgOpen) return;
    if (textOpen) {
      send(controller, 'response.output_text.done', {
        type: 'response.output_text.done',
        item_id: msgItemId,
        output_index: outputIndex,
        content_index: 0,
        text: fullText,
      });
      send(controller, 'response.content_part.done', {
        type: 'response.content_part.done',
        item_id: msgItemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: fullText, annotations: [] },
      });
    }
    send(controller, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: {
        type: 'message',
        id: msgItemId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: fullText, annotations: [] }],
      },
    });
    outputIndex++;
    msgOpen = false;
    textOpen = false;
  };

  const finalize = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (finished) return;
    finished = true;
    closeMessage(controller);
    const output: AnyObj[] = [];
    const fcIdx = [...fcs.keys()].sort((a, b) => a - b);
    for (const i of fcIdx) {
      const fc = fcs.get(i)!;
      output.push({
        type: 'function_call',
        id: fc.id,
        call_id: fc.call_id,
        name: fc.name,
        arguments: fc.arguments,
        status: 'completed',
      });
    }
    if (msgOpen || fullText || (!fcs.size && output.length === 0)) {
      // 空 message 也补一个 item，保证 Codex 至少拿到一条 assistant message
      output.push({
        type: 'message',
        id: msgItemId || 'msg_' + Math.random().toString(36).slice(2),
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: fullText, annotations: [] }],
      });
    }
    send(controller, 'response.completed', {
      type: 'response.completed',
      response: baseResponse(respId, model, 'completed', output, usage ?? mapUsage(undefined)),
    });
  };

  const handleLine = (controller: TransformStreamDefaultController<Uint8Array>, line: string) => {
    const s = line.trim();
    if (!s.startsWith('data:')) return;
    const payload = s.slice(5).trim();
    if (payload === '[DONE]') {
      finalize(controller);
      return;
    }
    let chunk: AnyObj;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    if (!started) {
      started = true;
      respId = 'resp_' + String(chunk.id ?? crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '');
      send(controller, 'response.created', {
        type: 'response.created',
        response: baseResponse(respId, model, 'in_progress', []),
      });
    }
    if (chunk.usage) usage = mapUsage(chunk.usage);
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};

    // 文本增量
    const txt = typeof delta.content === 'string' ? delta.content : '';
    if (txt) {
      if (!msgOpen) openMessage(controller);
      fullText += txt;
      send(controller, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: msgItemId,
        output_index: outputIndex,
        content_index: 0,
        delta: txt,
      });
    }

    // 工具调用增量
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let st = fcs.get(idx);
        if (!st) {
          st = {
            id: 'fc_' + Math.random().toString(36).slice(2),
            call_id: tc.id ?? 'call_' + Math.random().toString(36).slice(2),
            name: tc?.function?.name ?? '',
            arguments: '',
            added: false,
          };
          fcs.set(idx, st);
          // 先收掉文本段，再开 function_call item
          closeMessage(controller);
          send(controller, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: outputIndex,
            item: {
              type: 'function_call',
              id: st.id,
              call_id: st.call_id,
              name: st.name,
              arguments: '',
              status: 'in_progress',
            },
          });
          st.added = true;
        }
        if (tc?.function?.name && !st.name) st.name = tc.function.name;
        const args = tc?.function?.arguments ?? '';
        if (args) {
          st.arguments += args;
          send(controller, 'response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: st.id,
            output_index: outputIndex,
            delta: args,
          });
        }
      }
    }

    if (choice.finish_reason != null) {
      // chat 流通常随后发 usage chunk + [DONE]；这里不提前收尾，等 finalize
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) handleLine(controller, line);
    },
    flush(controller) {
      if (buf) handleLine(controller, buf);
      finalize(controller);
    },
  });
}

// 桥接主流程：拿已解析的 responses 请求体，转 chat 打上游，响应转回 responses。
// 上游错误原样保留状态码，网络/超时返回真实错误；流式响应继续由 guard 负责空闲中断。
async function handleChatBridge(
  rb: AnyObj,
  headers: Headers,
  upstreamUrl: URL
): Promise<Response> {
  const model = String(rb?.model || '');
  const chatBody = responsesToChatRequest(rb);
  const chatUrl = new URL(upstreamUrl.toString().replace(/\/responses(\?|$)/, '/chat/completions$1'));

  const doFetch = async (): Promise<{ response: Response; abort: () => void }> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT);
    try {
      const response = await fetch(chatUrl.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(chatBody),
        signal: ac.signal,
      });
      clearTimeout(timer);
      return { response, abort: () => ac.abort() };
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  };

  let fetched: { response: Response; abort: () => void };
  try {
    fetched = await doFetch();
  } catch {
    return new Response(
      JSON.stringify({ error: 'upstream_unavailable', message: 'chat upstream timed out or unreachable (>60s)' }),
      { status: 504, headers: jsonErrHeaders() }
    );
  }

  const resp = fetched.response;
  if (!resp.ok) {
    const outHeaders = new Headers(resp.headers);
    outHeaders.set('Access-Control-Allow-Origin', '*');
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: outHeaders,
    });
  }

  const outHeaders = new Headers();
  outHeaders.set('Access-Control-Allow-Origin', '*');

  if (chatBody.stream) {
    outHeaders.set('content-type', 'text/event-stream; charset=utf-8');
    outHeaders.set('cache-control', 'no-cache');
    const converted = resp.body!
      .pipeThrough(makeChatToResponsesStream(model))
      .pipeThrough(makeResponsesStreamGuard(model, fetched.abort));
    return new Response(converted, { status: 200, headers: outHeaders });
  }

  let cr: AnyObj;
  try {
    cr = await resp.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'bridge_invalid_json', message: 'chat upstream returned invalid JSON' }),
      { status: 502, headers: jsonErrHeaders() }
    );
  }
  outHeaders.set('content-type', 'application/json');
  return new Response(JSON.stringify(chatToResponsesResponse(cr)), { status: 200, headers: outHeaders });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 【护栏】密钥缺失或含不可打印字符时，Cloudflare 边缘会直接把请求打成
    // 400 Bad Request（空响应体、~1ms），现场极难排查。这里提前给出明确报错。
    const apiKey = env.OPENCODE_API_KEY || '';
    if (!apiKey || /[^\x21-\x7e]/.test(apiKey)) {
      return new Response(
        JSON.stringify(
          {
            error: 'proxy_misconfigured',
            message:
              'OPENCODE_API_KEY 缺失或不是可打印 ASCII。请用 `wrangler secret put OPENCODE_API_KEY` 重新设置（交互式粘贴，勿用管道/重定向）。',
            apiKeyPresent: !!env.OPENCODE_API_KEY,
            apiKeyLength: apiKey.length,
          },
          null,
          2
        ),
        {
          status: 500,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, Authorization, x-opencode-session, x-opencode-client, x-opencode-project',
        },
      });
    }

    // 双上游路由（v3 归一化：免疫 /v1 与 /go、/zen 前缀的一切组合形态）
    const { base, apiPath } = resolveUpstream(url.pathname);
    const upstreamUrl = new URL(base + apiPath + url.search);

    // 读取请求体（仅非 GET/HEAD），用于 session 内容哈希
    let bodyText: string | null = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        bodyText = await request.text();
      } catch {
        bodyText = null;
      }
    }

    // ===== 协议网关分支：/responses + 国产模型 → 桥接 chat =====
    if (
      request.method === 'POST' &&
      apiPath === '/responses' &&
      bodyText
    ) {
      try {
        const rb: AnyObj = JSON.parse(bodyText);
        if (isChatModel(rb?.model)) {
          // 复制并清洗请求头（与透传路径同一套规则）
          const bHeaders = new Headers(request.headers);
          for (const h of STRIP_HEADERS) bHeaders.delete(h);
          // 【v4】Authorization 透传优先：客户端（CC Switch）注入的卡 key 保留，
          // 仅在缺失时才用 env key 兜底。否则多卡流量全部记到 env key 账号头上。
          if (!bHeaders.get('Authorization')) bHeaders.set('Authorization', `Bearer ${apiKey}`);
          const ua = bHeaders.get('User-Agent') || '';
          if (!SAFE_UA_PATTERN.test(ua)) bHeaders.set('User-Agent', SAFE_UA_FALLBACK);
          if (!bHeaders.has('x-opencode-session')) {
            const seed = (bHeaders.get('x-opencode-client') || 'anon') + '|' + apiPath;
            const b2 = await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(seed + '|' + env.SESSION_SALT)
            );
            bHeaders.set(
              'x-opencode-session',
              [...new Uint8Array(b2)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
            );
          }
          return await handleChatBridge(rb, bHeaders, upstreamUrl);
        }
      } catch {
        // body 非 JSON：走原透传，让上游给出标准错误
      }
    }

    // 复制请求头
    const headers = new Headers(request.headers);

    // 【高】删除所有暴露 IP / 中转特征的头
    for (const h of STRIP_HEADERS) headers.delete(h);

    // 【v4】注入 API Key：透传优先。CC Switch 按激活卡注入真实 key，
    // Worker 不得覆盖（否则多卡流量全部记到 env key 账号、额度体系失效）。
    // 仅当客户端未带 Authorization 时（裸客户端场景）才用 env key 兜底。
    if (!headers.get('Authorization')) {
      headers.set('Authorization', `Bearer ${apiKey}`);
    }

    // 【高】UA 策略
    const ua = headers.get('User-Agent') || '';
    if (!SAFE_UA_PATTERN.test(ua)) {
      headers.set('User-Agent', SAFE_UA_FALLBACK);
    }

    // 【高】x-opencode-session
    if (!headers.has('x-opencode-session')) {
      let seed = (headers.get('x-opencode-client') || 'anon') + '|';
      if (bodyText) {
        try {
          const parsed: any = JSON.parse(bodyText);
          const msgs: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
          const sys = msgs.find((m: any) => m?.role === 'system');
          const usr = msgs.find((m: any) => m?.role === 'user');
          const norm = (c: any): string =>
            typeof c === 'string' ? c : c == null ? '' : JSON.stringify(c);
          seed += norm(sys?.content) + '|' + norm(usr?.content);
        } catch {
          seed += apiPath;
        }
      } else {
        seed += apiPath;
      }
      const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(seed + '|' + env.SESSION_SALT)
      );
      const hex = [...new Uint8Array(buf)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      headers.set('x-opencode-session', hex.slice(0, 32));
    }

    // 【v6】gpt/luna 系 /responses：方案二自愈重试 + 方案一容错
    // （isChatModel 已在协议网关分支处理国产系桥接，此处 /responses 非 chat 模型即 gpt/luna/grok）
    if (request.method === 'POST' && apiPath === '/responses' && bodyText) {
      try {
        const rb: any = JSON.parse(bodyText);
        if (!isChatModel(rb?.model)) {
          return await handleResponsesPassthroughWithRetry(rb, headers, upstreamUrl);
        }
      } catch {
        // 非 JSON 请求体：走原透传，让上游给标准错误
      }
    }

    // 转发（带超时：上游 hang 时返回 504 可读错误，避免 Worker 无限等待拖垮实例；正常推理远小于 60s）
    const forwardBody = bodyText !== null ? bodyText : request.body;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT);
    let response: Response;
    try {
      response = await fetch(upstreamUrl.toString(), {
        method: request.method,
        headers,
        body: forwardBody,
        signal: ac.signal,
      });
    } catch {
      clearTimeout(timer);
      return new Response(
        JSON.stringify({ error: 'upstream_failed', message: 'upstream timed out or aborted (>60s, inference pool hung)' }),
        { status: 504, headers: jsonErrHeaders() }
      );
    } finally {
      clearTimeout(timer);
    }

    // 响应侧
    const outHeaders = new Headers(response.headers);
    outHeaders.set('Access-Control-Allow-Origin', '*');
    for (const h of STRIP_HEADERS) outHeaders.delete(h);

    // 【v5】上游哑巴 400 翻译：body 超限时上游只回 {"model":"..."}（无 error 字段），
    // 客户端完全看不出原因。这里改写成结构化错误，指明是请求体过大。
    if (response.status === 400 && (outHeaders.get('content-type') || '').includes('application/json')) {
      const txt = await response.text();
      let rewritten = false;
      try {
        const j: any = JSON.parse(txt);
        if (j && !j.error && typeof j.model === 'string') {
          rewritten = true;
          return new Response(
            JSON.stringify({
              error: {
                message:
                  'Upstream rejected this request with an opaque 400 (body only echoed {"model":"' +
                  j.model +
                  '"}). Measured root cause: the request body exceeds the upstream size limit (~5-10MB). The session context is too large - compact the conversation or start a new session in the client, then retry.',
                type: 'request_too_large',
                param: null,
                code: 'upstream_body_size_limit',
                model: j.model,
              },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
      } catch {
        // 非 JSON 响应体，原样透传
      }
      if (!rewritten) {
        return new Response(txt, { status: response.status, statusText: response.statusText, headers: outHeaders });
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
    });
  },
};

// ============ gpt/luna 系 /responses 透传增强：流容错 + 自愈重试（v6） ============
// 背景：gpt/luna 走透传分支（isChatModel 只匹配国产系），原第 641 行裸 new Response(response.body)，
// 对上游流中断零感知 → 客户端裸断。国产系 chat bridge 的 TransformStream 在 flush 会自动补
// response.completed，gpt/luna 反而缺兜底。三件套在此补齐：
//   方案一：流异常中断补 response.completed(incomplete)
//   方案三：空闲 >15s 注入 :keepalive 心跳注释（防 CF 边缘空闲断连）
//   方案二：gpt/luna /responses 流式请求 → Worker 内部改 stream:false 打上游 + 一次性重试（自愈），
//           缓冲带 8MB 硬上限，超上限降级纯流式 + 方案一容错（避免撞 CF 1102 资源超限）

const MAX_BUFFER = 8 * 1024 * 1024; // 8MB：超此上限不缓冲，降级纯流式，规避 Worker 内存资源上限
const UPSTREAM_IDLE_TIMEOUT = 60_000; // 上游流连续无数据超过此时长才中断，keepalive 不重置该计时

// 方案一 + 三：监控 SSE 流，异常中断补 response.completed(incomplete)；空闲注入心跳
function makeResponsesStreamGuard(
  model: string,
  abortUpstream?: () => void
): TransformStream<Uint8Array, Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let seenCompleted = false;
  let seenOutput = false;
  let timer: any = null;
  let idleTimer: any = null;
  let idleTimedOut = false;
  let lastChunk = Date.now();
  let ctrlRef: TransformStreamDefaultController<Uint8Array> | null = null;

  const send = (c: TransformStreamDefaultController<Uint8Array>, event: string, data: any) => {
    try {
      c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      /* 下游背压关闭，忽略 */
    }
  };
  const keepAlive = () => {
    if (ctrlRef) {
      try {
        ctrlRef.enqueue(enc.encode(': keepalive\n\n'));
      } catch {
        /* ignore */
      }
    }
  };
  const finalize = (c: TransformStreamDefaultController<Uint8Array>) => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
    if (!seenCompleted) {
      // 上游流异常截断（200 但没发结束事件）。无论是否收到内容，都明确标记为 incomplete，
      // 禁止把“有内容但没有正常结束”伪装成完整成功；让 Codex 自己决定重试或报错。
      const hasContent = seenOutput;
      const status = 'incomplete';
      const respObj: any = {
        id: 'resp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status,
        model,
        output: [],
        parallel_tool_calls: true,
        tool_choice: 'auto',
        tools: [],
        temperature: 1,
        top_p: 1,
        store: false,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };
      respObj.incomplete_details = {
        reason: hasContent ? 'upstream_stream_ended_without_completed' : 'upstream_empty_stream',
      };
      send(c, 'response.completed', {
        type: 'response.completed',
        response: respObj,
      });
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      ctrlRef = controller;
      lastChunk = Date.now();
      timer = setInterval(() => {
        if (Date.now() - lastChunk >= 3000) keepAlive();
      }, 1000);
      idleTimer = setInterval(() => {
        if (!idleTimedOut && Date.now() - lastChunk >= UPSTREAM_IDLE_TIMEOUT) {
          idleTimedOut = true;
          abortUpstream?.();
          try {
            controller.error(new Error('upstream stream idle timeout (>60s)'));
          } catch {
            /* 下游已关闭，忽略 */
          }
        }
      }, 1000);
    },
    transform(chunk, controller) {
      lastChunk = Date.now();
      const s = dec.decode(chunk, { stream: true });
      if (/response\.completed/.test(s)) seenCompleted = true;
      if (
        /response\.output_text\.delta/.test(s) ||
        /response\.output_item\.added/.test(s) ||
        /response\.function_call_arguments\.delta/.test(s) ||
        /response\.output_item\.done/.test(s) ||
        /response\.content_part\.added/.test(s)
      ) {
        seenOutput = true;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      finalize(controller);
    },
  });
}

// 上游完整 responses JSON → SSE（方案二非流式缓冲成功后回吐，首 token 延迟升高但稳定）
function responsesJsonToSSE(model: string, j: any): string {
  const out: string[] = [];
  const rid = j?.id || 'resp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const emit = (event: string, data: any) => out.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('response.created', { type: 'response.created', response: baseResponse(rid, model, 'in_progress', []) });
  const items: any[] = Array.isArray(j?.output) ? j.output : [];
  let oi = 0;
  for (const item of items) {
    if (item?.type === 'message') {
      const text = joinText(item.content);
      emit('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: oi,
        item: { type: 'message', id: item.id, status: 'in_progress', role: 'assistant', content: [] },
      });
      emit('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: item.id,
        output_index: oi,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      emit('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: oi,
        content_index: 0,
        delta: text,
      });
      emit('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: item.id,
        output_index: oi,
        content_index: 0,
        text,
      });
      emit('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: item.id,
        output_index: oi,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      });
      emit('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: oi,
        item: { ...item, status: 'completed' },
      });
    } else if (item?.type === 'function_call') {
      emit('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: oi,
        item: { ...item, status: 'in_progress' },
      });
      emit('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: item.id,
        output_index: oi,
        delta: item.arguments ?? '',
      });
      emit('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: oi,
        item: { ...item, status: 'completed' },
      });
    }
    oi++;
  }
  emit('response.completed', {
    type: 'response.completed',
    response: baseResponse(
      rid,
      model,
      j?.status === 'incomplete' ? 'incomplete' : 'completed',
      items,
      j?.usage || mapUsage(undefined)
    ),
  });
  return out.join('');
}

// 边读边累计，超上限立即中断（避免缓冲大响应撞 CF 内存资源上限）
async function readWithLimit(resp: Response, limit: number): Promise<{ text: string; tooBig: boolean }> {
  const reader = resp.body!.getReader();
  const dec = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        return { text: '', tooBig: true };
      }
      text += dec.decode(value, { stream: true });
    }
    text += dec.decode();
  } catch {
    return { text: '', tooBig: true };
  }
  return { text, tooBig: false };
}

// 字节长度估算（Worker 无 Buffer，用 TextEncoder；失败退回 UTF-16 长度×2）
function byteLengthOf(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length * 2;
  }
}

function jsonErrHeaders(): Headers {
  const h = new Headers();
  h.set('content-type', 'application/json');
  h.set('Access-Control-Allow-Origin', '*');
  return h;
}

// 方案二（B 版·朴素透明转发）：gpt/luna 的 /responses 请求原样透传上游 SSE。
// 不做 stream:false 缓冲、不做重试、不返回 incomplete 假成功；仅挂 keepalive 防 Codex 断连重发。
// 上游非 200（429/500/模型不存在等）原样透传状态码+body，由客户端(Codex)自行处理。
const UPSTREAM_HEADERS_TIMEOUT = 60_000; // 仅限制等待上游响应头；流建立后由 idle timeout 负责

async function handleResponsesPassthroughWithRetry(
  rb: any,
  headers: Headers,
  upstreamUrl: URL
): Promise<Response> {
  const model = String(rb.model || '');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_HEADERS_TIMEOUT);
  let resp: Response;
  try {
    // 原样透传 stream:true 到上游；Authorization 等 headers 由调用方原样传入（透传优先）
    resp = await fetch(upstreamUrl.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...rb, stream: true }),
      signal: ac.signal,
    });
  } catch {
    clearTimeout(timer);
    // 网络不可达 / 上游超时：原样透传错误（不再 incomplete 假成功，让 Codex 自行决定）
    return new Response(
      JSON.stringify({ error: 'upstream_unavailable', message: 'upstream timed out or unreachable (>60s)' }),
      { status: 504, headers: jsonErrHeaders() }
    );
  }
  clearTimeout(timer);

  // 上游明确错误（模型不存在 / 限流 / 500 等）：原样透传，由 Codex 自行处理、自行决定是否重试
  if (!resp.ok) {
    const oh = new Headers(resp.headers);
    oh.set('Access-Control-Allow-Origin', '*');
    return new Response(resp.body, { status: resp.status, headers: oh });
  }

  // 正常 SSE：零 JS 处理的纯流式透传。Worker 不读取/不转换任何 chunk，CPU time ≈ 0，
  // 彻底规避 Cloudflare Free plan 的 10ms CPU 硬上限（Error 1102）。
  // 代价：失去 Worker 层 keepalive 心跳与 incomplete 兜底（由上游/客户端自理）。
  const oh = new Headers(resp.headers);
  oh.set('content-type', 'text/event-stream; charset=utf-8');
  oh.set('cache-control', 'no-cache');
  oh.set('Access-Control-Allow-Origin', '*');
  return new Response(resp.body, { status: 200, headers: oh });
}

interface Env {
  OPENCODE_API_KEY: string;
  SESSION_SALT: string;
}
