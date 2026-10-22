// 生成 llm.json:engine-ts 的 providers.ts / llm.ts / embeddings.ts(原模块现跑,连着真的 openai 与 @anthropic-ai/sdk)。
// 每个场景起一个进程内的假 HTTP 端点(127.0.0.1,端口随机),按脚本逐个请求回话:状态码、头、正文、晚多久回、回一半停住、
// 直接断开。记下端点看到的每一个请求(方法、路径、全部的头、正文原文)、SDK 退避睡了多久、每次请求的计时器设了多久、
// 每一次调用的结果或错(类名、原话、状态码)。C++ 测试(tests/tst_llm.cpp)用同一份脚本起 QTcpServer 回放、逐项比。
//
// 只连本机:fetch 被包了一层,目标不是 127.0.0.1 / localhost / ::1 就当场抛(SDK 的默认地址 api.anthropic.com 也走不出去)。
// 确定性:Math.random 钉成 0.5(SDK 退避的抖动 = 1 − 0.5 × 0.25);每个场景一个新端点、回话一律带 connection: close(不复用连接);
// 端口写成 {PORT} / {DEAD};时延场景两边留足余量(超时 0.3 秒对端点晚 1.5 秒以上)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_llm.mjs <编过的 engine-ts 目录>
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');

// ---------------------------------------------------------------- 只许本机
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!LOOPBACK.has(url.hostname)) throw new Error(`gen_llm 拒绝连接非本机地址:${url.host}`);
  return realFetch(input, init);
};
// 继承来的环境一个都不要:SDK 自己读 ANTHROPIC_* / OPENAI_*(地址、令牌、自定义头、组织、Key),带着它们可能把假 Key 发去远端。
// 每个场景开始时再清一遍,场景需要的变量由场景自己设(都指向本机端点)
const scrubEnv = () => { for (const k of Object.keys(process.env)) if (/^(ANTHROPIC|OPENAI)_/.test(k)) delete process.env[k]; };
scrubEnv();

// ---------------------------------------------------------------- 钉住随机数,记下 SDK 的睡眠与计时器
Math.random = () => 0.5;
let sleeps = [], timers = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function (fn, ms, ...rest) {
  const stack = new Error().stack ?? '';
  if (stack.includes('/internal/utils/sleep.mjs')) { sleeps.push(ms); if (ms > 5000) return realSetTimeout(fn, 1, ...rest); }  // 记下原值;太长的(Retry-After 的上限边界)只缩短真等的那一觉
  else if (/at (async )?(timedFetch|.*fetchWithTimeout)/.test(stack)) timers.push(ms);
  return realSetTimeout(fn, ms, ...rest);
};

const P = await import(pathToFileURL(join(engine, 'dist/src/providers.js')).href);
const L = await import(pathToFileURL(join(engine, 'dist/src/llm.js')).href);
const E = await import(pathToFileURL(join(engine, 'dist/src/embeddings.js')).href);
const J = await import(pathToFileURL(join(engine, 'dist/src/pyjson.js')).href);
const S = await import(pathToFileURL(join(engine, 'dist/src/secrets.js')).href);
const C = await import(pathToFileURL(join(engine, 'dist/src/config.js')).href);

const enc = (o) => JSON.parse(JSON.stringify(o === undefined ? '__undefined__' : o, (k, v) => {
  if (v === undefined) return '__undefined__';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '__NaN__';
    if (v === Infinity) return '__Inf__';
    if (v === -Infinity) return '__-Inf__';
    if (Object.is(v, -0)) return '__neg0__';
  }
  return v;
}));
const errOf = (e) => ({ name: e?.constructor?.name ?? typeof e, message: String(e?.message ?? e), status: enc(e?.status) });
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };

// ---------------------------------------------------------------- 假端点
// 一步脚本:{ status, headers, body, delayMs }        body 是对象时按 JSON 写、默认 content-type: application/json
//          { drop: true, delayMs }                     收完请求就断开(一个字节都不回)
//          { status, headers, partial, stallMs, rest } 先回头与 partial,停 stallMs 再写 rest 并结束;rest 省略 = 直接断开
// 脚本走完了还来请求:回 599(记下来,C++ 那边同样回 599)
function startServer(script) {
  const seen = [];
  let i = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const headers = [];
      for (let k = 0; k < req.rawHeaders.length; k += 2) headers.push([req.rawHeaders[k].toLowerCase(), req.rawHeaders[k + 1]]);
      headers.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      seen.push({ method: req.method, path: req.url, headers, body: Buffer.concat(chunks).toString('utf8') });
      const step0 = script[i++] ?? { status: 599, body: { error: 'script exhausted' } };
      const step = JSON.parse(JSON.stringify(step0).replace(/\{PORT\}/g, String(server.address().port)));  // Location 之类里写 {PORT} = 本场景端点
      const act = () => {
        if (step.drop) { req.socket.destroy(); return; }
        let body = step.body ?? '';
        const h = { connection: 'close', ...(step.headers ?? {}) };
        if (typeof body === 'object') { body = JSON.stringify(body); if (!Object.keys(h).some((x) => x.toLowerCase() === 'content-type')) h['content-type'] = 'application/json'; }
        if (step.partial !== undefined) {
          res.writeHead(step.status, h);
          res.write(step.partial);
          realSetTimeout(() => {
            if (step.rest === undefined) req.socket.destroy();
            else res.end(step.rest);
          }, step.stallMs ?? 0);
          return;
        }
        res.writeHead(step.status, { ...h, 'content-length': Buffer.byteLength(body) });
        res.end(body);
      };
      if (step.delayMs) realSetTimeout(act, step.delayMs); else act();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}
async function deadPort() {
  const { server, port } = await startServer([]);
  await new Promise((r) => server.close(r));
  return port;
}

// ---------------------------------------------------------------- 输入
const BUNDLES = {
  b1: {
    version: 'v1.8.0', system_text: '你是交易指令解析器。只输出 JSON。', user_template: '{{USER_INSTRUCTION}}',
    fewshot: [
      { name: 'buy', user: '买 AAPL 100 股 limit 230', assistant_text: '{"action": "PLACE", "price": 230.0, "qty": 100}' },
      { name: 'reject', user: '随便买点', assistant_text: '{"action": "REJECT", "code": "AMBIGUOUS", "ratio": 0.5}' },
    ],
  },
  b0: { version: 'v1.0.0', system_text: 'sys v1 "quoted" \\ back', user_template: '', fewshot: [] },
};
const bundleOf = (id) => {
  const b = BUNDLES[id];
  return { ...b, fewshot: b.fewshot.map((p) => { const j = J.parseJson(p.assistant_text); return { name: p.name, user: p.user, assistant: J.toPlain(j), assistantJ: j }; }) };
};
const BASE_CFG = {
  anthropic: { provider: 'anthropic', model: 'claude-opus-5', effort: 'medium', temperature: null, base_url: '', max_tokens: 8000, timeout_s: 5, keychain_service: 'dafri-llm-api-key', keychain_account: 'anthropic' },
  openai_compatible: { provider: 'openai_compatible', model: 'deepseek-chat', effort: 'medium', temperature: null, base_url: '{BASE}', max_tokens: 8000, timeout_s: 5, keychain_service: 'dafri-llm-api-key', keychain_account: 'openai_compatible' },
};
const SCHEMA_SMALL = { type: 'object', properties: { picks: { type: 'array', items: { type: 'string' } }, n: { type: 'number' } }, required: ['picks'], additionalProperties: false };

const KEY = 'sk-test-0000-fake';
const fakeSecrets = (value) => ({ exists: async () => value !== null, read: async () => value, write: async () => {} });

/** 一次调用 → {ok} 或 {error} */
async function call(c, base) {
  const fill = (s) => (typeof s === 'string' ? s.split('{BASE}').join(base) : s);
  if (c.op === 'embed') {
    try {
      const em = new E.OllamaEmbedder(fill(c.baseUrl), c.model, c.keepAlive);
      return { ok: enc(await em.embed(c.texts, c.timeoutMs)) };
    } catch (e) { return { error: errOf(e) }; }
  }
  const provider = c.provider ?? 'openai_compatible';
  const cfg = { ...BASE_CFG[provider], ...(c.config ?? {}) };
  for (const k of Object.keys(cfg)) cfg[k] = fill(cfg[k]);
  if (c.secret !== undefined) S.useSecretBackend(fakeSecrets(c.secret));
  try {
    let parser = L.buildParser(cfg, c.apiKey === undefined ? KEY : c.apiKey);
    if (c.accounts) parser = P.guardAccountIds(parser, () => c.accounts);
    if (c.op === 'parse' || c.op === 'payload') {
      const r = await parser.parse(bundleOf(c.bundle), c.user);
      const ok = { text: r.text, model: r.model, prompt_version: r.prompt_version, prompt_fingerprint: r.prompt_fingerprint, usage: r.usage, structured_mode: r.structured_mode };
      if (c.op === 'payload') { try { ok.payload = { ok: enc(r.payload()) }; } catch (e) { ok.payload = { error: errOf(e) }; } }
      return { ok: enc(ok) };
    }
    if (c.op === 'completeJson') return { ok: enc(await parser.completeJson(c.system, c.user, c.schema)) };
    if (c.op === 'test') {
      const { latency_ms, ...rest } = await parser.test(c.testKey);
      return { ok: enc({ ...rest, latency_is_number: typeof latency_ms === 'number' }) };
    }
    throw new Error(`unknown op ${c.op}`);
  } catch (e) {
    return { error: errOf(e) };
  } finally {
    if (c.secret !== undefined) S.useSecretBackend(null);
  }
}

