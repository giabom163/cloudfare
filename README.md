# opencode-go-proxy

Codex → CC Switch → Cloudflare Worker → OpenCode 网关 的中间层。

```
Codex (config.toml)
  ↓ http://127.0.0.1:15721/v1
CC Switch (本地路由 / 多卡 / 熔断 / usage)
  ↓ https://api.giabom.online/go/v1
Cloudflare Worker (本项目)
  ↓
OpenCode 网关 (opencode.ai/zen/go/v1)
  ↓
模型推理
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/01-演进史与故障分析.md](docs/01-演进史与故障分析.md) | v13 演进史、最近两天 4 个提交改了什么、故障分层与踩坑记录 |
| [docs/02-架构原理与服务器方案.md](docs/02-架构原理与服务器方案.md) | 四层架构、协议桥接原理、排查决策树、服务器方案 |

## 核心设计

**Worker 存在的唯一理由是协议桥接。** CC Switch 的 apiFormat 是卡级开关，无法按模型分流；而 OpenCode 上游要求 GPT/Luna 走 `/responses`、国产系走 `/chat/completions`。这层分流只能在 Worker 做。

```ts
const CHAT_MODEL_RE = /^(glm-|kimi-|deepseek-|mimo-|minimax-)/i;
```

**原生透传路径的纪律**（不重试、不缓冲、不假装成功）：

- 不重试
- 不缓冲成 `stream:false`
- 不返回假成功 `incomplete`
- 上游非 200 → 原样透传状态码和 body

**保活是刚需**：上游长时间无字节会让 Codex 判定 SSE 空闲断连 → Reconnecting → 重连重发整个大上下文 = input 重复计费。

## 已知限制

- **403 地区封锁无解**：CF 边缘按出口 IP 判定地区，代码层改不了，需换出口（见 docs/02 第五节）
- **上游推理池抖动**：`208 inference_failed`，2-3 秒快速失败，不计费，只能换模型
- **观测盲区**：CC Switch 本地日志看不到上游返回码，判定链路必须双端对照

## 开发

```bash
npm install
npm run dev        # wrangler dev
npm run typecheck  # tsc --noEmit
npm run deploy     # wrangler deploy
```

**部署前务必跑 `npm run typecheck`** —— esbuild 不会报 `const` TDZ 错误，tsc 会。
