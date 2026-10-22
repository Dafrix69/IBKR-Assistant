// 生成 access.json:「接入」(desktop/renderer-react/src/pages/Access.tsx 与五节:lib/TwsPanel、FutuPanel、AccountsPanel、LlmPanel、FollowPanel,
// 共用的 lib/connectBits,跟单表单的 lib/followForm)。
//   · pages:SSR 把每一节渲染出来抽字。各节的状态全在 useState 里(效果在 SSR 里不跑),由 ssr/build.mjs 的 PANEL_SEEDS 按命名空间灌
//     (tws / futu / accounts / llm / follow / bits);券商连没连、账户列表、允许自动执行在状态快照里;大模型目录在 store/llm。
//     数据底子是预览台的 mock,外加改出来的边角。每个场景记下灌进去的那一份,C++ 那边拿同样的输入。
//   · follow:followForm.ts 的 formProblems / toConfig / isDirty / addAuthor / readerText / quoteLine 的输入输出(原模块现跑)。
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_access.mjs <装好依赖的 desktop 目录>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const desktop = process.argv[2];
if (!desktop) throw new Error('要给装好依赖的 desktop 目录');
if (process.env.TZ !== 'Asia/Shanghai') throw new Error('时间按本机时区写:要 TZ=Asia/Shanghai 跑');

const NOW = Date.UTC(2026, 9, 18, 18, 0, 0);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

const out = mkdtempSync(join(tmpdir(), 'ssr-'));
execFileSync(process.execPath, [join(here, 'ssr/build.mjs'), desktop, out], { stdio: 'inherit' });

function loadMock() {
  const w = { localStorage: undefined, addEventListener() {}, setTimeout, clearTimeout };
  const sandbox = { window: w, console, setTimeout, clearTimeout, Date, Math, JSON, Promise };
  w.window = w;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(repo, 'desktop/tools/mock-bridge.js'), 'utf8'), sandbox);
  return w.dafri;
}
const mock = loadMock();
const store = {};
globalThis.window = {
  dafri: new Proxy({}, { get: (_t, name) => (name === 'status' ? async () => JSON.parse(JSON.stringify(window.__status)) : mock[name] ?? (async () => ({}))) }),
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
globalThis.localStorage = window.localStorage;
globalThis.document = { hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {} } };
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
const ui = await import(pathToFileURL(join(out, 'entry.mjs')).href);

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
const texts = (html) => decode(html.replace(/<title>[\s\S]*?<\/title>/g, '').replace(/<[^>]+>/g, '\n'))
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const buttons = (html) => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ text: texts(m[2]).join(''), loading: /ant-btn-loading/.test(m[1]), disabled: /\sdisabled=""/.test(m[1]),
  primary: /ant-btn-primary/.test(m[1]), danger: /ant-btn-dangerous/.test(m[1]) })).filter((b) => b.text);
const inputs = (html) => [...html.matchAll(/<input([^>]*)>/g)].map((m) => ({
  type: /type="password"/.test(m[1]) ? 'password' : /type="checkbox"/.test(m[1]) ? 'checkbox' : 'text',
  value: decode(/\svalue="([^"]*)"/.exec(m[1])?.[1] ?? ''), placeholder: decode(/placeholder="([^"]*)"/.exec(m[1])?.[1] ?? ''),
  disabled: /\sdisabled=""/.test(m[1]), checked: /\schecked=""/.test(m[1]) }))
  .filter((i) => i.value || i.placeholder || i.type === 'checkbox');
