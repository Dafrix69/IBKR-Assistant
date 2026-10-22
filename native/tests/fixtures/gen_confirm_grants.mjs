// 给 C++ 的确认凭据(native/shell/confirm_grants.*)出一份对拍用的期望值:同样的输入,desktop/confirm-grants.js 算出什么。
//
//   node native/tests/fixtures/gen_confirm_grants.mjs
//
// 输出 native/tests/fixtures/confirm-grants.json。只能重生成、不手改:C++ 那边红了,先看是不是 JS 那份改了。
// 每个结果都写成 JS 的 canonical(键排好序的 JSON,NaN 是 null):C++ 用自己的 canonical 算一遍,逐字比。
// 指纹(sha256)也比:C++ 的 canonical 差一个字(数字的写法、转义),指纹就对不上——那正是凭据核销不了的样子。
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const require = createRequire(import.meta.url);
const g = require(path.join(repo, "desktop", "confirm-grants.js"));

const CURRENT = {
  policies: { auto_execute: false, allow_live_trading: false },
  limits: { max_order_notional: 5000, max_option_contracts: 5, max_mkt_shares: 200, max_spread_slippage: 0.1, min_confidence: 0.9, duplicate_window_minutes: 10, max_orders_per_input: 5 },
};
const BY = { ...CURRENT.limits, max_open_risk_usd: 0, by_account: { 主账户: { max_order_notional: 2000 } } };
const OFF = { enabled: false, channel_id: "", author_ids: [], accounts: [], max_age_seconds: 30, max_orders_per_day: 3, max_risk_usd: 300 };
const ON = { ...OFF, enabled: true, channel_id: "1100000000000000001", author_ids: ["220000000000000002"], accounts: ["模拟", "主账户"] };
const TRACKING = { ...ON, track_fly: true, track_exit_at: "15:45" };

