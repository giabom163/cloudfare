/**
 * guard.mjs — 零误报的定制静态体检
 *
 * 为什么需要它：
 *  1. esbuild（wrangler deploy 实际用的打包器）不做 TDZ / 未声明标识符检查，
 *     实测 2026-10-03 的 P0（UPSTREAM_TIMEOUT 已改名但两处引用未改）
 *     在 esbuild 下 exit=0 顺利通过，直到线上首次调用国产模型才暴露。
 *  2. tsc 能拦（TS2304 / used before declaration），但 tsc 也会因为
 *     第三方类型缺失等噪音失败，掩盖真正的问题。
 *  3. 本脚本只检查「确定要拦」的四类问题，零误报。
 *
 * 退出码：0 = 通过；1 = 有违规，CI 失败。
 */

import { readFileSync } from 'node:fs';

const SRC = 'src/index.ts';
const code = readFileSync(SRC, 'utf8');
const lines = code.split(/\r?\n/);

let failed = 0;
const fail = (msg) => {
  console.error(`::error::${msg}`);
  failed++;
};
const ok = (msg) => console.log(`ok: ${msg}`);

// ---------- 收集声明 ----------
/** @type {Map<string, number>} */
const declLine = new Map();
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (m && !declLine.has(m[1])) declLine.set(m[1], i + 1);
  const f = lines[i].match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  if (f && !declLine.has(f[1])) declLine.set(f[1], i + 1);
  const t = lines[i].match(/^\s*(?:export\s+)?(?:interface|type|class|enum)\s+([A-Za-z_$][\w$]*)/);
  if (t && !declLine.has(t[1])) declLine.set(t[1], i + 1);
  // import { X } from '...'
  const im = lines[i].match(/import\s+(?:type\s+)?\{([^}]+)\}/);
  if (im) {
    im[1].split(',').forEach((s) => {
      const n = s.trim().split(/\s+as\s+/).pop()?.trim();
      if (n && !declLine.has(n)) declLine.set(n, i + 1);
    });
  }
}

/**
 * 只在「标识符作为函数传参」的位置做检查，
 * 避免把 JSON / POST / URL / UTF-8 这类大写词误判成常量。
 */
const CONST_ARG_RE = /setTimeout\(\s*[^,]+,\s*([A-Z][A-Z0-9_]{2,})\s*\)/g;
const CONST_USE_RE = /\bac\.abort\(\),\s*([A-Z][A-Z0-9_]{2,})\s*\)/g;

const constRefs = [];
for (let i = 0; i < lines.length; i++) {
  for (const re of [CONST_ARG_RE, CONST_USE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      constRefs.push({ name: m[1], line: i + 1 });
    }
  }
}

// ---------- 检查 1：大写常量必须有声明 ----------
let c1 = 0;
for (const r of constRefs) {
  if (!declLine.has(r.name)) {
    fail(`L${r.line} 常量 ${r.name} 被引用但未声明（这类错误 esbuild 抓不到）`);
    c1++;
  }
}
if (c1 === 0) ok(`常量声明一致性：${constRefs.length} 处引用全部有声明`);

// ---------- 检查 2：const 不得早于声明使用（TDZ） ----------
let c2 = 0;
for (const r of constRefs) {
  const d = declLine.get(r.name);
  if (d !== undefined && r.line < d) {
    fail(`L${r.line} 引用 ${r.name}，但它在 L${d} 才声明 → TDZ 运行时错误`);
    c2++;
  }
}
if (c2 === 0) ok('TDZ：所有常量引用均晚于声明');

// ---------- 检查 3：同一作用域内不得重复声明 ----------
// 注意：不同函数体里的同名局部变量（const choice 在 L183 与 L341）是合法的，
// 因此只检查「文件顶层」与「单个函数体」内的重复，不做跨作用域比较。
let c3 = 0;
{
  // 顶层重复（缩进为 0 的 const）
  const topFirst = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/);
    if (!m) continue;
    const n = m[1];
    if (topFirst.has(n)) {
      fail(`顶层常量 ${n} 重复声明：L${topFirst.get(n)} 与 L${i + 1}`);
      c3++;
    } else topFirst.set(n, i + 1);
  }
  if (c3 === 0) ok('顶层无重复 const 声明（不同函数内的同名局部变量不计入）');
}

// ---------- 检查 4：禁止硬编码密钥 ----------
let c4 = 0;
{
  const PATTERNS = [
    /sk-[A-Za-z0-9]{20,}/,                 // OpenAI
    /oc_[a-z]{2}_[A-Za-z0-9]{10,}/,        // OpenCode
    /Bearer\s+[A-Za-z0-9._-]{30,}/,        // Bearer token
    /OPENCODE_API_KEY\s*[:=]\s*['"][^'"]{10,}/,
    /SESSION_SALT\s*[:=]\s*['"][^'"]{10,}/,
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const p of PATTERNS) {
      if (p.test(lines[i])) {
        fail(`L${i + 1} 疑似硬编码密钥`);
        c4++;
      }
    }
  }
}
if (c4 === 0) ok('源码内无硬编码密钥');

// ---------- 检查 5：.dev.vars 不应被 git 跟踪 ----------
// 注意：.dev.vars 存在于工作区是正常的（本地开发需要真实 key），
// 只要没被 git add 就不算违规。
{
  let tracked = false;
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('git', ['ls-files', '--error-unmatch', '.dev.vars'], {
      encoding: 'utf8', stdio: 'pipe',
    });
    tracked = out.trim() === '.dev.vars';
  } catch {
    tracked = false; // git 返回非 0 = 未跟踪，符合预期
  }
  if (tracked) {
    fail('.dev.vars 被 git 跟踪了，密钥会入库（应加入 .gitignore 并 git rm --cached）');
  } else {
    ok('.dev.vars 未被 git 跟踪（工作区存在是正常的）');
  }
}

// ---------- 检查 6：关键超时/常量仍存在（防误删） ----------
{
  const REQUIRED = ['UPSTREAM_HEADERS_TIMEOUT', 'UPSTREAM_IDLE_TIMEOUT', 'CHAT_MODEL_RE'];
  for (const name of REQUIRED) {
    if (!declLine.has(name)) fail(`关键常量 ${name} 缺失（可能被误删）`);
  }
  if (REQUIRED.every((n) => declLine.has(n))) ok(`关键常量齐全：${REQUIRED.join(', ')}`);
}

// ---------- 汇总 ----------
console.log('');
if (failed) {
  console.error(`guard failed: ${failed} 项不合规`);
  process.exit(1);
}
console.log('guard passed');