const scenarios = [];
/** 一个场景:新端点、设好环境变量、按次序跑 calls,收齐记录 */
async function scenario(name, spec) {
  const { server, seen, port } = await startServer(spec.script ?? []);
  const dead = spec.dead ? await deadPort() : null;
  const decoy = spec.decoy ? await startServer([]) : null;  // 第二个端点:带 Key 的请求要是到了这里,就是连错了地方
  const host = `127.0.0.1:${spec.dead ? dead : port}`;
  const dhost = decoy ? `127.0.0.1:${decoy.port}` : '';
  const sub = (x) => x.split('{HOST}').join(host).split('{DECOY}').join(dhost);
  const base = spec.baseOverride ?? `http://${host}/v1`;
  const env = { ...(spec.env ?? {}) };
  if (!('ANTHROPIC_BASE_URL' in env)) env.ANTHROPIC_BASE_URL = `http://${host}`;
  scrubEnv();
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = sub(v); }
  sleeps = []; timers = [];
  const results = [];
  for (const c of spec.calls) results.push(await call(c, sub(base)));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  if (decoy) { decoy.server.closeAllConnections?.(); await new Promise((r) => decoy.server.close(r)); }
  let rec = JSON.stringify({ name, ...spec, results, requests: seen, ...(decoy ? { decoyRequests: decoy.seen } : {}), sleeps, timers });
  // 端口在记录里一律写成占位符:地址里的 127.0.0.1:端口、编进查询里的 127.0.0.1%3A端口、重定向里的 localhost:端口
  const maskPort = (r, p, tag) => r.split(`127.0.0.1:${p}`).join(`127.0.0.1:{${tag}}`).split(`127.0.0.1%3A${p}`).join(`127.0.0.1%3A{${tag}}`).split(`localhost:${p}`).join(`localhost:{${tag}}`);
  rec = maskPort(rec, port, 'PORT');
  if (decoy) rec = maskPort(rec, decoy.port, 'DECOY');
  if (dead) rec = rec.split(`127.0.0.1:${dead}`).join('127.0.0.1:{DEAD}');
  scenarios.push(JSON.parse(rec));
}

// ---------------------------------------------------------------- 回包
const aMsg = (over = {}) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-20260101', content: [{ type: 'text', text: '{"action":"PLACE"}' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: null, server_tool_use: { x: 1 } }, ...over });
const oMsg = (content, over = {}) => ({ id: 'c1', object: 'chat.completion', model: 'deepseek-chat-v3', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 7, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 20 }, ...over });
const aErr = (type, message) => ({ type: 'error', error: { type, message } });
const oErr = (message, code = null) => ({ error: { message, type: 'invalid_request_error', param: null, code } });
const R = (status, body, headers) => ({ status, body, ...(headers ? { headers } : {}) });
const A = (op, over = {}) => ({ provider: 'anthropic', op, bundle: 'b1', user: '买 SPX 7500 call 1 张', system: '只输出 JSON', schema: SCHEMA_SMALL, ...over });
const O = (op, over = {}) => ({ provider: 'openai_compatible', op, bundle: 'b1', user: '买 SPX 7500 call 1 张', system: '只输出 JSON', schema: SCHEMA_SMALL, ...over });