// ---- requiredGrants ----
const required = [
  ["instruction.submit", { text: "买 AAPL 100", execute: true, accounts: ["模拟"] }, null],
  ["instruction.submit", { text: "买 AAPL 100", execute: false, accounts: ["模拟"] }, null],
  ["instruction.submit", { text: 42, execute: true, accounts: [1, null, "主账户"] }, null],
  ["instruction.submit", { execute: "true" }, null],
  ["tracker.close_now", { id: "t1" }, null],
  ["tracker.close_now", { id: 7 }, null],
  ["tracker.close_now", {}, null],
  ["tracker.add", { key: "k", stop_loss: "95", auto_close: false, host_at_broker: false }, null],
  ["tracker.add", { key: "k", stop_loss: "95", auto_close: true, order_type: "LMT", host_at_broker: false }, null],
  ["tracker.add", { key: "k", auto_close: 0, host_at_broker: "yes" }, null],
  ["tracker.add", { key: "k", auto_close: "", host_at_broker: null }, null],
  ["broker.select", { provider: "futu" }, null],
  ["settings.patch", { patch: { policies: { auto_execute: true, allow_live_trading: true, require_trigger_price_verification: true } } }, CURRENT],
  ["settings.patch", { patch: { policies: { auto_execute: true, allow_live_trading: true } } }, { ...CURRENT, policies: { auto_execute: true } }],
  ["settings.patch", { patch: { policies: { auto_execute: false } } }, CURRENT],
  ["settings.patch", { patch: { policies: { auto_execute: true } } }, null],
  ["settings.patch", { patch: { policies: { auto_execute: "true" } } }, CURRENT],
  ["settings.patch", { patch: { limits: { max_order_notional: 50000, max_option_contracts: 5, max_mkt_shares: 100, min_confidence: 0.8, duplicate_window_minutes: 0 } } }, CURRENT],
  ["settings.patch", { patch: { limits: { max_order_notional: 1000, min_confidence: 0.95 } } }, CURRENT],
  ["settings.patch", { patch: { limits: { ...CURRENT.limits } } }, CURRENT],
  ["settings.patch", { patch: { limits: null } }, { ...CURRENT, limits: BY }],
  ["settings.patch", { patch: null }, CURRENT],
  ["settings.patch", { patch: "nope" }, CURRENT],
  ["settings.patch", {}, CURRENT],
  ["settings.patch", { patch: { limits: { max_order_notional: "6000", max_mkt_shares: "很多", min_confidence: "" } } }, CURRENT],
  ["settings.patch", { patch: { limits: { max_order_notional: 6000 } } }, null],
  ["settings.patch", { patch: { limits: { by_account: { 主账户: { max_order_notional: 3000 } } } } }, { ...CURRENT, limits: BY }],
  ["settings.patch", { patch: { limits: { max_order_notional: 9000, by_account: { 主账户: null } } } }, { ...CURRENT, limits: BY }],
  ["settings.patch", { patch: { follow: { enabled: true, channel_id: ON.channel_id, author_ids: ON.author_ids } } }, { ...CURRENT, follow: OFF }],
  ["settings.patch", { patch: { follow: { ...ON } } }, null],
  ["settings.patch", { patch: { follow: { enabled: false } } }, { ...CURRENT, follow: ON }],
  ["settings.patch", { patch: { follow: { ...ON } } }, { ...CURRENT, follow: ON }],
  ["settings.patch", { patch: { follow: { channel_id: "1100000000000000009" } } }, { ...CURRENT, follow: ON }],
  ["settings.patch", { patch: { follow: { author_ids: ["330000000000000003"] } } }, { ...CURRENT, follow: ON }],
  ["settings.patch", { patch: { follow: { max_risk_usd: "很多" } } }, { ...CURRENT, follow: ON }],
  ["settings.patch", { patch: { follow: { accounts: [] } } }, { ...CURRENT, follow: { ...ON, accounts: ["模拟"] } }],
  ["settings.patch", { patch: { follow: { accounts: ["模拟"] } } }, { ...CURRENT, follow: ON }],
  ["settings.patch", { patch: { follow: { local_inbox: true, local_channel: " charlie的策略 " } } }, { ...CURRENT, follow: ON }],
  ["settings.patch", { patch: { follow: { track_fly: true, track_exit_at: "15:45" } } }, { ...CURRENT, follow: ON }],
  ["settings.patch", { patch: { follow: { track_fly: false, track_exit_at: "10:00" } } }, { ...CURRENT, follow: TRACKING }],
  ["settings.patch", { patch: { policies: { auto_execute: true }, limits: { max_order_notional: 9999 }, follow: { ...ON } } }, { ...CURRENT, follow: OFF }],
  ["system.status", { id: "x" }, CURRENT],
  ["tracker.update", { id: "x" }, CURRENT],
  ["llm.patch", { id: "x" }, CURRENT],
];