const segments = (html) => [...html.matchAll(/<div class="ant-segmented([^"]*)"[^>]*>([\s\S]*?)<\/div><\/div>/g)].map((m) => [...m[2].matchAll(/<label class="ant-segmented-item([^"]*)"/g)].map((x) => /item-selected/.test(x[1])));
const switches = (html) => [...html.matchAll(/<button([^>]*role="switch"[^>]*)>/g)].map((m) => /aria-checked="true"/.test(m[1]));
const cards = (html) => [...html.matchAll(/class="ant-card[^"]*status-card tone-(\w+)/g)].map((m) => m[1]);
const notices = (html) => [...html.matchAll(/class="ant-alert ant-alert-(\w+)/g)].map((m) => m[1]);
const badges = (html) => [...html.matchAll(/ant-badge-status-(success|warning|error|default|processing)/g)].map((m) => m[1]);
const tags = (html) => [...html.matchAll(/<span class="ant-tag([^"]*)"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => ({ color: /ant-tag-(success|warning|error|default|processing)/.exec(m[1])?.[1] ?? '', closable: /ant-tag-close-icon/.test(m[2]), text: texts(m[2]).join('') }));
const pills = (html) => [...html.matchAll(/<span class="pill( solid)?" style="--tile:([^";]*);?"/g)].map((m) => m[2]);
const ports = (html) => [...html.matchAll(/class="ant-card ant-card-bordered ant-card-small port (open|closed)/g)].map((m) => m[1]);
const rowTones = (html) => [...html.matchAll(/class="[^"]*follow-(link|reader|inbox) tone-(\w+)/g)].map((m) => `${m[1]}:${m[2]}`);
const checks = (html) => [...html.matchAll(/<label class="ant-checkbox-wrapper([^"]*)"/g)].map((m) => /checkbox-wrapper-checked/.test(m[1]));
const primers = (html) => [...html.matchAll(/class="ant-collapse-item( ant-collapse-item-active)?/g)].map((m) => Boolean(m[1]));

const clone = (o) => JSON.parse(JSON.stringify(o));
const baseStatus = await mock.status();
const scanTws = await mock.scanTws();
const catalog = await mock.brokerCatalog();
const diagTws = (await mock.diagnoseTws()).results;
const scanFutu = await mock.scanFutu();
const diagFutu = (await mock.diagnoseFutu()).results;
const accountsInfo = await mock.accountsInfo();
const llmCatalog = await mock.llmCatalog();
const follow = await mock.followStatus();

const pages = [];
async function page(name, sub, { seed = {}, status = {}, local = {}, llm = llmCatalog } = {}) {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, local);
  const st = status === null ? null : { ...clone(baseStatus), ...status };
  await ui.seedStatus(st);
  await ui.seedLlmCatalog(llm === null ? null : clone(llm));
  globalThis.__ssrSeed = clone(seed);
  const html = ui.renderAccessPage(sub);
  globalThis.__ssrSeed = undefined;
  if (process.env.DUMP_HTML?.startsWith(`${name}:`)) writeFileSync(process.env.DUMP_HTML.slice(name.length + 1), html);
  pages.push({ name, sub, seed, status: st, local, llm, texts: texts(html), buttons: buttons(html), inputs: inputs(html), segments: segments(html), switches: switches(html),
    cards: cards(html), notices: notices(html), badges: badges(html), tags: tags(html), pills: pills(html), ports: ports(html), rowTones: rowTones(html), checks: checks(html), primers: primers(html) });
}

// ---- TWS ----
await page('TWS:检测着', 'tws');
await page('TWS:检测到了、当前是 IBKR', 'tws', { seed: { tws: { scan: scanTws, current: 'ibkr' } } });
await page('TWS:当前是富途、没连券商', 'tws', { seed: { tws: { scan: scanTws, current: 'futu' } }, status: { broker_connected: false } });
await page('TWS:检测失败', 'tws', { seed: { tws: { scanError: '引擎没起来' } } });
await page('TWS:握手着', 'tws', { seed: { tws: { scan: scanTws, current: 'ibkr', diagState: 'working' } } });
await page('TWS:握手失败', 'tws', { seed: { tws: { scan: scanTws, diagState: 'error', diagError: '超时' } } });
const diagMixed = [clone(diagTws[0]),
  { ...clone(diagTws[0]), connection: 'live', port: 7496, connected: true, error: '只读 API:不能下单', hint: '在 TWS 的 API 设置里取消 Read-Only API', port_latency_ms: null, client_id: 112,
    accounts: [{ alias: '主账户', account_masked: 'U1***567', is_paper: false, connection: 'live', resolved: false, default: false }] },
  { connection: 'gw', host: null, port: null, port_open: false, connected: false, error: '端口没开', hint: null, client_id: 113, accounts: [] }];
await page('TWS:握手结果(成、半成、不成)', 'tws', { seed: { tws: { scan: scanTws, current: 'ibkr', diag: diagMixed }, bits: { launching: 'gateway', busy: true } } });
const scanAll = clone(scanTws);
scanAll.apps = [{ ...scanAll.apps[0], running: false }, { key: 'gateway', name: 'IB Gateway', installed: true, paths: [], running: false }];
scanAll.ports[1] = { ...scanAll.ports[1], latency_ms: null };
await page('TWS:都没跑、延迟不明', 'tws', { seed: { tws: { scan: scanAll, current: null } } });

// ---- 富途 ----
await page('富途:读着', 'futu');
await page('富途:都读到了', 'futu', { seed: { futu: { catalog, scan: scanFutu } } });
await page('富途:都读不到', 'futu', { seed: { futu: { catalogError: '引擎没起来', scanError: '超时' } }, status: { broker_connected: false } });
const futuCurrent = clone(catalog);
futuCurrent.current = 'futu';
futuCurrent.providers = futuCurrent.providers.map((p) => ({ ...p, current: p.key === 'futu' }));
futuCurrent.providers[0].config_snippet = '"connections": { "paper": { "host": "127.0.0.1", "port": 7497 } }';
futuCurrent.providers[0].connections = {};
futuCurrent.futu.unlock_password_saved = true;
const scanNoSdk = { ...clone(scanFutu), sdk_installed: false };
await page('富途:当前富途、IBKR 没配、没带接口库', 'futu', { seed: { futu: { catalog: futuCurrent, scan: scanNoSdk } } });
const diagFutuOk = [{ connection: 'opend', broker: 'futu', host: '127.0.0.1', port: 11111, port_open: true, port_latency_ms: 2, connected: true, server_version: 900,
  qot_logined: true, trd_logined: false, error: null, hint: null, accounts: [{ alias: '富途模拟', account_masked: '20***585', is_paper: true, connection: 'opend', resolved: true }] }];
await page('富途:握手结果', 'futu', { seed: { futu: { catalog, scan: scanFutu, diag: [...diagFutuOk, ...clone(diagFutu)] } } });
await page('富途:切换着、填了密码、保存着解锁着', 'futu', { seed: { futu: { catalog, scan: scanFutu, switching: 'futu', password: 'secret', isMd5: true, saving: true, unlocking: true, diagState: 'working' } } });
await page('富途:握手失败', 'futu', { seed: { futu: { catalog, scan: scanFutu, diagState: 'error', diagError: '没登录' } } });

// ---- 账户 ----
await page('账户:引擎没起来', 'accounts', { status: null, seed: { accounts: { info: { placeholders: [], connections: [] } } } });
await page('账户:列表', 'accounts', { seed: { accounts: { info: accountsInfo } } });
await page('账户:占位账号、没有连接', 'accounts', { seed: { accounts: { info: { placeholders: ['模拟', '主账户'], connections: [] } } } });
await page('账户:没有账户', 'accounts', { status: { accounts: [] }, seed: { accounts: { info: accountsInfo } } });
await page('账户:添加', 'accounts', { seed: { accounts: { info: accountsInfo, draft: { editing: null, alias: '', accountId: '', paper: true, connection: 'paper', makeDefault: false } } } });
await page('账户:修改、实盘账号标成纸面', 'accounts', { seed: { accounts: { info: accountsInfo, busy: true, draft: { editing: '主账户', alias: '主账户', accountId: 'U7654321', paper: true, connection: 'live', makeDefault: false } } } });
await page('账户:填好了(富途纯数字、默认)', 'accounts', { seed: { accounts: { info: accountsInfo, draft: { editing: null, alias: '富途二', accountId: '12345678', paper: true, connection: 'futu', makeDefault: true } } } });

// ---- 大模型 ----
const llmForm = (c, extra = {}) => ({ provider: c.current.provider, model: c.current.model, customModel: '', baseUrl: c.current.base_url, effort: c.current.effort,
  temperature: c.current.temperature, maxTokens: c.current.max_tokens, timeout: c.current.timeout_s, ...extra });
await page('大模型:还没读到目录', 'llm', { llm: null });
await page('大模型:Anthropic', 'llm', { seed: { llm: llmForm(llmCatalog) } });
await page('大模型:OpenAI 兼容、没配 Key、自定义模型', 'llm', { seed: { llm: { ...llmForm(llmCatalog), provider: 'openai_compatible', model: 'deepseek-chat', customModel: 'my-model', baseUrl: 'https://api.deepseek.com/v1', temperature: 0.3, apiKey: 'sk-xxx' } } });
const llmOdd = clone(llmCatalog);
llmOdd.current = { ...llmOdd.current, model: 'claude-old-1' };
await page('大模型:当前模型不在目录里、测着', 'llm', { llm: llmOdd, seed: { llm: { ...llmForm(llmOdd), test: { pending: true }, testing: true } } });
await page('大模型:测通了(降级)', 'llm', { seed: { llm: { ...llmForm(llmCatalog), test: { ok: true, model: 'claude-opus-5', latency_ms: 812, structured_mode: 'json_object', usage: { input_tokens: 120, output_tokens: 33 }, provider: 'anthropic' } } } });
await page('大模型:测通了', 'llm', { seed: { llm: { ...llmForm(llmCatalog), test: { ok: true, model: 'claude-opus-5', latency_ms: 640, structured_mode: 'json_schema', usage: null, provider: 'anthropic' } } } });
await page('大模型:测不通', 'llm', { seed: { llm: { ...llmForm(llmCatalog), test: { ok: false, error: '401 未授权', provider: 'anthropic', model: 'claude-opus-5' } } } });

// ---- 跟单 ----
const followForm = (cfg) => ui.followForm.toForm(cfg);
await page('跟单:读着', 'follow');
await page('跟单:读不到', 'follow', { seed: { follow: { loadError: '引擎没起来' } } });
await page('跟单:默认', 'follow', { seed: { follow: { status: follow, form: followForm(follow.config) } } });
// 连接与读窗口的各种样子、陌生人发来的消息、改过没存、开着但自动执行关着、填了 token
const fs2 = clone(follow);
fs2.token_configured = false;
fs2.link = { state: 'no_token', bot: null, error: null, channel_known: null };
fs2.inbox = { ...fs2.inbox, watching: false, error: null, reader: { state: 'untrusted', title: null, error: null } };
fs2.seen = [{ at: '2026-10-18T17:10:00.000Z', author_id: '330000000000000003', author_name: '路人', text: '7700 7725 bear call -2', source: 'discord' },
  { at: '2026-10-18T17:11:00.000Z', author_id: 'local:老王', author_name: '老王', text: '', source: 'local' }];
fs2.tracks_pending = 2;
fs2.recent = [];
const form2 = { ...followForm(fs2.config), authorIds: [], enabled: true, channelId: '', localInbox: false, maxAge: null, trackExitAt: '25:00' };
await page('跟单:没 token、读窗口没权限、改坏了、陌生人', 'follow', { status: { auto_execute: false }, seed: { follow: { status: fs2, form: form2, token: 'abc', newAuthor: 'local:新人', checked: true, busy: 'reconnect' } } });
for (const [state, link] of [['connecting', { state: 'connecting', bot: null, error: null }], ['failed', { state: 'failed', bot: null, error: '401 token 不对' }],
  ['ready-unknown', { state: 'ready', bot: 'b', error: null, channel_known: false }], ['off-inbox', { state: 'off', bot: null, error: null }], ['off', { state: 'off', bot: null, error: null }]]) {
  const fsx = clone(follow);
  fsx.link = link;
  if (state === 'off') { fsx.config.local_inbox = false; fsx.inbox = { ...fsx.inbox, watching: false, reader: { state: 'off' } }; }
  await page(`跟单:连接 ${state}`, 'follow', { seed: { follow: { status: fsx, form: followForm(fsx.config) } } });
}
for (const reader of [{ state: 'no_channel' }, { state: 'unavailable' }, { state: 'starting' }, { state: 'waiting' }, { state: 'no_list' }, { state: 'no_discord' }, { state: 'failed', error: 'swift 起不来' }]) {
  const fsx = clone(follow);
  fsx.inbox = { ...fsx.inbox, watching: false, error: reader.state === 'failed' ? '收件文件读不了' : null, last_at: '2026-10-18T17:20:00.000Z', received: 4, reader };
  await page(`跟单:读窗口 ${reader.state}`, 'follow', { seed: { follow: { status: fsx, form: followForm(fsx.config), busy: 'save' } } });
}
const fs3 = clone(follow);
fs3.inbox = { ...fs3.inbox, watching: true, last_at: '2026-10-18T17:20:00.000Z', received: 4 };
const form3 = { ...followForm(fs3.config), accounts: ['模拟'], trackFly: false, perDay: 5 };
await page('跟单:改了没存、勾了账户', 'follow', { seed: { follow: { status: fs3, form: form3, busy: 'token' } } });

// ---- followForm.ts 的函数(原模块现跑)----
const ff = ui.followForm;
const forms = [followForm(follow.config), form2, form3, { ...followForm(follow.config), channelId: '123', authorIds: ['abc', 'local:'], localChannel: 'x'.repeat(101), perDay: 1.5, maxRisk: 0, maxAge: 601 },
  { ...followForm(follow.config), localChannel: 'a\nb', trackExitAt: ' 9:05 ', maxRisk: 12.5 },
  // 只开本地收件、没填频道也能打开;同一个人信任两遍、本地与 bot 两种写法混着
  { ...followForm(follow.config), enabled: true, channelId: '', localInbox: true, localChannel: '老王的策略' },
  { ...followForm(follow.config), enabled: true, channelId: '', localInbox: false },
  { ...followForm(follow.config), authorIds: ['220000000000000002', '220000000000000002', 'local:老王', 'local:老王', ' 330000000000000003 '] }];
const formCases = forms.map((f) => ({ form: f, problems: ff.formProblems(f), config: ff.toConfig(f), dirty: ff.isDirty(f, follow.config), dirtyNull: ff.isDirty(f, null) }));
const authorCases = ['220000000000000002', ' 330000000000000003 ', 'local:老王', 'local:', '12', ''].map((id) => ({ id, after: ff.addAuthor(followForm(follow.config), id).authorIds }));
const readerCases = ['off', 'no_channel', 'unavailable', 'starting', 'reading', 'waiting', 'no_list', 'no_discord', 'untrusted', 'failed'].flatMap((state) =>
  [{ state, title: '#频道 | 服务器 - Discord', error: null }, { state, title: null, error: state === 'failed' ? null : 'x' }].map((reader) => ({ reader, channel: '老王的策略', out: ff.readerText(reader, '老王的策略') })));
const quoteCases = [
  { message_id: '1', quote: { side: 'debit', leader: 1.6, mid: 1.75, natural: 1.9, lag_s: 4, paper: false } },
  { message_id: 'local:2', quote: { side: 'debit', leader: 2, mid: 1.85, natural: 2.1, lag_s: 12, paper: true } },
  { message_id: '3', quote: { side: 'credit', leader: 2, mid: 1.9, natural: 1.65, lag_s: 2, paper: false } },
  { message_id: '4', quote: { side: 'credit', leader: 2.5, mid: 2.5, natural: -0.05, lag_s: 1, paper: false } },
  { message_id: '5', quote: { side: 'credit', leader: 1.25, mid: 1.4, natural: 1.2, lag_s: 0, paper: false } },
  { message_id: '6', quote: null },
].map((e) => ({ entry: e, out: ff.quoteLine(e) }));

writeFileSync(join(here, 'access.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_access.mjs', now: NOW, pages, follow: { forms: formCases, authors: authorCases, readers: readerCases, quotes: quoteCases } }, null, 1) + '\n');
console.log(`access.json:${pages.length} 页、${formCases.length} 份表单、${readerCases.length} 种读窗口、${quoteCases.length} 条盘口`);
process.exit(0);