// ---- Anthropic:请求的样子、回包的各种形状
await scenario('a_parse_ok', { script: [R(200, aMsg({ content: [{ type: 'thinking', thinking: 'x', text: 'NO' }, { type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] }))], calls: [A('payload')] });
await scenario('a_parse_b0_haiku_temp', { script: [R(200, aMsg({ model: undefined, usage: undefined }))], calls: [A('parse', { bundle: 'b0', config: { model: 'claude-haiku-4-5', temperature: 0.2, max_tokens: 1234, effort: 'low' } })] });
await scenario('a_parse_opus_temp_dropped', { script: [R(200, aMsg({ usage: null }))], calls: [A('parse', { config: { temperature: 0.7 } })] });
await scenario('a_refusal', { script: [R(200, aMsg({ stop_reason: 'refusal' }))], calls: [A('parse')] });
await scenario('a_max_tokens', { script: [R(200, aMsg({ stop_reason: 'max_tokens' })), R(200, aMsg({ stop_reason: 'max_tokens' }))], calls: [A('parse'), A('completeJson')] });
await scenario('a_empty_text', { script: [R(200, aMsg({ content: [{ type: 'text', text: '  \n ' }] })), R(200, aMsg({ content: [] }))], calls: [A('parse'), A('completeJson')] });
await scenario('a_odd_text_blocks', { script: [R(200, aMsg({ content: [{ type: 'text', text: 7 }, { type: 'text' }, null, { type: 'text', text: null }, { type: 'text', text: [1, null, 'x'] }, { type: 'text', text: { o: 1 } }] }))], calls: [A('parse')] });
await scenario('a_content_not_array', { script: [R(200, aMsg({ content: 'oops' }))], calls: [A('parse')] });
await scenario('a_payload_bad_json', { script: [R(200, aMsg({ content: [{ type: 'text', text: '{"a":1,}' }] }))], calls: [A('payload')] });
await scenario('a_complete_json_ok', { script: [R(200, aMsg({ content: [{ type: 'text', text: '{"picks":["NVDA"],"n":1e400}' }] }))], calls: [A('completeJson')] });
await scenario('a_complete_json_bad', { script: [R(200, aMsg({ content: [{ type: 'text', text: 'not json' }] }))], calls: [A('completeJson')] });
await scenario('a_test_ok', { script: [R(200, aMsg({ content: [{ type: 'text', text: 'x'.repeat(250) }] }))], calls: [A('test', { testKey: 'sk-test-other-key' })] });
await scenario('a_auth_token_env', { env: { ANTHROPIC_AUTH_TOKEN: '  tok-test-123  ', ANTHROPIC_CUSTOM_HEADERS: 'X-Extra: one\nbad line\n X-Two : 2 \nContent-Type: text/plain' }, script: [R(200, aMsg())], calls: [A('parse')] });
await scenario('a_base_url_trailing_slash', { env: { ANTHROPIC_BASE_URL: 'http://{HOST}/proxy/' }, script: [R(200, aMsg())], calls: [A('parse')] });
await scenario('a_non_json_ok', { script: [R(200, 'plain text', { 'content-type': 'text/plain' })], calls: [A('parse')] });
await scenario('a_malformed_json', { script: [R(200, '{"type":"message",', { 'content-type': 'application/json' }), R(200, '', { 'content-type': 'application/json; charset=utf-8' })], calls: [A('parse'), A('completeJson')] });
await scenario('a_204', { script: [R(204, '')], calls: [A('parse')] });
await scenario('a_content_length_zero', { script: [R(200, '', { 'content-type': 'application/json' })], calls: [A('parse')] });
await scenario('a_vnd_json', { script: [R(200, JSON.stringify(aMsg()), { 'content-type': 'application/vnd.api+json' })], calls: [A('parse')] });
// 错误码:401 / 403 / 404 / 400 / 422 / 409 / 418
await scenario('a_401', { script: [R(401, aErr('authentication_error', 'invalid x-api-key')), R(401, aErr('authentication_error', 'invalid x-api-key')), R(401, aErr('authentication_error', 'bad'))], calls: [A('parse'), A('completeJson'), A('test')] });
await scenario('a_403_404', { script: [R(403, aErr('permission_error', 'nope')), R(404, 'Not Found', { 'content-type': 'text/html' }), R(404, aErr('not_found_error', 'model: claude-x'))], calls: [A('completeJson'), A('parse'), A('test')] });
await scenario('a_4xx_shapes', { script: [R(400, { message: 'top level message' }), R(422, { message: { nested: true } }), R(418, ''), R(400, '"just a string"', { 'content-type': 'application/json' }), R(400, 'null', { 'content-type': 'application/json' })], calls: [A('parse'), A('parse'), A('completeJson'), A('parse'), A('parse')] });
// 重试:429 带 retry-after-ms / retry-after;500 / 529 默认退避;x-should-retry
await scenario('a_429_then_ok', { script: [R(429, aErr('rate_limit_error', 'slow down'), { 'retry-after-ms': '5' }), R(200, aMsg())], calls: [A('parse')] });
await scenario('a_429_exhausted', { script: [R(429, aErr('rate_limit_error', 'r1'), { 'retry-after': '0.01' }), R(429, aErr('rate_limit_error', 'r2'), { 'retry-after-ms': '0', 'retry-after': '0.02' }), R(429, aErr('rate_limit_error', 'r3'))], calls: [A('parse')] });
await scenario('a_500_529_exhausted', { script: [R(500, aErr('api_error', 'boom')), R(529, aErr('overloaded_error', 'busy'), { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }), R(503, 'upstream down', { 'content-type': 'text/plain' })], calls: [A('completeJson')] });
await scenario('a_retry_after_garbage', { script: [R(408, '', { 'retry-after': 'soon', 'retry-after-ms': 'x' }), R(409, aErr('conflict', 'c'), { 'retry-after-ms': '-5' }), R(200, aMsg())], calls: [A('parse')] });
await scenario('a_should_retry_header', { script: [R(500, aErr('api_error', 'no'), { 'x-should-retry': 'false' }), R(400, aErr('invalid_request_error', 'retry me'), { 'x-should-retry': 'true', 'retry-after-ms': '1' }), R(200, aMsg())], calls: [A('parse'), A('parse')] });
// 连不上、断开、超时
await scenario('a_refused', { dead: true, calls: [A('parse'), A('completeJson')] });
await scenario('a_drop_then_ok', { script: [{ drop: true }, R(200, aMsg())], calls: [A('parse')] });
await scenario('a_drop_exhausted', { script: [{ drop: true }, { drop: true }, { drop: true }], calls: [A('test')] });
await scenario('a_timeout_headers', { script: [{ ...R(200, aMsg()), delayMs: 1500 }, { ...R(200, aMsg()), delayMs: 1500 }, R(200, aMsg())], calls: [A('parse', { config: { timeout_s: 0.3 } })] });
await scenario('a_timeout_exhausted', { script: [{ ...R(200, aMsg()), delayMs: 1500 }, { ...R(200, aMsg()), delayMs: 1500 }, { ...R(200, aMsg()), delayMs: 1500 }], calls: [A('completeJson', { config: { timeout_s: 0.3 } })] });
await scenario('a_body_stall_no_timeout', { script: [{ status: 200, headers: { 'content-type': 'application/json' }, partial: '{"type":"message",', stallMs: 900, rest: '"content":[{"type":"text","text":"{}"}],"stop_reason":"end_turn"}' }], calls: [A('parse', { config: { timeout_s: 0.3 } })] });
await scenario('a_body_truncated', { script: [{ status: 200, headers: { 'content-type': 'application/json', 'content-length': '500' }, partial: '{"type":"mess', stallMs: 50 }], calls: [A('parse')] });
await scenario('a_timeout_not_integer', { calls: [A('parse', { config: { timeout_s: 1.005 } }), A('test', { config: { timeout_s: 0.0005 } }), A('completeJson', { config: { timeout_s: -1 } })] });
// Key:显式给的优先;没给去凭证库;凭证库没有
await scenario('a_key_from_store', { script: [R(200, aMsg())], calls: [A('parse', { apiKey: null, secret: 'sk-test-from-store' })] });
await scenario('a_key_missing', { calls: [A('parse', { apiKey: '', secret: null }), O('completeJson', { apiKey: null, secret: null })] });
// 账号守卫
await scenario('a_guard', {
  script: [R(200, aMsg()), R(200, aMsg({ content: [{ type: 'text', text: '{}' }] }))],
  calls: [
    A('parse', { user: '把 U7654321 的仓位平掉', accounts: [{ alias: '主账户', account_id: 'U7654321' }] }),
    A('completeJson', { system: 'sys U7654321', accounts: [{ alias: '主账户', account_id: 'U7654321' }] }),
    A('parse', { user: 'DU0000000 与 U000 与 12345', accounts: [{ alias: '占位', account_id: 'DU0000000' }, { alias: '短', account_id: 'U12' }, { alias: '零', account_id: '0000' }] }),
    A('completeJson', { user: 'x', accounts: [{ alias: '数', account_id: 12345 }] }),
    A('test', { accounts: [{ alias: '主账户', account_id: 'U7654321' }], testKey: 'U7654321' }),
  ],
});

// Retry-After 上限的边界:Anthropic 认到 2^31−1 毫秒(含),OpenAI 认到 60000 毫秒(含);再大一毫秒就退回默认退避
await scenario('a_retry_after_cap_inclusive', { script: [R(429, aErr('rate_limit_error', 'c'), { 'retry-after-ms': '2147483647' }), R(200, aMsg())], calls: [A('parse')] });
await scenario('a_retry_after_cap_exceeded', { script: [R(429, aErr('rate_limit_error', 'c'), { 'retry-after-ms': '2147483648' }), R(200, aMsg())], calls: [A('parse')] });
await scenario('a_retry_after_seconds_cap', { script: [R(429, aErr('rate_limit_error', 'c'), { 'retry-after': '2147483.647' }), R(429, aErr('rate_limit_error', 'c'), { 'retry-after': '2147483.648' }), R(200, aMsg())], calls: [A('parse')] });
await scenario('o_retry_after_cap_inclusive', { script: [R(429, oErr('c'), { 'retry-after-ms': '60000' }), R(200, oMsg('{}'))], calls: [O('parse')] });
await scenario('o_retry_after_cap_exceeded', { script: [R(429, oErr('c'), { 'retry-after-ms': '60001' }), R(200, oMsg('{}'))], calls: [O('parse')] });

// ---- OpenAI 兼容
await scenario('o_parse_ok', { script: [R(200, oMsg('```json\n{"action":"PLACE"}\n```'))], calls: [O('payload')] });
await scenario('o_parse_temp_b0', { script: [R(200, oMsg('  {"x": 1}  ', { model: undefined, usage: { prompt_tokens: 1 } }))], calls: [O('parse', { bundle: 'b0', config: { temperature: 0.35, max_tokens: 2048, model: 'qwen-max' } })] });
await scenario('o_fallback_and_memory', {
  script: [R(400, oErr("This response_format type is unavailable now")), R(200, oMsg('{"a":1}')), R(200, oMsg('{"a":2}')), R(400, oErr('still no')), R(200, oMsg('{"ok":true}')), R(200, oMsg('{"picks":[]}'))],
  calls: [O('parse'), O('parse'), O('test'), O('completeJson')],
});
await scenario('o_test_schema_ok_clears', { script: [R(400, oErr('no schema')), R(200, oMsg('{"picks":[]}')), R(200, oMsg('{"ok":true}', { usage: 'none' })), R(200, oMsg('{"picks":["A"]}'))], calls: [O('completeJson'), O('test'), O('completeJson')] });
await scenario('o_finish_reasons', {
  script: [R(200, oMsg('x', { choices: [{ message: { content: '{}' }, finish_reason: 'length' }] })), R(200, oMsg('x', { choices: [{ message: { content: '{}' }, finish_reason: 'content_filter' }] })), R(200, oMsg('   ')), R(200, oMsg('x', { choices: [{ message: { content: '{}' }, finish_reason: 'length' }] })), R(200, oMsg('x', { choices: [{ message: { content: '{}' }, finish_reason: 'content_filter' }] }))],
  calls: [O('parse'), O('parse'), O('parse'), O('completeJson'), O('completeJson')],
});
await scenario('o_odd_shapes', {
  script: [R(200, { choices: 'str' }), R(200, { choices: [{ message: 'hello' }] }), R(200, { choices: { 0: { message: { content: [1, 2] } } } }), R(200, [1, 2]), R(200, { choices: [{ message: { content: { a: 1 } } }], model: 7, usage: [1] }), R(200, oMsg('```\n{"picks":["X"]}```'))],
  calls: [O('parse'), O('parse'), O('parse'), O('parse'), O('parse'), O('completeJson')],
});
await scenario('o_complete_json_bad', { script: [R(200, oMsg('{"picks": [}')), R(200, oMsg('```json'))], calls: [O('completeJson'), O('completeJson')] });
await scenario('o_empty_and_null_body', { script: [R(200, '', { 'content-type': 'application/json' }), R(200, 'null', { 'content-type': 'application/json' }), R(204, ''), R(200, 'hi', { 'content-type': 'Text/Plain' }), R(200, JSON.stringify(oMsg('{}')), { 'content-type': 'Application/JSON; charset=utf-8' })], calls: [O('parse'), O('parse'), O('parse'), O('parse'), O('parse')] });
await scenario('o_malformed_json', { script: [R(200, '{"choices": [', { 'content-type': 'application/json' }), R(200, '{"choices": [', { 'content-type': 'application/json' }), R(200, oMsg('{"ok":true}'))], calls: [O('parse'), O('test')] });
await scenario('o_errors_status', {
  script: [R(401, oErr('Incorrect API key provided: sk-test-****')), R(403, { message: 'top level' }), R(404, 'model not found', { 'content-type': 'text/plain' }), R(422, '"str"', { 'content-type': 'application/json' }), R(418, ''), R(401, oErr('bad key'))],
  calls: [O('parse'), O('parse'), O('parse'), O('parse'), O('parse'), O('test')],
});
await scenario('o_test_friendly', { script: [R(404, oErr('The model `x` does not exist')), R(403, oErr('forbidden')), R(418, oErr('teapot'))], calls: [O('test'), O('test'), O('test')] });
await scenario('o_400_long_detail', { script: [R(400, oErr('长'.repeat(500))), R(200, oMsg('{}'))], calls: [O('parse')] });
await scenario('o_429_retry_then_ok', { script: [R(429, oErr('rate'), { 'retry-after-ms': '0' }), R(200, oMsg('{"a":1}'))], calls: [O('parse')] });
await scenario('o_500_exhausted', { script: [R(500, oErr('boom')), R(502, 'bad gateway', { 'content-type': 'text/html', 'retry-after': '61' }), R(503, oErr('down'), { 'retry-after-ms': '60001' })], calls: [O('parse')] });
await scenario('o_500_test_friendly', { script: [R(500, oErr('a'), { 'retry-after-ms': '1' }), R(500, oErr('b'), { 'retry-after-ms': '1' }), R(500, oErr('c'))], calls: [O('test')] });
await scenario('o_retry_after_variants', { script: [R(408, '', { 'retry-after': '0' }), R(409, oErr('lock'), { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }), R(200, oMsg('{}'))], calls: [O('parse')] });
await scenario('o_should_retry_header', { script: [R(503, oErr('no'), { 'x-should-retry': 'false' }), R(400, oErr('yes'), { 'x-should-retry': 'true', 'retry-after-ms': '1' }), R(200, oMsg('{}'))], calls: [O('parse'), O('parse')] });
await scenario('o_refused', { dead: true, calls: [O('parse'), O('test')] });
await scenario('o_refused_port_like_400', { dead: true, baseOverride: 'http://{HOST}/v400/response_format', calls: [O('parse')] });
await scenario('o_drop', { script: [{ drop: true }, { drop: true }, { drop: true }], calls: [O('parse')] });
await scenario('o_timeout_headers', { script: [{ ...R(200, oMsg('{}')), delayMs: 1500 }, { ...R(200, oMsg('{}')), delayMs: 1500 }, { ...R(200, oMsg('{}')), delayMs: 1500 }, { ...R(200, oMsg('{}')), delayMs: 1500 }, { ...R(200, oMsg('{}')), delayMs: 1500 }, { ...R(200, oMsg('{}')), delayMs: 1500 }], calls: [O('parse', { config: { timeout_s: 0.3 } }), O('test', { config: { timeout_s: 0.3 } })] });
await scenario('o_body_timeout_retry', {
  script: [{ status: 200, headers: { 'content-type': 'application/json' }, partial: '{"choices":', stallMs: 1500, rest: '[]}' }, R(200, oMsg('{"late":1}'))],
  calls: [O('parse', { config: { timeout_s: 0.4 } })],
});
await scenario('o_body_timeout_exhausted', {
  script: [0, 1, 2].map(() => ({ status: 200, headers: { 'content-type': 'application/json' }, partial: '{"choices":', stallMs: 1500, rest: '[]}' })),
  calls: [O('parse', { config: { timeout_s: 0.4 } })],
});
await scenario('o_error_body_stall', { script: [{ status: 401, headers: { 'content-type': 'application/json' }, partial: '{"error":{"message":', stallMs: 900, rest: '"slow"}}' }], calls: [O('parse', { config: { timeout_s: 0.3 } })] });
await scenario('o_body_truncated', { script: [{ status: 200, headers: { 'content-type': 'application/json', 'content-length': '400' }, partial: '{"choi', stallMs: 50 }], calls: [O('parse')] });
await scenario('o_env_org_project', { env: { OPENAI_ORG_ID: ' org-test ', OPENAI_PROJECT_ID: 'proj-test', OPENAI_BASE_URL: 'http://{HOST}/ignored', OPENAI_CUSTOM_HEADERS: 'User-Agent: from-env\nX-Custom: c' }, script: [R(200, oMsg('{}'))], calls: [O('parse')] });
await scenario('o_bad_base_url', { calls: [O('parse', { config: { base_url: 'http://example.com/v1' } }), O('parse', { config: { base_url: 'ftp://127.0.0.1' } }), O('parse', { config: { base_url: '  ' } }), O('parse', { config: { provider: 'gemini' } })] });
await scenario('o_guard', { script: [R(200, oMsg('{}'))], calls: [O('parse', { user: '账号 U9999999 买', accounts: [{ alias: 'B', account_id: 'U9999999' }] }), O('parse', { user: 'ok', accounts: [{ alias: 'B', account_id: 'U9999999' }] })] });

// ---- 本机嵌入
const EMB = (texts, over = {}) => ({ op: 'embed', baseUrl: '{BASE}', model: 'qwen3-embedding:8b-q8_0', keepAlive: '5m', texts, timeoutMs: 2000, ...over });
await scenario('e_ok', { baseOverride: 'http://{HOST}//', script: [R(200, { embeddings: [[0.1, -2, 3e-7], [1, 'x', null]] })], calls: [EMB(['a', '中文'], { keepAlive: -1 })] });
await scenario('e_empty_input', { calls: [EMB([])] });
await scenario('e_errors', {
  baseOverride: 'http://{HOST}',
  script: [R(500, { error: 'model not loaded' }), R(500, { error: { x: 1 } }), R(404, 'not found', { 'content-type': 'text/plain' }), R(200, { embeddings: 'no' }), R(200, { embeddings: [[1]] }), R(200, { embeddings: [[1], []] }), R(200, 'null'), R(200, '{"embeddings": [[1],', { 'content-type': 'application/json' }), R(200, { embeddings: [[1], 5] })],
  calls: [EMB(['a']), EMB(['a']), EMB(['a']), EMB(['a']), EMB(['a', 'b']), EMB(['a', 'b']), EMB(['a']), EMB(['a']), EMB(['a', 'b'])],
});
await scenario('e_refused', { dead: true, baseOverride: 'http://{HOST}', calls: [EMB(['a'])] });
await scenario('e_timeout', { baseOverride: 'http://{HOST}', script: [{ ...R(200, { embeddings: [[1]] }), delayMs: 1500 }, { status: 200, headers: { 'content-type': 'application/json' }, partial: '{"embeddings":', stallMs: 1500, rest: '[[1]]}' }], calls: [EMB(['a'], { timeoutMs: 300 }), EMB(['a'], { timeoutMs: 300 })] });
await scenario('e_drop', { baseOverride: 'http://{HOST}', script: [{ drop: true }], calls: [EMB(['a'])] });
await scenario('e_bad_url', { calls: [EMB(['a'], { baseUrl: 'http://10.0.0.1:11434' }), EMB(['a'], { baseUrl: 'not a url' })] });

// ---- 补的场景(变异检验里活下来的那几处)
await scenario('a_mixed_case_json_type', { script: [R(200, JSON.stringify(aMsg()), { 'content-type': 'Application/JSON' })], calls: [A('parse')] });
await scenario('a_empty_chunked_json', { script: [{ status: 200, headers: { 'content-type': 'application/json' }, partial: '', stallMs: 0, rest: '' }], calls: [A('parse')] });
await scenario('a_retry_after_ms_zero_only', { script: [R(429, aErr('rate_limit_error', 'z'), { 'retry-after-ms': '0' }), R(200, aMsg())], calls: [A('parse')] });
await scenario('a_timeout_header_rounding', { script: [R(200, aMsg())], calls: [A('parse', { config: { timeout_s: 0.6 } })] });
await scenario('a_timeout_minus_one', { calls: [A('parse', { config: { timeout_s: -0.001 } })] });
await scenario('a_error_body_truncated', { script: [{ status: 401, headers: { 'content-type': 'application/json', 'content-length': '500' }, partial: '{"type":"err', stallMs: 50 }], calls: [A('parse')] });
await scenario('a_key_empty_in_store', { calls: [A('parse', { apiKey: null, secret: '' })] });
await scenario('a_guard_four_chars', { calls: [A('parse', { user: '账户 U123 买', accounts: [{ alias: '四位', account_id: 'U123' }] })] });
await scenario('o_array_error_body', { script: [R(401, [1, 2])], calls: [O('parse')] });
await scenario('o_retry_after_ms_zero_and_seconds', { script: [R(429, oErr('r'), { 'retry-after-ms': '0', 'retry-after': '0.03' }), R(200, oMsg('{}'))], calls: [O('parse')] });
await scenario('o_empty_model_and_long_sample', { script: [R(200, oMsg('x'.repeat(250), { model: '' }))], calls: [O('test')] });
await scenario('o_syntax_error_mentions_response_format', { script: [R(200, 'response_format bad', { 'content-type': 'application/json' }), R(200, oMsg('{"a":1}'))], calls: [O('parse')] });
await scenario('o_long_401_detail', { script: [R(401, oErr('长'.repeat(500)))], calls: [O('parse')] });
await scenario('o_ping_schema_rejection_cleared', { script: [R(400, oErr('no schema')), R(200, oMsg('{"ok":true}')), R(200, oMsg('{"ok":true}')), R(200, oMsg('{"ok":true}'))], calls: [O('completeJson', { schema: P.PING_SCHEMA }), O('test'), O('completeJson', { schema: P.PING_SCHEMA })] });
await scenario('e_not_ok_with_vectors', { baseOverride: 'http://{HOST}', script: [R(500, { embeddings: [[1]] }), R(200, { embeddings: [[1], [2], [3]] })], calls: [EMB(['a']), EMB(['a', 'b'])] });

// ---- 钥匙与头的清洗(fetch 的 Headers)、重定向(C++ 不跟:divergent)、地址的各种写法
const OK = () => R(200, aMsg()), OKO = () => R(200, oMsg('{}'));
for (const [tag, key] of [['ws', ' sk-ws \n'], ['tab', '\tsk-tab\t'], ['crlf', 'sk-a\r\nX-Evil: 1'], ['nul', 'sk-a\u0000b'], ['latin1', 'sk-é'], ['cjk', 'sk-中文'], ['del', 'sk-\u007f'], ['ctl', 'sk-\u0001']]) {
  await scenario(`rv_key_${tag}_a`, { script: [OK(), OK(), OK()], calls: [A('completeJson', { apiKey: key })] });
  await scenario(`rv_key_${tag}_o`, { script: [OKO(), OKO(), OKO()], calls: [O('completeJson', { apiKey: key })] });
}
await scenario('rv_hdr_env_cjk', { env: { OPENAI_CUSTOM_HEADERS: 'X-N: 中\nX-S:  v  \nX-T: a\tb' }, script: [OKO()], calls: [O('completeJson')] });
await scenario('rv_hdr_env_cjk_a', { env: { ANTHROPIC_CUSTOM_HEADERS: 'X-N: 中' }, script: [OK()], calls: [A('completeJson')] });
await scenario('rv_hdr_env_badname', { env: { OPENAI_CUSTOM_HEADERS: 'X Bad: 1\nGood: 2' }, script: [OKO()], calls: [O('completeJson')] });
await scenario('rv_auth_token_ws', { env: { ANTHROPIC_AUTH_TOKEN: 'a b' }, script: [OK()], calls: [A('completeJson')] });
for (const st of [301, 302, 303, 307, 308]) {
  await scenario(`rv_redirect_${st}_a`, { divergent: 'redirect', script: [R(st, '', { location: '/v1/messages2' }), OK()], calls: [A('completeJson')] });
  await scenario(`rv_redirect_${st}_o`, { divergent: 'redirect', script: [R(st, '', { location: '/v1/other' }), OKO()], calls: [O('completeJson')] });
}
await scenario('rv_redirect_cross_host', { divergent: 'redirect', script: [R(307, '', { location: 'http://localhost:{PORT}/x' }), OKO()], calls: [O('completeJson')] });
await scenario('rv_redirect_nolocation', { divergent: 'redirect', script: [R(302, ''), OKO()], calls: [O('completeJson')] });
for (const [tag, b] of [['cred', 'http://u:p@{HOST}'], ['query', 'http://{HOST}/p?x=1'], ['frag', 'http://{HOST}/p#f'], ['upper', 'HTTP://{HOST}'], ['space', ' http://{HOST} '], ['dots', 'http://{HOST}/a/../b/./c'], ['pct', 'http://{HOST}/a%20b'], ['dbl', 'http://{HOST}//x//'], ['noscheme', '{HOST}'], ['bs', 'http:\\\\{HOST}\\x'], ['tab', 'http://{HOST}/a\tb']]) {
  await scenario(`rv_abase_${tag}`, { env: { ANTHROPIC_BASE_URL: b }, script: [OK(), OK(), OK()], calls: [A('completeJson')] });
}
for (const [tag, b] of [['cred', 'http://u:p@{HOST}/v1'], ['query', 'http://{HOST}/v1?x=1'], ['frag', 'http://{HOST}/v1#f'], ['upper', 'HTTP://{HOST}/v1'], ['dots', 'http://{HOST}/a/../v1'], ['pct', 'http://{HOST}/a%20b'], ['bs', 'http:\\\\{HOST}\\v1'], ['tab', 'http://{HOST}/a\tb'], ['dblslash', 'http://{HOST}//v1//']]) {
  await scenario(`rv_obase_${tag}`, { baseOverride: b, script: [OKO(), OKO(), OKO()], calls: [O('completeJson')] });
}

// ---- 连接用的主机必须就是 WHATWG 认出来的那个:校验放行的地址,请求不许到别处(decoy 端点一个请求都不许收到)
for (const [tag, sep] of [['bs_at', '\\@'], ['userinfo', '@'], ['port80_at', ':80@'], ['hash_at', '#@'], ['query_at', '?@'], ['bs2', '\\\\@'], ['slash_bs', '/\\@'], ['tab', '\t@'], ['pct40', '%40'], ['bs_pct', '\\%40']]) {
  await scenario(`ssrf_o_${tag}`, { decoy: true, baseOverride: `http://{HOST}${sep}{DECOY}`, script: [OKO(), OKO(), OKO()], calls: [O('completeJson')] });
  await scenario(`ssrf_a_${tag}`, { decoy: true, env: { ANTHROPIC_BASE_URL: `http://{HOST}${sep}{DECOY}` }, script: [OK(), OK(), OK()], calls: [A('completeJson')] });
  await scenario(`ssrf_e_${tag}`, { decoy: true, baseOverride: `http://{HOST}${sep}{DECOY}`, script: [R(200, { embeddings: [[1]] }), R(200, { embeddings: [[1]] })], calls: [EMB(['a'])] });
}
// 反向:userinfo 在前、真主机在 @ 后面(WHATWG 里主机是 @ 后面那个)
await scenario('ssrf_o_user_first', { decoy: true, baseOverride: 'http://{DECOY}@{HOST}', script: [OKO(), OKO(), OKO()], calls: [O('completeJson')] });
await scenario('ssrf_a_user_first', { decoy: true, env: { ANTHROPIC_BASE_URL: 'http://{DECOY}@{HOST}' }, script: [OK(), OK(), OK()], calls: [A('completeJson')] });
await scenario('ssrf_o_bs_path', { decoy: true, baseOverride: 'http://{HOST}\\{DECOY}', script: [OKO(), OKO(), OKO()], calls: [O('completeJson')] });
// M1:ANTHROPIC_BASE_URL 的拼接照 WHATWG(点段折叠、查询里的路径、制表符、凭证、没有协议、别的协议)
for (const [tag, b] of [['dots_up', 'http://{HOST}/a/b/../../c'], ['dots_pct', 'http://{HOST}/a/%2e%2e/c/%2E/d'], ['q_path', 'http://{HOST}?x=1'], ['q_two', 'http://{HOST}/p?x=1&y=2&x=3'], ['q_empty', 'http://{HOST}/p?'], ['q_int_keys', 'http://{HOST}/p?b=1&1=2&a=3&0=4'], ['q_plus_pct', 'http://{HOST}/p?a+b=c%20d&é=%C3%A9'],
  ['nl', 'http://{HOST}/a\nb'], ['crlf_tab', 'ht\ttp://{HOST}/x\r'], ['user_only', 'http://user@{HOST}'], ['empty_user', 'http://@{HOST}'], ['scheme_less', '{HOST}/x'], ['ftp', 'ftp://{HOST}'], ['file', 'file:///tmp'], ['ws', 'ws://{HOST}'], ['bad_port', 'http://127.0.0.1:99999'], ['empty_host', 'http://'], ['only_scheme', 'http:'], ['slash_slash', '//{HOST}'], ['spaces_inside', 'http://{HOST}/a b'], ['hash_q', 'http://{HOST}/p#f?x=1'], ['pct_bad', 'http://{HOST}/%zz%4'], ['caret', 'http://{HOST}/a^b{c}`d|e'], ['upper_scheme', 'HtTp://{HOST}/X']]) {
  await scenario(`m1_a_${tag}`, { env: { ANTHROPIC_BASE_URL: b }, script: [OK(), OK(), OK()], calls: [A('completeJson')] });
}
// B2:请求头的清洗(Authorization / X-Api-Key / 自定义头)——头里不许藏换行,不许多出一个头
for (const [tag, key] of [['trail_nl', 'sk-a\n'], ['lead_cr', '\rsk-a'], ['embedded_crlf', 'sk-a\r\nX-Evil: 1'], ['embedded_lf', 'sk-a\nX-Evil: 1'], ['embedded_cr', 'sk-a\rX-Evil: 1'], ['nul', 'sk-a\u0000b'], ['high', 'sk-中'], ['latin1', 'sk-é'], ['long', 'sk-' + 'x'.repeat(300)], ['sp_only', '   '], ['tab_inner', 'sk\ta'], ['del', 'sk-\u007f'], ['esc', 'sk-\u001b'], ['ff', 'sk-\u00ff'], ['c1', 'sk-\u0080'], ['u100', 'sk-\u0100']]) {
  await scenario(`b2_key_${tag}_a`, { script: [OK(), OK(), OK()], calls: [A('completeJson', { apiKey: key })] });
  await scenario(`b2_key_${tag}_o`, { script: [OKO(), OKO(), OKO()], calls: [O('completeJson', { apiKey: key })] });
}
for (const [tag, h] of [['name_space', 'X Bad: 1'], ['name_ctl', 'X\u0001Bad: 1'], ['name_unicode', 'X-中: 1'], ['value_trim', 'X-T:  \t v \t '], ['value_nul', 'X-N: a\u0000b'], ['value_high', 'X-H: é'], ['value_cjk', 'X-C: 中'], ['two', 'X-A: 1\nX-A: 2'], ['name_dup_case', 'x-a: 1\nX-A: 2'], ['empty_name', ': v'], ['ct_override', 'Content-Type: text/plain'], ['host_override', 'Host: evil.example'], ['auth_override', 'Authorization: Bearer other'], ['token_chars', "X-!#$%&'*+-.^_`|~: ok"]]) {
  await scenario(`b2_hdr_${tag}_a`, { env: { ANTHROPIC_CUSTOM_HEADERS: h }, script: [OK(), OK(), OK()], calls: [A('completeJson')] });
  await scenario(`b2_hdr_${tag}_o`, { env: { OPENAI_CUSTOM_HEADERS: h }, script: [OKO(), OKO(), OKO()], calls: [O('completeJson')] });
}
await scenario('b2_token_a', { env: { ANTHROPIC_AUTH_TOKEN: 'tok\r\nX-Evil: 1' }, script: [OK()], calls: [A('completeJson')] });
await scenario('b2_token_trail_a', { env: { ANTHROPIC_AUTH_TOKEN: 'tok-ok\t' }, script: [OK()], calls: [A('completeJson')] });
await scenario('b2_org_o', { env: { OPENAI_ORG_ID: 'org\nX-Evil: 1' }, script: [OKO()], calls: [O('completeJson')] });
await scenario('b2_project_o', { env: { OPENAI_PROJECT_ID: 'proj\u0000' }, script: [OKO()], calls: [O('completeJson')] });
// 嵌入的地址写法:凭证、反斜杠
await scenario('e_cred', { baseOverride: 'http://u:p@{HOST}', script: [R(200, { embeddings: [[1]] })], calls: [EMB(['a'])] });
await scenario('e_cred_user_only', { baseOverride: 'http://u@{HOST}', script: [R(200, { embeddings: [[1]] })], calls: [EMB(['a'])] });
await scenario('e_path_and_query', { baseOverride: 'http://{HOST}/pre/./x/../fix?k=v', script: [R(200, { embeddings: [[1]] })], calls: [EMB(['a'])] });
await scenario('e_trailing_slashes', { baseOverride: 'http://{HOST}///', script: [R(200, { embeddings: [[1]] })], calls: [EMB(['a'])] });
await scenario('e_https_loopback_refused', { dead: true, baseOverride: 'https://{HOST}', calls: [EMB(['a'], { timeoutMs: 1000 })] });
await scenario('e_redirect', { divergent: 'redirect', baseOverride: 'http://{HOST}', script: [R(307, '', { location: '/api/other' }), R(200, { embeddings: [[1]] })], calls: [EMB(['a'])] });
await scenario('e_redirect_302_post', { divergent: 'redirect', baseOverride: 'http://{HOST}', script: [R(302, '', { location: 'http://localhost:{PORT}/api/embed' }), R(200, { embeddings: [[1]] })], calls: [EMB(['a'])] });

// ---------------------------------------------------------------- 回包的 HTTP 解析(undici / llhttp 的严格程度):原始字节、两个 SDK、不重试
const crlf = (s) => s.replace(/\n/g, '\r\n');
const RJ = '{"a":1}';
const ok = (extra, body = RJ, status = '200 OK') => crlf(`HTTP/1.1 ${status}\ncontent-type: application/json\n${extra}\n\n`) + body;

const RAW_CASES = [
  ['cl_ok', ok(`content-length: ${RJ.length}`)],
  ['cl_neg', ok('content-length: -5')],
  ['cl_garbage', ok('content-length: abc')],
  ['cl_plus', ok(`content-length: +${RJ.length}`)],
  ['cl_hex', ok('content-length: 0x7')],
  ['cl_space', ok(`content-length:   ${RJ.length}  `)],
  ['cl_dup_same', ok(`content-length: ${RJ.length}\ncontent-length: ${RJ.length}`)],
  ['cl_dup_diff', ok(`content-length: ${RJ.length}\ncontent-length: 3`)],
  ['cl_list', ok(`content-length: ${RJ.length}, ${RJ.length}`)],
  ['cl_short_body', ok('content-length: 100')],
  ['cl_less_than_body', ok('content-length: 3')],
  ['cl_huge', ok('content-length: 99999999999999999999')],
  ['te_and_cl', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\ncontent-length: 3\n\n`) + '7\r\n{"a":1}\r\n0\r\n\r\n'],
  ['te_chunked', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '7\r\n{"a":1}\r\n0\r\n\r\n'],
  ['te_chunk_ext', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '7;ext=1\r\n{"a":1}\r\n0\r\n\r\n'],
  ['te_chunk_upper_hex', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + 'A\r\n{"a":12345}\r\n0\r\n\r\n'],
  ['te_chunk_bad_size', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + 'zz\r\n{"a":1}\r\n0\r\n\r\n'],
  ['te_chunk_neg', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '-1\r\n{"a":1}\r\n0\r\n\r\n'],
  ['te_chunk_no_final', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '7\r\n{"a":1}\r\n'],
  ['te_chunk_trailer', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '7\r\n{"a":1}\r\n0\r\nx-t: 1\r\n\r\n'],
  ['te_chunk_missing_crlf', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '7\r\n{"a":1}XX0\r\n\r\n'],
  ['te_gzip_chunked', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: gzip, chunked\n\n`) + '7\r\n{"a":1}\r\n0\r\n\r\n'],
  ['te_identity', ok('transfer-encoding: identity', RJ)],
  ['until_close', ok('', RJ)],
  ['http10', crlf(`HTTP/1.0 200 OK\ncontent-type: application/json\n\n`) + RJ],
  ['http2_line', crlf(`HTTP/2 200\ncontent-type: application/json\n\n`) + RJ],
  ['no_reason', crlf(`HTTP/1.1 200\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['status_99', crlf(`HTTP/1.1 099 X\ncontent-length: 0\n\n`)],
  ['status_1000', crlf(`HTTP/1.1 1000 X\ncontent-length: 0\n\n`)],
  ['status_abc', crlf(`HTTP/1.1 abc X\ncontent-length: 0\n\n`)],
  ['status_lower', crlf(`http/1.1 200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['continue_100', crlf(`HTTP/1.1 100 Continue\n\n`) + crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['early_hints_103', crlf(`HTTP/1.1 103 Early Hints\nlink: x\n\n`) + crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['switching_101', crlf(`HTTP/1.1 101 Switching Protocols\nupgrade: x\n\n`) + RJ],
  ['bare_lf', `HTTP/1.1 200 OK\ncontent-type: application/json\ncontent-length: 7\n\n` + RJ],
  ['header_obs_fold', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\nx-a: 1\n  2\ncontent-length: 7\n\n`) + RJ],
  ['header_no_colon', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\nbadline\ncontent-length: 7\n\n`) + RJ],
  ['header_space_before_colon', crlf(`HTTP/1.1 200 OK\ncontent-type : application/json\ncontent-length: 7\n\n`) + RJ],
  ['ct_dup', crlf(`HTTP/1.1 200 OK\ncontent-type: text/plain\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['ct_charset', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json; charset=utf-8\ncontent-length: 7\n\n`) + RJ],
  ['ct_missing', crlf(`HTTP/1.1 200 OK\ncontent-length: 7\n\n`) + RJ],
  ['bom_body', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ncontent-length: 10\n\n`) + 'ï»¿' + RJ],
  ['204_with_body', crlf(`HTTP/1.1 204 No Content\ncontent-length: 7\n\n`) + RJ],
  ['304', crlf(`HTTP/1.1 304 Not Modified\n\n`)],
  ['err_500_chunked', crlf(`HTTP/1.1 500 X\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '7\r\n{"a":1}\r\n0\r\n\r\n'],
  ['err_401_until_close', crlf(`HTTP/1.1 401 X\ncontent-type: application/json\n\n`) + '{"error":{"message":"bad"}}'],
  ['only_headers_no_body_until_close', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\n\n`)],
  ['garbage', 'garbage garbage\r\n\r\n'],
  ['empty', ''],
  ['partial_headers', 'HTTP/1.1 200 OK\r\ncontent-type: app'],
  ['nul_in_header', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\nx-a: a\u0000b\ncontent-length: 7\n\n`) + RJ],
  ['utf8_body_split', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ncontent-length: 11\n\n`) + Buffer.from('{"a":"中"}').toString('latin1')],
  ['invalid_utf8_body', crlf(`HTTP/1.1 200 OK\ncontent-type: text/plain\ncontent-length: 3\n\n`) + 'ÿþý'],
  ['x_should_retry_ignored', crlf(`HTTP/1.1 200 OK\nx-should-retry: true\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
];
RAW_CASES.push(
  ['http_2_0', crlf(`HTTP/2.0 200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['switching_101_then_200', crlf(`HTTP/1.1 101 Switching Protocols\nupgrade: x\n\n`) + crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['chunk_cr_then_junk', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '7\r\n{"a":1}\rX0\r\n\r\n'],
  ['chunk_junk_then_lf', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '7\r\n{"a":1}X\n0\r\n\r\n'],
  ['trailer_token_no_colon', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '7\r\n{"a":1}\r\n0\r\nbadtrailer\r\n\r\n'],
  ['trailer_bad_name', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '7\r\n{"a":1}\r\n0\r\nx(a): 1\r\n\r\n'],
  ['continue_100_twice', crlf(`HTTP/1.1 100 Continue\n\n`) + crlf(`HTTP/1.1 100 Continue\n\n`) + crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['processing_102', crlf(`HTTP/1.1 102 Processing\n\n`) + crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['status_199', crlf(`HTTP/1.1 199 X\n\n`) + crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['early_hints_then_103', crlf(`HTTP/1.1 103 Early Hints\n\n`) + crlf(`HTTP/1.1 103 Early Hints\n\n`) + crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['cl_zero_with_body', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ncontent-length: 0\n\n`) + RJ],
  ['cl_leading_zeros', ok('content-length: 0007')],
  ['cl_tab', ok(`content-length:\t${RJ.length}\t`)],
  ['cl_empty', ok('content-length:')],
  ['cl_dup_split_case', ok(`Content-Length: ${RJ.length}\ncontent-length: ${RJ.length}`)],
  ['te_chunked_upper', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: CHUNKED\n\n`) + '7\r\n{"a":1}\r\n0\r\n\r\n'],
  ['te_chunked_then_gzip', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked, gzip\n\n`) + '7\r\n{"a":1}\r\n0\r\n\r\n'],
  ['te_two_headers', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: gzip\ntransfer-encoding: chunked\n\n`) + '7\r\n{"a":1}\r\n0\r\n\r\n'],
  ['chunk_size_space', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '7 \r\n{"a":1}\r\n0\r\n\r\n'],
  ['chunk_size_leading_zero', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '007\r\n{"a":1}\r\n0\r\n\r\n'],
  ['chunk_size_0x', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '0x7\r\n{"a":1}\r\n0\r\n\r\n'],
  ['chunk_bare_lf', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '7\n{"a":1}\r\n0\r\n\r\n'],
  ['chunk_two', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '3\r\n{"a\r\n4\r\n":1}\r\n0\r\n\r\n'],
  ['chunk_trailer_bad', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + '7\r\n{"a":1}\r\n0\r\nbad trailer\r\n\r\n'],
  ['chunk_huge_size', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ntransfer-encoding: chunked\n\n`) + 'ffffffffffffffffff\r\n{"a":1}\r\n0\r\n\r\n'],
  ['header_lone_cr', 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-a: 1\r2\r\ncontent-length: 7\r\n\r\n' + RJ],
  ['header_ctl_in_value', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\nx-a: a\u0001b\ncontent-length: 7\n\n`) + RJ],
  ['header_tab_in_value', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\nx-a: a\tb\ncontent-length: 7\n\n`) + RJ],
  ['header_del_in_value', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\nx-a: a\u007fb\ncontent-length: 7\n\n`) + RJ],
  ['header_high_value', 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-a: \xe9\r\ncontent-length: 7\r\n\r\n' + RJ],
  ['header_bad_name_char', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\nx(a): 1\ncontent-length: 7\n\n`) + RJ],
  ['header_empty_name', crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\n: v\ncontent-length: 7\n\n`) + RJ],
  ['header_leading_space_first', crlf(`HTTP/1.1 200 OK\n content-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['status_line_two_spaces', crlf(`HTTP/1.1  200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['status_line_tab', crlf(`HTTP/1.1\t200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['http_1_9', crlf(`HTTP/1.9 200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['http_0_9', crlf(`HTTP/0.9 200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['http_11', crlf(`HTTP/11.1 200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['leading_crlf', '\r\n' + crlf(`HTTP/1.1 200 OK\ncontent-type: application/json\ncontent-length: 7\n\n`) + RJ],
  ['redirect_301', crlf(`HTTP/1.1 301 Moved\nlocation: /x\ncontent-length: 0\n\n`)],
  ['status_300', crlf(`HTTP/1.1 300 Multiple\nlocation: /x\ncontent-length: 0\n\n`)],
  ['status_305', crlf(`HTTP/1.1 305 Use Proxy\nlocation: /x\ncontent-length: 0\n\n`)],
);
const rawCases = [];
{
  const net = await import('node:net');
  const { createRequire } = await import('node:module');
  const req = createRequire(join(engine, 'package.json'));
  const { default: OpenAI } = await import(pathToFileURL(req.resolve('openai')).href);
  const { default: Anthropic } = await import(pathToFileURL(req.resolve('@anthropic-ai/sdk')).href);
  for (const flavor of ['openai', 'anthropic']) for (const [name, raw] of RAW_CASES) {
    const bytes = Buffer.from(raw, 'latin1');
    const server = net.createServer((sock) => { sock.on('error', () => {}); let got = ''; sock.on('data', (d) => { got += d.toString('latin1'); if (got.includes('\r\n\r\n') && !sock._sent) { sock._sent = true; sock.write(bytes); sock.end(); } }); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const c = flavor === 'openai' ? new OpenAI({ apiKey: KEY, baseURL: base, maxRetries: 0, timeout: 1500 }) : new Anthropic({ apiKey: KEY, baseURL: base, maxRetries: 0, timeout: 1500 });
    let res;
    try { const v = await c.post('/x', { body: { q: 1 }, ...(flavor === 'anthropic' ? { timeout: 1500 } : {}) }); res = { ok: enc(v === undefined ? '__undefined__' : v) }; }
    catch (e) { res = { error: { name: e?.constructor?.name, message: String(e?.message), status: enc(e?.status) } }; }
    rawCases.push({ flavor, name, hex: bytes.toString('hex'), res });
    server.closeAllConnections?.(); await new Promise((r) => server.close(r));
  }
}

// ---------------------------------------------------------------- 地址:new URL / 校验 / 拼接(真的 SDK 的 buildURL)
const urlCands = new Set();
{
  const hosts = ['127.0.0.1', 'localhost', '[::1]', '127.0.0.1:11434', 'localhost:8080'];
  const evil = ['evil.com', 'evil.com:80', '10.0.0.5', '[2001:db8::1]', 'user@evil.com', 'a:b@evil.com'];
  const seps = ['\\@', '@', ':80@', '#@', '?@', '\t.', ' @', '\\', '/\\', '\\\\', '%40', '%5c@', '。', '．', '.­', '․', '\\%40', '@@', '#', '?', ';@', ',@', '\x00@', '\n@', '\r\n@', '\\\t@', '/..@', '\u0000', '%00@', '＠', '＼@', '\\u0040'];
  for (const h of hosts) for (const e of evil) for (const sp of seps) { urlCands.add(`http://${h}${sp}${e}`); urlCands.add(`http://${e.replace(/@.*/, '')}${sp}${h}`); }
  for (const e of evil) for (const sp of seps) urlCands.add(`http://${e}${sp}127.0.0.1`);
  for (const x of ['http://127.0.0.1:80\\@evil.com', 'http://127.1\\@evil.com', 'http://2130706433@evil.com', 'http://127.0.0.1:\\@evil.com', 'http://localhost.\\@evil.com', 'http://LOCALHOST\\@evil.com', 'http://[::ffff:127.0.0.1]\\@evil.com', 'http://127.0.0.1\\.evil.com', 'http://127.0.0.1%2eevil.com', 'http://127.0.0.1。evil.com', 'http:\\\\127.0.0.1\\@evil.com', 'http:/\\127.0.0.1\\@evil.com', 'http:127.0.0.1\\@evil.com', 'HTTP://127.0.0.1\\@evil.com', 'https://127.0.0.1\\@evil.com', 'http://127.0.0.1\\@evil.com:443', 'http://127.0.0.1\\@[2001:db8::1]']) urlCands.add(x);
  const hostsMisc = ['[1:0:3:4:5:6:7:8]', '[1:0:0:2:0:0:3:4]', '[0:0:0:0:0:0:0:0]', '[1:2:3:4:5:6:7:0]', '[0:2:3:4:5:6:7:8]', 'a\u0001b.com', 'a\u007fb.com', '0x7f.1', '127.1', '0177.0.0.1', '2130706433', '1.2.3.4.5', '256.1.1.1', '1.2.3', '1.2.3.', '0x7f.0x0.0x0.0x1', '00.0.0.01', '[::ffff:7f00:1]', '[0:0:0:0:0:0:0:1]', '[::1%25eth0]', '[1:2:3:4:5:6:7:8:9]', '[::ffff:1.2.3.4]', '[::]', '[1::]', '[1:0:0:2:0:0:0:3]', '[1:0:0:0:2:0:0:3]', '[::1.2.3.4]', '[::01.2.3.4]', '[FE80::1]', '[]', '[', ']', 'LOCALHOST', 'localhost.', 'LocalHost.', 'ｌｏｃａｌｈｏｓｔ', 'ｅｖｉｌ.com', 'münchen.de', 'EXAMPLE.com', 'exa%6Dple.com', '%31%32%37.0.0.1', 'xn--mnchen-3ya.de', 'xn--a', '🍕.com', 'a_b.com', 'a b.com', 'a%20b.com', 'a%2fb.com', 'a.b.', '.', '..', 'a..b', '-a.com', 'a-.com', '1e3.com', '0x.com', '0xg', '09.1.1.1', '4294967296', '4294967295', '127.0.0.1.', '127.0.0.1..', 'a.1', 'a.0x1', 'a.09', '­', 'ab­cd.com', 'a‍b.com', 'ǆ.com', 'ß.de', 'ς.gr', '中文.com', 'a。b', 'a．b', 'ａ.b', '%ff.com', '%c3%28.com', '%e4%b8%ad.com', '%zz.com', 'a%.com', '%.com', 'a^b.com', 'a|b.com', 'a<b>.com', 'a`b.com', 'a{b}.com'];
  for (const h of hostsMisc) { urlCands.add(`http://${h}/`); urlCands.add(`http://${h}:8080/p`); urlCands.add(`https://${h}`); }
  for (const pt of [':0', ':65535', ':65536', ':080', ':', ':-1', ':80a', ':０', ':443', ':00000000000000000000080', ':+80', ': 80', ':8 0']) { urlCands.add(`http://127.0.0.1${pt}/x`); urlCands.add(`https://127.0.0.1${pt}/x`); urlCands.add(`http://[::1]${pt}`); }
  for (const pa of ['/a/b/..', '/a/b/%2e%2e', '/a/b/.', '/a/b/./', '/a//..', '/a/b/../', '/a/%2E%2E/', '', '/', '//', '/a/../b', '/a/%2e%2e/b', '/a/%2E./b', '/a/.%2e/b', '/./x', '/a/.', '/a/..', '/a/./', '/a/../', '/..', '/../..', '/a b', '/é', '/a\\b', '/?q=a b#f', '/a;b', '/^`{}', '/a|b', '/%', '/%4', '/%zz', '/\u0000', '/\t', '/\ud800', '/😀', '?q', '#f', '?', '#', '?#', '/a?b?c#d#e', '/?q=\'', '/?q="<>`{}', '/#"<>`{}', '/\\..\\', '/a/b/../../../c']) { urlCands.add(`http://127.0.0.1:1${pa}`); }
  for (const sc of ['http', 'HTTP', 'hTtP', 'https', 'ftp', 'ws', 'wss', 'file', 'javascript', 'data', 'foo', '1http', '+http', 'ht tp', 'h.t-t+p', '']) { urlCands.add(`${sc}://127.0.0.1/`); urlCands.add(`${sc}:127.0.0.1`); urlCands.add(`${sc}:\\\\127.0.0.1`); urlCands.add(`${sc}:/127.0.0.1`); urlCands.add(`${sc}:///127.0.0.1`); }
  for (const x of ['foo:@', 'foo:a@', 'foo://@', 'foo:[', 'foo://[::1', 'a:@@', 'x:%', 'foo:@h', '', ' ', '\t', 'http', 'http:', 'http:/', 'http://', 'http:///', 'http://:80', 'http://@', 'http://@/', 'http://a@', 'http://:@a', 'http://a:@b', 'http://:b@c', 'http://a:b:c@d', 'http://a@b@c', 'http://a@@b', 'http://%40@b', 'http://a%40@b', 'http://u\u0001@b', 'http://é:ü@b', ' \t http://127.0.0.1 \n', '\u0001http://127.0.0.1\u001f', 'http://127.0.0.1\u0000', 'http://127.0.0.1 ', '127.0.0.1:80', 'localhost:8080', '//127.0.0.1', '/path', 'http://127.0.0.1/\t\n\r', 'ht\ntp://127.0.0.1', 'http://12\n7.0.0.1', 'http://127.0.0.1:8\t0']) urlCands.add(x);
}
const urls = [...urlCands].map((u) => {
  let href = null, f = null;
  try { const p = new URL(u); href = p.href; f = [p.protocol, p.username, p.password, p.hostname, p.port, p.pathname, p.search, p.hash]; } catch {}
  let v; try { v = { ok: C.validateBaseUrl(u) }; } catch (e) { v = { error: e.message }; }
  return { u, href, f, loop: E.isLoopbackUrl(u), validate: v };
});
const joinBases = ['http://127.0.0.1:1', 'http://127.0.0.1:1/', 'http://127.0.0.1:1/v1', 'http://127.0.0.1:1/v1/', 'http://127.0.0.1:1///', 'http://127.0.0.1:1/a/b/../../c', 'http://127.0.0.1:1/a/%2e%2e/c/%2E/d', 'http://127.0.0.1:1/p?a~b=c~d', 'http://127.0.0.1:1/p?k=v+w&x=%7E', 'http://127.0.0.1:1?x=1', 'http://127.0.0.1:1/?x=1', 'http://127.0.0.1:1/p?x=1&y=2&x=3', 'http://127.0.0.1:1/p?', 'http://127.0.0.1:1/p?b=1&1=2&a=3&0=4', 'http://127.0.0.1:1/p?a+b=c%20d&é=%C3%A9', 'http://127.0.0.1:1/p?a[]=1&a[]=2', 'http://127.0.0.1:1/p?a=%zz&=v&k', 'http://127.0.0.1:1/p?&&a=1&&', 'http://127.0.0.1:1/a\nb', 'ht\ttp://127.0.0.1:1/x\r', 'http://u:p@127.0.0.1:1', 'http://u@127.0.0.1:1/v1', 'http://@127.0.0.1:1', '127.0.0.1:1/x', 'localhost:1', 'ftp://127.0.0.1:1', 'file:///tmp', 'ws://127.0.0.1:1', 'http://', 'http:', '//127.0.0.1:1', 'http://127.0.0.1:1/a b', 'http://127.0.0.1:1/p#f?x=1', 'http://127.0.0.1:1/%zz%4', 'http://127.0.0.1:1/a^b{c}`d|e', 'HtTp://127.0.0.1:1/X', 'http://127.0.0.1:1\\v1', 'http://127.0.0.1:1\\@localhost:2', 'http://127.0.0.1:1\\@localhost:2/v1', 'http:\\\\127.0.0.1:1\\x', 'http://LOCALHOST:1/V1', 'http://[::1]:1/v1', 'http://[0:0:0:0:0:0:0:1]:1', 'http://0x7f.1:1', 'https://api.example.com/v1', 'https://api.example.com:443/v1', 'http://127.0.0.1:80/v1', 'https://127.0.0.1:443/v1', 'http://a.b.:1'];
const joins = [];
{
  const req2 = (await import('node:module')).createRequire(join(engine, 'package.json'));
  const { default: OpenAI } = await import(pathToFileURL(req2.resolve('openai')).href);
  const { default: Anthropic } = await import(pathToFileURL(req2.resolve('@anthropic-ai/sdk')).href);
  for (const b of joinBases) {
    const row = { base: b };
    try { row.openai = { ok: new OpenAI({ apiKey: KEY, baseURL: b }).buildURL('/chat/completions') }; } catch (e) { row.openai = { error: `${e.constructor.name}: ${e.message}` }; }
    try { row.anthropic = { ok: new Anthropic({ apiKey: KEY, baseURL: b }).buildURL('/v1/messages') }; } catch (e) { row.anthropic = { error: `${e.constructor.name}: ${e.message}` }; }
    joins.push(row);
  }
}

// ---------------------------------------------------------------- 纯函数
const pure = {};
pure.stripCodeFence = ['', '  x  ', '```json\n{"a":1}\n```', '```\n{}```', '```json', '```json {"a":1}```', '```\n  {"b":2}  \n```  \n', ' ```js\nX\n``` ', '``` x\n```', '```\n```\n```', 'no fence ```', '``\nabc'].map((s) => ({ in: s, ...run(() => P.stripCodeFence(s)) }));
pure.supportsSampling = ['claude-opus-5', 'claude-opus-5-20260101', 'claude-opus-4-8', 'claude-opus-4-7x', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5', 'claude-haiku-4-5', '', 'CLAUDE-OPUS-5'].map((m) => ({ in: m, out: P.supportsSamplingParams(m) }));
pure.catalog = enc(P.providerCatalog());
const ASSETS = join(engine, 'baseline/llm');
pure.schemas = ['parse_result', 'custom_rules', 'idea_analysis', 'idea_digest', 'pa_comment', 'sector_picks', 'nope'].map((n) => {
  const r = run(() => P.structuredOutputSchema(n));
  if (r.error) r.error = r.error.split(ASSETS).join('<ASSETS>');  // 资产目录的绝对路径不进夹具
  return { in: n, ...r };
});
const enumOf = (s) => s?.$defs?.Rejection?.properties?.code?.enum;
pure.schemaForPrompt = ['v1.0.0', 'v1.7.9', 'v1.8.0', 'v1.10', 'v2', '1.8.0-rc', 'v1.8', '', 'x', 'v0001.0008.0000', 'v1.8.0.9', 'v99999999999999999999.0.0', 'v1.7.200', 'v1.7.9999'].map((v) => ({ in: v, out: enc(enumOf(P.parseSchemaForPrompt(v))) }));
pure.friendly = [];
for (const [name, message, status, base] of [
  ['AuthenticationError', '401 bad', 401], ['PermissionDeniedError', 'x', 403], ['NotFoundError', 'x', 404], ['RateLimitError', 'x', 429], ['InternalServerError', 'x', 500], ['InternalServerError', 'x', 529],
  ['BadRequestError', '400 thing', 400], ['APIError', 'x', 418], ['LLMError', 'HTTP 401:{}', undefined], ['LLMError', 'Authentication failed', undefined], ['AuthenticationError', 'no digits', undefined],
  ['LLMError', 'resource NOT_FOUND', undefined], ['LLMError', 'got 404 back', undefined], ['LLMError', 'Rate_Limit hit', undefined], ['LLMError', 'HTTP 429:{}', undefined],
  ['LLMError', 'Connection error.', undefined], ['APIConnectionError', 'x', undefined], ['APIConnectionTimeoutError', 'Request timed out.', undefined], ['TypeError', 'weird', undefined],
  ['LLMError', '无法连接 http://127.0.0.1:4010/v1:Connection error.', undefined, 'http://127.0.0.1:4010/v1'], ['LLMError', '无法连接 http://127.0.0.1:4290/v1:boom', undefined, 'http://127.0.0.1:4290/v1'],
  ['LLMError', 'x', '401'], ['LLMError', 'x', NaN], ['LLMError', 'x', 499.5], ['LLMError', 'x', 500.5], ['Error', 'a 401 b', 200], ['LLMError', 'at localhost:4040 failed', undefined, 'not a url :4040'], ['LLMError', 'x at 127.0.0.1:4010 failed', undefined, 'http://127.0.0.1:4010/v1'], ['LLMError', '4a.b:8001', undefined, 'http://a.b:80/v1'],
]) {
  const Cls = { [name]: class extends Error {} }[name];
  const e = new Cls(message);
  if (status !== undefined) e.status = status;
  pure.friendly.push({ name, message, status: enc(status), base: base ?? '', out: P.friendlyApiError(e, base) });
}
pure.loopback = ['http://127.0.0.1:11434', 'https://localhost', 'http://[::1]:1', 'http://[0:0:0:0:0:0:0:1]/', 'http://LOCALHOST', 'http://127.1', 'http://2130706433', 'http://0x7f.0.0.1', 'http://127.0.0.2', 'http://localhost.', 'ftp://127.0.0.1', 'not a url', 'http://user:pw@127.0.0.1', 'http://10.0.0.1', ' http://127.0.0.1 ', 'http://127.0.0.1.nip.io', 'HTTP://127.0.0.1', 'http:127.0.0.1', 'http://[::2]', 'http://%31%32%37.0.0.1'].map((u) => ({ in: u, out: E.isLoopbackUrl(u) }));
pure.cosine = [[[1, 0], [1, 0]], [[1, 2, 3], [4, 5, 6]], [[], []], [[1], [1, 2]], [[0, 0], [1, 1]], [[1e200, 1], [1e200, 1]], [[NaN, 1], [1, 1]], [[-1, 0.5], [0.25, -3]], [[1e-200, 1e-200], [1e-200, 1e-200]], [[0.1, 0.2, 0.3], [0.3, 0.2, 0.1]]].map(([a, b]) => ({ a: enc(a), b: enc(b), out: enc(E.cosine(a, b)) }));
pure.embedConsts = { model: E.DEFAULT_EMBED_MODEL, url: E.DEFAULT_EMBED_URL, query: E.QUERY_INSTRUCTION };
pure.providers = enc(P.PROVIDERS);

const out = { generated_by: 'native/tests/fixtures/gen_llm.mjs', rawCases, urls, joins, sdk: { anthropic: JSON.parse(readFileSync(join(engine, 'node_modules/@anthropic-ai/sdk/package.json'), 'utf8')).version, openai: JSON.parse(readFileSync(join(engine, 'node_modules/openai/package.json'), 'utf8')).version }, bundles: BUNDLES, base_config: BASE_CFG, key: KEY, scenarios, pure };
writeFileSync(join(here, 'llm.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`llm.json: ${scenarios.length} 个场景`);