// ---- loosenedLimits ----
const NOW_CAP = { ...CURRENT.limits, max_open_risk_usd: 2000, max_underlying_contracts: 0, auto_mid_spread_share: 0 };
const TIGHT = { ...BY, max_open_risk_usd: 0, max_underlying_contracts: 0, by_account: { 主账户: { max_order_notional: 300, max_option_contracts: 1, max_open_risk_usd: 1000, max_underlying_contracts: 2 } } };
const loosened = [
  [{ max_order_notional: 50000 }, CURRENT.limits],
  [{ max_open_risk_usd: 0 }, NOW_CAP], [{ max_open_risk_usd: 3000 }, NOW_CAP], [{ max_open_risk_usd: 1000 }, NOW_CAP],
  [{ max_underlying_contracts: 10 }, NOW_CAP], [{ max_underlying_contracts: 0 }, NOW_CAP], [{ auto_mid_spread_share: 0.5 }, NOW_CAP],
  [{ by_account: { 主账户: { max_order_notional: 3000 } } }, BY], [{ by_account: { 主账户: { max_order_notional: 1000 } } }, BY],
  [{ by_account: { 主账户: { max_order_notional: null } } }, BY], [{ by_account: { 模拟: { max_option_contracts: 2 } } }, BY],
  [{ by_account: { 模拟: { max_option_contracts: 20 } } }, BY], [{ by_account: { 模拟: { max_order_notional: null, max_option_contracts: null } } }, BY],
  [{ max_order_notional: 9000, by_account: { 模拟: { max_order_notional: null } } }, BY], [{ by_account: { 主账户: { max_open_risk_usd: 1500 } } }, BY],
  [{ by_account: { 主账户: null } }, BY], [{ by_account: null }, BY], [{ by_account: { 模拟: null } }, BY], [{ by_account: { 主账户: null } }, TIGHT],
  [null, BY], [undefined, BY], [{ max_order_notional: 6000 }, null], [{ max_order_notional: 6000 }, {}],
  [{ max_order_notional: null }, CURRENT.limits], [{ max_order_notional: true }, CURRENT.limits], [{ max_order_notional: [7000] }, CURRENT.limits],
  [{ max_order_notional: " 0x1F40 " }, CURRENT.limits], [{ max_order_notional: "1e4" }, CURRENT.limits], [{ max_order_notional: "Infinity" }, CURRENT.limits],
  [{ by_account: { 主账户: "nope" } }, BY], [{ by_account: [{ max_order_notional: 99999 }] }, BY],
];

// ---- normalizeBinding ----
const normalize = [
  ["limits.loosen", { limits: null }], ["limits.loosen", { limits: { "by_account.主账户.max_order_notional": 3000 } }],
  ["limits.loosen", { limits: { by_account: { 主账户: { max_order_notional: "3000" } } } }], ["limits.loosen", { limits: { max_order_notional: 9000, by_account: { 主账户: null } } }],
  ["limits.loosen", { limits: { max_order_notional: "x", by_account: { a: { b: null, c: "1" }, d: "e" } } }], ["limits.loosen", "nope"],
  ["instruction.submit", { text: null, accounts: "模拟" }], ["instruction.submit", { text: undefined }], ["instruction.submit", { text: true, accounts: [true, 0.1, {}] }],
  ["tracker.close_now", { id: null }], ["broker.select", { provider: ["a", "b"] }], ["gate.auto_execute", { anything: 1 }], ["gate.follow", { ...ON, author_ids: ["b", "a", "b"] }],
  ["tracker.add", { key: "k", auto_close: true, nested: { z: 1, a: [1, 2] } }],
];

// ---- followBinding / followWidened ----
const bindings = [ON, OFF, {}, null, { channel_id: 123, author_ids: [3, "2", 3], accounts: ["b", "a"], max_age_seconds: "30", max_orders_per_day: null, local_inbox: "true", local_channel: " x　", track_fly: 1, track_exit_at: null }];
const widened = [
  [{ ...ON }, { ...OFF }], [{ ...ON }, null], [{ ...OFF }, { ...ON }], [{ ...ON }, { ...ON }], [{ ...ON, channel_id: "9" }, ON],
  [{ ...ON, author_ids: [...ON.author_ids, "3"] }, ON], [{ ...ON, author_ids: ["3"] }, ON], [{ ...ON, max_age_seconds: 31 }, ON], [{ ...ON, max_risk_usd: "x" }, ON],
  [{ ...ON, accounts: [] }, { ...ON, accounts: ["模拟"] }], [{ ...ON, accounts: ["模拟"] }, ON], [{ ...ON, accounts: ["模拟"] }, { ...ON, accounts: [] }],
  [{ ...ON, local_inbox: true }, ON], [{ ...ON, local_inbox: true, local_channel: "x" }, { ...ON, local_inbox: true }], [{ ...ON, local_inbox: true, local_channel: "" }, { ...ON, local_inbox: true, local_channel: "x" }],
  [{ ...TRACKING }, ON], [{ ...TRACKING, track_exit_at: "09:31" }, TRACKING], [{ ...TRACKING, track_exit_at: "" }, TRACKING], [{ ...ON, enabled: "true" }, OFF],
];

