// 生成 settings.json:「设置」(desktop/renderer-react/src/pages/Settings.tsx,带 lib/DataPanel、lib/EventsConfig、lib/AccountLimitsRows)
// 与「关于」(pages/About.tsx,带 lib/UpdatePanel、lib/SupportPanel)。
//   · settings / about:SSR 把页面渲染出来抽字。页面状态在 useState 里(效果在 SSR 里不跑),由 ssr/build.mjs 的 PANEL_SEEDS 按命名空间灌
//     (settings / data / eventscfg / about / support);外观三项、更新、引擎日志在 zustand 的 store 里,直接设。
//     数据底子是预览台的 mock,外加改出来的边角。每个场景记下灌进去的那一份,C++ 那边拿同样的输入。
//   · form:settingsForm.ts 的 toForm / formProblems / toPatch / isDirty 的输入输出(原模块现跑)。
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_settings.mjs <装好依赖的 desktop 目录>
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

const sliders = (html) => [...html.matchAll(/role="slider"[^>]*aria-valuenow="([\d.]+)"/g)].map((m) => Number(m[1]));
const descs = (html) => [...html.matchAll(/<tr class="ant-descriptions-row">([\s\S]*?)<\/tr>/g)].map((m) => {
  const at = m[1].indexOf('ant-descriptions-item-content');
  // 内容是 undefined 时 AntD 不出内容那一格:整行就是名字
  if (at < 0) return { label: texts(m[1]).join(''), value: '' };
  const lab = m[1].slice(0, m[1].lastIndexOf('<', at)), val = m[1].slice(at);
  return { label: texts(lab.slice(lab.indexOf('>') + 1)).join(''), value: texts(val.slice(val.indexOf('>') + 1)).join('') };
});
const links = (html) => [...html.matchAll(/<a([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ href: decode(/href="([^"]*)"/.exec(m[1])?.[1] ?? ''), text: texts(m[2]).join('') }));
const pres = (html) => [...html.matchAll(/<pre class="([^"]*)">([\s\S]*?)<\/pre>/g)].map((m) => ({ cls: m[1], text: decode(m[2].replace(/<[^>]+>/g, '')) }));
const extract = (html) => ({ texts: texts(html), buttons: buttons(html), inputs: inputs(html), segments: segments(html), switches: switches(html), notices: notices(html),
  sliders: sliders(html), descs: descs(html), links: links(html), pres: pres(html) });
const switchesDisabled = (html) => [...html.matchAll(/<button([^>]*role="switch"[^>]*)>/g)].map((m) => /\sdisabled=""/.test(m[1]));

const clone = (o) => JSON.parse(JSON.stringify(o));
const sf = ui.settingsForm;
const settings = await mock.getSettings();
const backups = await mock.listBackups();
const eventsCfg = (await mock.setEventsConfig({})).config;
const appInfo = await mock.appInfo();
const selftest = await mock.selftest();
const update = await mock.checkUpdate(true);

const APPEAR = { themeMode: 'system', updown: 'green-up', glass: 0.72 };
const settingsPages = [];
async function spage(name, { seed = {}, appearance = APPEAR } = {}) {
  for (const k of Object.keys(store)) delete store[k];
  ui.seedAppearance(appearance);
  globalThis.__ssrSeed = clone(seed);
  const html = ui.renderSettingsPage();
  globalThis.__ssrSeed = undefined;
  if (process.env.DUMP_HTML?.startsWith(`${name}:`)) writeFileSync(process.env.DUMP_HTML.slice(name.length + 1), html);
  settingsPages.push({ name, seed, appearance, ...extract(html), switchesDisabled: switchesDisabled(html) });
}
const loaded = (s, extra = {}) => ({ settings: { saved: s, form: sf.toForm(s), ...extra } });
const base = { ...loaded(settings), data: { info: backups }, eventscfg: { draft: eventsCfg } };

await spage('读着');
await spage('预览', { seed: base });
await spage('深色、红涨绿跌、玻璃 0.3', { seed: base, appearance: { themeMode: 'dark', updown: 'red-up', glass: 0.3 } });
await spage('有改动、保存着', { seed: { ...base, settings: { saved: settings, form: { ...sf.toForm(settings), notional: 8000, autoExecute: false }, saving: true } } });
const allOn = { ...sf.toForm(settings), slGuard: true, ddGuard: true, coolOn: true, coolScope: 'position', dailyOn: true, dailyBasis: 'account', rbOn: true, rbRisk: 1, rbPosition: 20,
  rbEquity: { 模拟: 50000, 主账户: null }, midShare: 25, underlying: 10, openRisk: null };
await spage('保护全开', { seed: { ...base, settings: { saved: settings, form: allOn } } });
const broken = { ...allOn, notional: null, contracts: 0, mktShares: null, slippage: -1, dupe: null, midShare: 120, slLookback: null, slCount: 0, ddUsd: 0, coolMinutes: null, dailyUsd: null, rbRisk: null,
  byAccount: { 模拟: { notional: 0, contracts: 0, openRisk: null, underlying: null }, 主账户: { notional: 2000, contracts: 2, openRisk: null, underlying: null } } };
await spage('点过保存、有问题', { seed: { ...base, settings: { saved: settings, form: broken, checked: true } } });
await spage('有问题但没点过保存', { seed: { ...base, settings: { saved: settings, form: broken } } });
const one = clone(settings);
one.accounts = one.accounts.slice(0, 1);
one.limits.by_account = {};
one.risk_budget = { enabled: true, max_risk_pct: 1, max_position_pct: 25, equity_usd: { 模拟: 30000 } };
one.protections = undefined;
await spage('一个账户、风险预算开着、缺保护规则段', { seed: { ...loaded(one), data: { info: backups }, eventscfg: { draft: eventsCfg } } });
await spage('备份读不到', { seed: { ...base, data: { error: '引擎没起来' } } });
await spage('还没有备份', { seed: { ...base, data: { info: { ...backups, backups: [] } } } });
await spage('备份着', { seed: { ...base, data: { info: backups, busy: 'backup' } } });
await spage('恢复着', { seed: { ...base, data: { info: backups, busy: backups.backups[1].name } } });
await spage('重要事件关着', { seed: { ...base, eventscfg: { draft: { ...eventsCfg, enabled: false } } } });
await spage('跨市场关着、只一档提前', { seed: { ...base, eventscfg: { draft: { ...eventsCfg, cross_market: false, lead_minutes: [30], sector_share: 0.55 } } } });
const bigBackup = clone(backups);
bigBackup.backups = [{ name: 'trades-20261018-090000-manual.db', reason: 'manual', at: '2026-10-18T09:00:00Z', bytes: 512 }, { name: 'b', reason: 'upgrade', at: '2026-10-17T23:59:59Z', bytes: 25 * 1024 * 1024 + 300000 }];
await spage('备份大小两头', { seed: { ...base, data: { info: bigBackup } } });

// ---- settingsForm.ts 的函数 ----
const savedVariants = [settings, one, { ...clone(settings), limits: { ...clone(settings).limits, max_open_risk_usd: 0, auto_mid_spread_share: 0.333, max_underlying_contracts: 4 } }, {}, { policies: { auto_execute: true }, accounts: [{ alias: 'x', is_paper: true }] }];
const toFormCases = savedVariants.map((s) => ({ saved: s, form: sf.toForm(s) }));
const forms = [sf.toForm(settings), allOn, broken, { ...allOn, underlying: 3.7, midShare: 150, openRisk: 2500, rbEquity: { 模拟: 0, 主账户: -5 } },
  { ...sf.toForm(settings), byAccount: { 模拟: { notional: 1500, contracts: null, openRisk: null, underlying: 2 }, 主账户: { notional: null, contracts: null, openRisk: null, underlying: null } } }];
// 两个账户都有问题:按账户的那几条按账户表的次序(Object.entries)
forms.push({ ...sf.toForm(settings), dupe: 0, byAccount: { 模拟: { notional: -1, contracts: 0, openRisk: null, underlying: null }, 主账户: { notional: -1, contracts: null, openRisk: null, underlying: null } } });
const formCases = forms.map((f) => ({ form: f, problems: sf.formProblems(f), order: Object.keys(f.byAccount) }));
const patchCases = [];
for (const f of forms) for (const s of [settings, one, null]) patchCases.push({ form: f, saved: s, patch: sf.toPatch(f, s) });
const dirtyCases = [];
for (const f of forms) for (const s of [settings, null]) dirtyCases.push({ form: f, saved: s, dirty: sf.isDirty(f, s) });

// ---- 关于 ----
const aboutPages = [];
async function apage(name, { seed = {}, upd = {}, log = '' } = {}) {
  for (const k of Object.keys(store)) delete store[k];
  ui.seedUpdate({ info: null, checking: false, error: null, auto: true, dismissed: '', ...upd });
  ui.seedEngineLog(log);
  globalThis.__ssrSeed = clone(seed);
  const html = ui.renderAboutPage();
  globalThis.__ssrSeed = undefined;
  if (process.env.DUMP_HTML?.startsWith(`${name}:`)) writeFileSync(process.env.DUMP_HTML.slice(name.length + 1), html);
  aboutPages.push({ name, seed, update: { info: null, checking: false, error: null, auto: true, dismissed: '', ...upd }, log, ...extract(html) });
}
const selfAcc = { ...selftest, accounts: [{ alias: '模拟', account_masked: 'DU***321', is_paper: true }, { alias: '主账户', account_masked: 'U***567', is_paper: false }] };
const info = { app: appInfo, self: selftest };
await apage('读着');
await apage('预览', { seed: { about: { info } }, upd: { info: update }, log: '[engine] 启动\n[engine] 已连接 TWS' });
await apage('读取失败', { seed: { about: { error: '读取失败:引擎没起来' } } });
await apage('全信息、两个账户、检查着', { seed: { about: { info: { app: { ...appInfo, engineVersion: '0.5.2', chrome: '142.0', node: '24.1.0' }, self: selfAcc } }, support: { busy: true } }, upd: { info: update, checking: true } });
await apage('没日志路径、已是最新', { seed: { about: { info: { app: { ...appInfo, logPath: undefined }, self: selftest } } }, upd: { info: { ...update, newer: false, latest: '0.2.0', notes: '' } } });
await apage('有新版没安装包、忽略过这一版', { seed: { about: { info } }, upd: { info: { ...update, download: null }, dismissed: update.latest, auto: false } });
await apage('检查着还没结果', { seed: { about: { info } }, upd: { checking: true } });
await apage('检查失败没结果', { seed: { about: { info } }, upd: { error: '连不上 GitHub' } });
await apage('有结果、上次失败', { seed: { about: { info } }, upd: { info: { ...update, newer: false }, error: '超时' } });
await apage('认不出版本号', { seed: { about: { info } }, upd: { info: { ...update, newer: false, latest: null, publishedAt: null } } });
await apage('新版没日期、大小不明', { seed: { about: { info } }, upd: { info: { ...update, publishedAt: 'x', download: { ...update.download, size: null } } } });

writeFileSync(join(here, 'settings.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_settings.mjs', now: NOW,
  settings: settingsPages, form: { toForm: toFormCases, problems: formCases, patch: patchCases, dirty: dirtyCases }, about: aboutPages }, null, 1) + '\n');
console.log(`settings.json:设置 ${settingsPages.length} 页、关于 ${aboutPages.length} 页、${patchCases.length} 个补丁`);
process.exit(0);