// ---- followConfirmText(数字的千分位与四舍五入也在这里比) ----
const accts = [{ alias: "模拟", is_paper: true, default: true }, { alias: "主账户", is_paper: false, default: false }];
const texts = [
  [ON, accts], [{ ...ON, accounts: [] }, accts], [ON, []], [{ ...TRACKING }, [{ alias: "模拟", is_paper: true, default: true }]],
  [{ ...ON, local_inbox: true, local_channel: "charlie的策略" }, accts], [{ ...ON, local_inbox: true, channel_id: "" }, accts],
  [{ ...ON, max_risk_usd: 1234.5, max_orders_per_day: 1000000, max_age_seconds: 0.125 }, accts], [{ ...ON, max_risk_usd: 1.005, max_age_seconds: 99999.999 }, accts],
  [{ ...ON, max_risk_usd: "x", author_ids: [] }, [{ alias: "主账户", is_paper: false }]],
  // 没有标默认的账户:没点名时发到第一个
  [{ ...ON, accounts: [] }, [{ alias: "主账户", is_paper: false }, { alias: "模拟", is_paper: true }]],
];

// ---- canonical 与指纹 ----
const values = [
  { b: 1, a: [3, { y: null, x: "z" }] }, 0.1, 1e21, 1e-7, 123456789012345680000, -0, 5e-324, 0.000001, 1.5e-6, NaN, Infinity, true, null,
  "引号\"与\\反斜杠\n换行\t\u0001\u001f", "😀", "lone \ud800 surrogate", { "": 1, "b": undefined, "a": 2 }, [undefined, NaN, "a"],
];
const digests = [
  ["instruction.submit", { text: "1.8 挂15蝴蝶 15CM", accounts: ["模拟", "主账户"] }], ["tracker.close_now", { id: "t1" }],
  ["tracker.add", { key: "k", auto_close: true, stop_loss: "95" }], ["gate.follow", ON], ["limits.loosen", { limits: { max_order_notional: 50000, min_confidence: 0.8 } }],
  ["gate.auto_execute", {}], ["broker.select", null],
];
const digest = (purpose, binding) => crypto.createHash("sha256").update(`${purpose}\n${g.canonical(g.normalizeBinding(purpose, binding) ?? {})}`).digest("hex");

const c = (v) => g.canonical(v);
const fixture = {
  generator: "native/tests/fixtures/gen_confirm_grants.mjs",
  ttl_ms: g.TTL_MS,
  purposes: g.PURPOSES,
  required: required.map(([m, p, cur]) => ({ method: m, params: p, current: cur, expected: c(g.requiredGrants(m, p, cur)) })),
  loosened: loosened.map(([p, cur]) => ({ patch: p === undefined ? "__undefined__" : p, current: cur, expected: c(g.loosenedLimits(p, cur)) })),
  normalize: normalize.map(([purpose, b]) => ({ purpose, binding: b, expected: c(g.normalizeBinding(purpose, b)) })),
  follow_binding: bindings.map((b) => ({ cfg: b, expected: c(g.followBinding(b)) })),
  follow_widened: widened.map(([n, w]) => ({ next: n, now: w, expected: g.followWidened(n, w) })),
  follow_text: texts.map(([b, a]) => ({ binding: b, accounts: a, expected: g.followConfirmText(g.followBinding(b), a) })),
  canonical: values.map((v) => ({ js: String(v), expected: c(v) })),
  digests: digests.map(([p, b]) => ({ purpose: p, binding: b, expected: digest(p, b) })),
};
// 几个 JSON 写不出来的值(NaN、Infinity、-0、undefined、落单的代理项):C++ 那边按名字现造,这里只给名字
fixture.canonical = fixture.canonical.map((row, i) => ({ ...row, index: i }));
const target = path.join(here, "confirm-grants.json");
fs.writeFileSync(target, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${path.relative(repo, target)}: ${required.length} required, ${loosened.length} loosened, ${normalize.length} normalize, ${texts.length} texts`);
