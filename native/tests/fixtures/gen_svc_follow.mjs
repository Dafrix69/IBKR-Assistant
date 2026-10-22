// 生成 svc_follow.json:engine-ts 的 FollowService(services/follow.ts,原模块现跑)对着脚本驱动的假宿主的场景(约定见 svc1_world.mjs、svc1_follow_world.mjs)。
// 场景照 engine-ts/tests/follow-service.spec.ts 的每一条写,再加随机交错(种子固定)。速记的产出用原模块 shorthand.tryParseShorthand 现算,放进脚本。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_follow.mjs <编过的 engine-ts 目录>
import { register } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installFollowWorld } from './svc1_follow_world.mjs';
import {
  BASE_CONFIG, World, dumpDb, enc, loadMods, makeRouter, makeSettings, rng, runSteps,
} from './svc1_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = process.argv[2];
if (!engineDir) throw new Error('要给编过的 engine-ts 目录');
const OUT = process.env.OUT ?? 'svc_follow.json';
const only = process.env.ONLY;

globalThis.__svc1Dist = pathToFileURL(join(engineDir, 'dist/src')).href;
register(pathToFileURL(join(here, 'svc1_stubs/hooks.mjs')).href);
const mods = await loadMods(engineDir, ['config', 'rpcError', 'broker', 'optionMarks', 'store', 'shorthand', 'follow', 'engine/closing', 'services/follow']);
mods.BrokerError = mods.broker.BrokerError;
mods.OptionMarksError = mods.optionMarks.OptionMarksError;

// ---------------------------------------------------------------- 跑一个场景
async function runScenario(script) {
  const world = new World(script);
  let fw = null;
  try {
    const box = { settings: makeSettings(mods.config, world) };
    const store = new mods.store.TradeStore(join(world.dir, 't.db'));
    const routerState = { ...(script.router ?? {}) };
    const ctx = { world, script, mods, engineDir, store, routerState };
    fw = installFollowWorld(world, mods, store, ctx);
    const session = { managedAccounts() { world.rec('session.managedAccounts', []); return [...(routerState.managed ?? ['DU7654321'])]; } };
    ctx.rebuildRouter = () => { ctx.router = makeRouter(world, mods, routerState, () => session); };
    ctx.rebuildRouter();
    const host = {
      get settings() { return box.settings; },
      get router() { return routerState.on === false ? null : ctx.router; },
      get engine() { return fw.engine; },
      emit(event, payload) { world.rec('emit', [event, payload]); },
    };
    ctx.makeService = () => {
      ctx.service = new mods.services_follow.FollowService(host);
      ctx.service.readerOptions = { get program() { return fw.state.readerProgram; } };
      ctx.service.onSeen = (message, trusted) => world.rec('onSeen', [message.id, trusted]);
    };
    ctx.makeService();
    if (!script.unwired) ctx.service.attach(fw.wiring);
    ctx.setSettings = (patch) => { box.settings = makeSettings(mods.config, world, patch); };
    ctx.shape = (m, v) => (v === undefined ? null : v);
    ctx.methods = {
      start: () => ctx.service.start(),
      stop: () => ctx.service.stop(),
      sync: ([restart]) => ctx.service.sync(restart ?? false),
      pollInbox: () => ctx.service.pollInbox(),
      settled: () => ctx.service.settled(),
      setToken: ([token]) => ctx.service.setToken(token),
      onMessage: ([msg]) => ctx.service.onMessage(msg),
      status: () => ctx.service.status(),
      trackTick: () => ctx.service.trackTick(),
    };
    ctx.extraOps = {
      attach: (step, rec) => fw.ops.attach(step, rec),
      newService: (step, rec) => fw.ops.newService(step, rec),
      gw: (step) => fw.ops.gw(step),
      inbox: (step) => fw.ops.inbox(step),
      reader: (step) => fw.ops.reader(step),
      breaker: (step) => fw.ops.breaker(step),
      readerProgram: (step) => fw.ops.readerProgram(step),
    };
    const steps = await runSteps(ctx);
    ctx.service.stop();
    await world.advance(0);
    const db = dumpDb(engineDir, join(world.dir, 't.db'), world);
    store.close();
    return { log: world.log, steps, db };
  } finally {
    fw?.cleanup();
    world.restore();
  }
}

// ---------------------------------------------------------------- 脚本的小零件
const CH = '1100000000000000001', FRIEND = '220000000000000002', STRANGER = '330000000000000003';
const NOW = Date.UTC(2026, 7, 14, 14, 32, 0); // 美东周五 10:32,常规时段
const EXPIRY = '20260814';
const FLY_LEG = `${EXPIRY}|+1x6900C,-2x6915C,+1x6930C`;
const SPOT = { SPX: 6907.35 };
const BOOK = {
  6900: { bid: 19.9, ask: 20.3 }, 6915: { bid: 10.9, ask: 11.1 }, 6930: { bid: 3.7, ask: 3.9 }, 6920: { bid: 9.0, ask: 9.4 }, 6925: { bid: 6.8, ask: 7.2 },
};
const ok = (v, delay) => (delay ? { ok: v, delay } : { ok: v });
const err = (kind, message, delay, code) => ({ err: { kind, message, ...(code !== undefined ? { code } : {}) }, ...(delay ? { delay } : {}) });
const call = (m, a = [], extra = {}) => ({ op: 'call', m, a, ...extra });
const adv = (ms) => ({ op: 'advance', ms });
const makeKey = (account, symbol, secType, leg) => `${account}|${symbol}|${secType}${leg ? `|${leg}` : ''}`;
const FLY_KEY = makeKey('模拟', 'SPX', 'BAG', FLY_LEG);
const legRow = (strike, quantity, avgCost, price, account = '模拟') => ({
  key: makeKey(account, 'SPX', 'OPT', `${EXPIRY}|${strike}|C`), account, symbol: 'SPX', sec_type: 'OPT', leg: `${EXPIRY}|${strike}|C`,
  label: `SPX ${strike}C`, quantity, multiplier: 100, currency: 'USD', avg_cost: avgCost, market_price: price, market_value: null, unrealized_pnl: null,
  contract: { secType: 'OPT', symbol: 'SPX', lastTradeDateOrContractMonth: EXPIRY, strike, right: 'C', multiplier: '100', tradingClass: 'SPXW', exchange: 'SMART' },
});
const flyRows = (lots = 1, account = '模拟') => [legRow(6900, lots, 2000, 20.1, account), legRow(6915, -2 * lots, 1100, 11.0, account), legRow(6930, lots, 380, 3.8, account)];
const track = (id, exitAt) => ({
  id, targets: {
    profit_drawdown_tiers: [{ above: 0, pct: 40 }, { above: 1.111111, pct: 30 }, { above: 3, pct: 20 }],
    profit_drawdown_arm: 0.555556, profit_drawdown_late: { after: '15:00', factor: 0.5 },
    exit_at: exitAt || null, exit_at_ms: exitAt ? Date.UTC(2026, 7, 14, 19, 45, 0) : null,
  },
  auto_close: { enabled: true },
});
const FOLLOW_ON = { enabled: true, channel_id: CH, author_ids: [FRIEND] };

/** 一条频道消息 */
function makeMsgs(start) {
  let n = 0;
  return (content, o = {}) => {
    n += 1;
    return {
      id: o.id ?? `m${n}`, channel_id: o.channel ?? CH, author_id: o.author ?? FRIEND, author_name: (o.author ?? FRIEND) === STRANGER ? '路人' : '老王',
      content, sentAtMs: (o.at ?? start) - (o.ageMs ?? 1000),
    };
  };
}

/** 场景搭建器:每说一句话,把速记的产出(原模块现算)与"发出去"的假答案登记好,回一个 onMessage 步 */
class Scene {
  constructor(name, o = {}) {
    this.script = {
      name, start: o.start ?? NOW, settings: { policies: { auto_execute: true }, ...(o.settings ?? {}), follow: { ...FOLLOW_ON, ...(o.follow ?? {}) } },
      router: o.router ?? {}, fakes: { ...(o.fakes ?? {}) }, vault: o.vault, book: o.book ?? BOOK, readerProgram: o.readerProgram ?? null,
      unwired: !!o.unwired, breaker: o.breaker, steps: [], ...(o.divergent ? { divergent: true } : {}),
    };
    this.msg = makeMsgs(this.script.start);
    this.spots = o.spots ?? SPOT;
    this.accounts = o.accounts ?? ['模拟'];
    this.recs = 0;
    this.legs = new Set();
    if (o.accounts) this.fake('engine.resolveFanout', [ok(o.accounts)]);
    if (!this.script.fakes['follow.addTrack'] && o.track !== false) this.fake('follow.addTrack', [ok({ track: track('t1', o.follow?.track_exit_at ?? '') })]);
  }

  fake(key, list) { this.script.fakes[key] = list; return this; }
  push(...steps) { this.script.steps.push(...steps); return this; }

  /** 这句话的速记产出(原模块现算);at 是解析那一刻 */
  parsed(content, spots = this.spots, at = this.script.start) {
    const text = mods.follow.orderText(content);
    const meta = { relativeCenter: false };
    const payload = mods.shorthand.tryParseShorthand(text, spots, mods.config.etNowFromEpoch(at), meta);
    return { text, payload, meta, snap: payload ? { [payload.orders?.[0]?.contract?.symbol ?? 'SPX']: spots[payload.orders?.[0]?.contract?.symbol ?? 'SPX'] } : {} };
  }

  /**
   * 登记一句话的假答案。o.send:'sent'(缺省)| 'none' | 'held' | 'rejected' | {…handleInstruction 的 ok};o.accounts 每个账户一笔;o.spots 覆盖现价;
   * o.parse:引擎那一遍想去调大模型
   */
  expect(content, o = {}) {
    const { text, payload, meta, snap } = this.parsed(content, o.spots ?? this.spots, o.at);
    const rec = { payload: o.payloadOverride ?? payload, snap: o.snapOverride ?? snap, meta: payload && meta.relativeCenter ? { relativeCenter: true } : null };
    if (o.noSnap) rec.snap = {};
    const list = (this.script.fakes[`engine.tryLocalShorthand|${text}`] ??= []);
    list.push(ok(rec));
    // 腿身份(建追踪要)
    const order = payload?.orders?.length === 1 ? payload.orders[0] : null;
    if (order) {
      const key = `engine.orderLegId|${order.contract.symbol}:${(order.contract.legs ?? []).map((l) => l.strike).join(',')}`;
      if (!this.script.fakes[key]) this.script.fakes[key] = [ok(mods.engine_closing.orderLegId(order))];
    }
    const accounts = o.accounts ?? this.accounts;
    let entry;
    if (o.send && typeof o.send === 'object') entry = ok(o.send);
    else if (o.send === 'none' || !order) entry = ok({});
    else {
      const item = (account) => {
        this.recs += 1;
        const record = { contract: order.contract, order: order.order, account: { alias: account }, input: { input_channel: 'discord' } };
        if (o.recordNoOrder) delete record.order;
        return { account, intent_summary: o.intentSummary ?? order.intent_summary, as: `r${this.recs}`, record };
      };
      if (o.send === 'held') entry = ok({ validated_only: accounts.map(item), llm: null });
      else if (o.send === 'rejected') entry = ok({ rejections: [{ message: o.reason ?? '张数超过限额', record: { contract: order.contract, order: order.order, account: { alias: accounts[0] } }, as: `x${this.recs}` }], llm: null });
      else entry = ok({ submitted: accounts.map(item).slice(0, o.sentCount ?? accounts.length), ...(o.rejected ? { rejections: [{ message: o.rejected }] } : {}), ...(o.queued ? { queued: accounts.map(item) } : {}), llm: o.llm ?? null, ...(o.parse ? { parse: true } : {}) });
    }
    if (o.err) entry = err('plain', o.err, o.delay);
    if (o.delay && !entry.delay) entry.delay = o.delay;
    (this.script.fakes[`engine.handleInstruction|${text}`] ??= []).push(entry);
    return this;
  }

  /** 说一句话:登记假答案 + 一个 onMessage 步 */
  say(content, o = {}) {
    this.expect(content, o);
    const m = this.msg(content, o);
    this.push(call('onMessage', [m], o.start ? { start: true, id: o.start } : {}));
    return m;
  }
}

const scenes = [];
const scene = (name, o) => { const s = new Scene(name, o); scenes.push(s); return s; };
const FLY = '1.8 挂15蝴蝶 15CM';
const CREDIT = '@everyone 6920 6925 bear call 挂个-2-2.5';
const dbStep = { op: 'db' };

// ---- 对方频道里真实的写法
{
  const s = scene('real_world_everyone_fly');
  s.say('@everyone 1.8 挂15蝴蝶 15CM');
  s.push(call('settled'), call('status'), dbStep);
}
{
  const s = scene('real_world_credit_spread');
  s.say(CREDIT);
  s.push(call('settled'), call('status'), dbStep);
}
{
  const s = scene('real_world_fly_without_price', { follow: { max_risk_usd: 100000 } });
  s.say('@everyone 15蝴蝶 15CM', { send: 'none' });
  s.say('1.8', { send: 'none' });
  s.push(call('status'), dbStep);
}
{
  const s = scene('real_world_chatter');
  s.say('@everyone 蝴蝶先走一下', { send: 'none' });
  s.say('@everyone 蝴蝶止损了哦', { send: 'none' });
  s.say('今天感觉要大跌,大家小心', { send: 'none' });
  s.push(call('status'), dbStep);
}
{
  const s = scene('real_world_spread_without_direction');
  s.say('@everyone 20 25可以挂个-2 -2.5', { send: 'none' });
  s.say('@everyone 7770 7775 bear call', { send: 'none' });
  s.push(call('status'), dbStep);
}
// ---- 「N蝴蝶」在百位边上
{
  const s = scene('relative_center_edge', { spots: { SPX: 6990 } });
  s.say('00蝴蝶 15CM 1.8', { send: 'none' });
  s.say('7000蝴蝶 15CM 1.8');
  s.push(call('settled'), dbStep);
}
{
  const s = scene('relative_center_observe_only', { follow: { enabled: false }, spots: { SPX: 6990 } });
  s.say('00蝴蝶 15CM 1.8', { send: 'none' });
  s.push(dbStep);
}
{
  const s = scene('relative_center_fine');
  s.say('00蝴蝶 15CM 1.8');
  s.push(call('settled'), dbStep);
}
// ---- 本地收件
{
  const s = scene('local_inbox_basic', { follow: { channel_id: '', author_ids: ['local:老王'], local_inbox: true }, readerProgram: null });
  s.push(call('start'), call('sync'), call('status'));
  const m = s.msg(FLY, { author: 'local:老王', channel: 'local' });
  m.author_name = '老王';
  s.expect(FLY);
  s.push({ op: 'inbox', i: 0, ev: 'message', msg: m, lastAt: '2026-08-14T14:31:59.000Z' }, call('pollInbox'), call('status'), call('stop'), call('status'), dbStep);
}
{
  const s = scene('local_inbox_off_and_stranger', { follow: { channel_id: '', author_ids: ['local:老王'], local_inbox: false } });
  s.push(call('start'), call('sync'), call('status'));
  s.push({ op: 'settings', patch: { follow: { ...FOLLOW_ON, channel_id: '', author_ids: ['local:老王'], local_inbox: true } } }, call('sync'));
  const m = s.msg(FLY, { author: 'local:路人', channel: 'local' });
  m.author_name = '路人';
  s.push({ op: 'inbox', i: 0, ev: 'message', msg: m }, call('status'), { op: 'inbox', i: 0, ev: 'error', error: '读不了收件文件' }, call('status'), call('stop'), dbStep);
}
// ---- 读窗口的程序
{
  const s = scene('reader_lifecycle', { follow: { channel_id: '', author_ids: ['local:老王'], local_inbox: true, local_channel: '老王的策略' }, readerProgram: '/opt/discord-window-follow' });
  s.push(call('start'), call('sync'), call('status'),
    { op: 'reader', i: 0, ev: 'status', state: 'reading', title: '#老王的策略 | 示例 - Discord' }, call('status'),
    call('sync'),
    { op: 'settings', patch: { follow: { ...FOLLOW_ON, channel_id: '', author_ids: ['local:老王'], local_inbox: true, local_channel: '另一个频道' } } }, call('sync'), call('status'),
    { op: 'settings', patch: { follow: { ...FOLLOW_ON, channel_id: '', author_ids: ['local:老王'], local_inbox: true, local_channel: '' } } }, call('sync'), call('status'),
    { op: 'settings', patch: { follow: { ...FOLLOW_ON, channel_id: '', author_ids: ['local:老王'], local_inbox: true, local_channel: '老王的策略' } } }, call('sync'), call('status'),
    { op: 'readerProgram', value: null }, call('sync'), call('status'),
    { op: 'reader', i: 1, ev: 'status', state: 'failed', error: '起不来' }, call('status'),
    call('stop'), call('status'), dbStep);
}
{
  const s = scene('reader_off_noname_unavailable', { follow: { channel_id: '', author_ids: ['local:老王'], local_inbox: false, local_channel: '老王的策略' }, readerProgram: '/opt/x' });
  s.push(call('start'), call('sync'), call('status'),
    { op: 'settings', patch: { follow: { ...FOLLOW_ON, channel_id: '', author_ids: ['local:老王'], local_inbox: true } } }, call('sync'), call('status'),
    { op: 'settings', patch: { follow: { ...FOLLOW_ON, channel_id: '', author_ids: ['local:老王'], local_inbox: true, local_channel: '老王的策略' } } },
    { op: 'readerProgram', value: null }, call('sync'), call('status'), call('stop'), dbStep);
}
{
  const s = scene('reader_not_started', { follow: { channel_id: '', author_ids: ['local:老王'], local_inbox: true, local_channel: '老王的策略' }, readerProgram: '/opt/x' });
  s.push(call('sync'), call('status'), dbStep);
}
// ---- 跟一单
{
  const s = scene('follow_one_sent');
  s.say(FLY);
  s.push(call('settled'), call('status'), dbStep);
}
{
  const s = scene('follow_two_accounts_one_rejected', { follow: { accounts: ['模拟', '主账户'] }, accounts: ['模拟', '主账户'] });
  s.say(FLY, { sentCount: 1, rejected: '实盘闸门没开' });
  s.push(call('settled'), dbStep);
}
{
  const s = scene('follow_duplicate_same_id');
  const m = s.msg(FLY, { id: 'dup1' });
  s.expect(FLY);
  s.push(call('onMessage', [m], { start: true, id: 'a' }), call('onMessage', [{ ...m }], { start: true, id: 'b' }), { op: 'await', id: 'a' }, { op: 'await', id: 'b' }, call('settled'), dbStep);
}
{
  const s = scene('follow_handled_in_db_across_service');
  const m = s.msg(FLY, { id: 'dup2' });
  s.expect(FLY);
  s.push(call('onMessage', [m]), { op: 'newService' }, call('onMessage', [m]), call('status'), dbStep);
}
{
  const s = scene('follow_queue_respects_daily_cap', { follow: { max_orders_per_day: 1 } });
  s.expect('2 挂40蝴蝶 10CM');
  const a = s.msg(FLY), b = s.msg('2 挂40蝴蝶 10CM');
  s.expect(FLY);
  s.push(call('onMessage', [a], { start: true, id: 'a' }), call('onMessage', [b], { start: true, id: 'b' }), { op: 'await', id: 'a' }, { op: 'await', id: 'b' }, call('settled'), call('status'), dbStep);
}
// ---- 不跟的那些
{
  const s = scene('skip_observe_only', { follow: { enabled: false } });
  s.say(FLY, { send: 'none' });
  s.push(call('settled'), call('status'), dbStep);
}
{
  const s = scene('skip_stranger_and_other_channel');
  s.say(FLY, { author: STRANGER, send: 'none' });
  s.say(FLY, { channel: '1100000000000000009', send: 'none' });
  s.push(call('status'), dbStep);
}
{
  const s = scene('skip_stale');
  s.say(FLY, { ageMs: 5 * 60_000, send: 'none' });
  s.push(call('status'), dbStep);
}
{
  const s = scene('skip_over_risk_cap');
  s.say('1.6 挂15蝴蝶 15CM 2张', { send: 'none' });
  s.push(call('settled'), dbStep);
}
{
  const s = scene('skip_unsupported_parts');
  s.say('1.8 挂15蝴蝶 15CM 跌破 6880 止损', { send: 'none' });
  s.push(dbStep);
}
{
  const s = scene('skip_gates_auto_execute_off', { settings: { policies: { auto_execute: false } } });
  s.say(FLY, { send: 'none' });
  s.push(call('settled'), dbStep);
}
{
  const s = scene('skip_gates_breaker', { breaker: { engaged: true, reason: '手动熔断' } });
  s.say(FLY, { send: 'none' });
  s.push({ op: 'breaker', set: { engaged: false } }, call('status'), dbStep);
}
{
  const s = scene('skip_gates_offline', { router: { sessions: false } });
  s.say(FLY, { send: 'none' });
  s.push({ op: 'router', set: { on: false } });
  s.say(FLY, { send: 'none' });
  s.push(dbStep);
}
{
  const s = scene('skip_unknown_account_alias', { follow: { accounts: ['改过名的账户'] } });
  s.fake('engine.resolveFanout', [err('plain', '账户别名「改过名的账户」不存在')]);
  s.say(FLY, { send: 'none' });
  s.push(dbStep);
}
{
  const s = scene('skip_no_spot_price');
  s.say('SPX 6915蝴蝶 15cm call 1.8', { noSnap: true, send: 'none' });
  s.push(dbStep);
}
{
  const s = scene('engine_rejects_validation');
  s.say('0.5 挂15蝴蝶 15CM 2张', { send: 'rejected', reason: '张数超过限额' });
  s.push(call('settled'), dbStep);
}
{
  const s = scene('engine_held_validated_only');
  s.say(FLY, { send: 'held' });
  s.push(call('settled'), dbStep);
}
{
  const s = scene('engine_throws_and_queued');
  s.say(FLY, { err: '券商断了' });
  s.say('2 挂40蝴蝶 10CM', { queued: true });
  s.push(call('settled'), dbStep);
}
// ---- 大模型在这条路上不出场
{
  const s = scene('model_refused_in_follow_scope');
  s.say(FLY, { send: { parse: true } });
  s.push(call('status'), dbStep);
}
{
  const s = scene('model_used_is_audited');
  s.say(FLY, { llm: { model: 'claude-opus-5' } });
  s.say('2 挂40蝴蝶 10CM', { llm: { model: 'local-shorthand' } });
  s.push(call('settled'), dbStep);
}
{
  const s = scene('engine_returns_no_llm_key', { divergent: true });
  s.say(FLY, { send: { submitted: [], noLlmKey: true, rejections: [{ message: '怪' }] } });
  s.push(dbStep);
}

// ---- Discord 连接的起停
const KEY = '跟单-token';
const TOKEN_VAULT = { 'dafri-discord-bot/token': 'bot.token.value' };
{
  const s = scene('gateway_not_started', { vault: TOKEN_VAULT });
  s.push(call('sync'), call('status'), dbStep);
}
{
  const s = scene('gateway_no_channel', { vault: TOKEN_VAULT, follow: { channel_id: '', enabled: false } });
  s.push(call('start'), call('sync'), call('status'), call('stop'), dbStep);
}
{
  const s = scene('gateway_no_token', {});
  s.push(call('start'), call('sync'), call('status'), call('stop'), dbStep);
}
{
  const s = scene('gateway_full_flow', { vault: TOKEN_VAULT });
  const m = s.msg(FLY, { id: 'g1' });
  s.expect(FLY);
  s.push(call('start'), call('sync'),
    { op: 'gw', i: 0, ev: 'phase', phase: 'connecting', error: '网络抖了' }, call('status'),
    { op: 'gw', i: 0, ev: 'set', bot: 'follow-bot' }, { op: 'gw', i: 0, ev: 'phase', phase: 'ready' }, call('status'),
    { op: 'gw', i: 0, ev: 'set', guildsSeen: true, channels: ['1100000000000000009'] }, call('status'),
    { op: 'gw', i: 0, ev: 'set', channels: ['1100000000000000009', CH] }, call('status'),
    { op: 'gw', i: 0, ev: 'message', msg: m }, call('onMessage', [m]), call('settled'), call('status'),
    { op: 'gw', i: 0, ev: 'phase', phase: 'connecting' }, call('status'),
    { op: 'gw', i: 0, ev: 'phase', phase: 'stopped' }, call('status'),
    call('stop'), call('status'), dbStep);
}
{
  const s = scene('gateway_failed_notifies', { vault: TOKEN_VAULT });
  s.push(call('start'), call('sync'), { op: 'gw', i: 0, ev: 'phase', phase: 'failed', error: '没开 Message Content Intent' }, call('status'),
    { op: 'gw', i: 0, ev: 'phase', phase: 'failed', error: null }, call('status'), call('stop'), dbStep);
}
{
  const s = scene('gateway_set_token_reconnects', { vault: TOKEN_VAULT });
  s.push(call('start'), call('sync'), call('setToken', ['new.token.value']), call('status'),
    { op: 'gw', i: 0, ev: 'phase', phase: 'ready' }, // 旧的连接已经被丢掉:它再递来的东西不算
    { op: 'gw', i: 1, ev: 'phase', phase: 'ready' }, call('status'), call('stop'), dbStep);
}
{
  const s = scene('gateway_channel_cleared', { vault: TOKEN_VAULT });
  s.push(call('start'), call('sync'), { op: 'settings', patch: { follow: { ...FOLLOW_ON, channel_id: '' } } }, call('sync'), call('status'),
    { op: 'settings', patch: { follow: FOLLOW_ON } }, call('sync'), call('sync', [true]), call('status'), call('stop'), dbStep);
}
{
  const s = scene('gateway_secret_failures', {
    vault: TOKEN_VAULT,
    fakes: { 'secret.read': [err('plain', '钥匙串没点允许'), {}], 'secret.exists': [{ delay: 50 }, {}] },
  });
  s.push(call('start'), call('sync'), call('status'), call('sync'), call('status'), call('sync', [true]), call('status'), call('stop'), dbStep);
}
{
  const s = scene('gateway_token_empty_or_vanishes', { vault: { 'dafri-discord-bot/token': '' } });
  s.push(call('start'), call('sync'), call('status'),
    { op: 'settings', patch: { follow: { ...FOLLOW_ON, channel_id: '' } } }, call('sync', [true]), call('status'), call('stop'), dbStep);
}
{
  const s = scene('gateway_stop_while_reading_token', { vault: TOKEN_VAULT, fakes: { 'secret.read': [{ delay: 100 }] } });
  s.push(call('start'), call('sync', [], { start: true, id: 's' }), adv(50), call('stop'), { op: 'await', id: 's' }, call('status'), dbStep);
}

// ---- 延迟的代价
{
  const s = scene('quote_after_sent');
  s.say(FLY);
  s.push(call('settled'), call('status'), dbStep);
}
{
  const s = scene('quote_observe_only_lag', { follow: { enabled: false } });
  s.say(FLY, { ageMs: 6400, send: 'none' });
  s.push(call('settled'), dbStep);
}
{
  const s = scene('quote_outcomes_quoted_or_not');
  s.say('1.6 挂15蝴蝶 15CM 2张', { send: 'none' });
  s.push({ op: 'breaker', set: { engaged: true, reason: '手动熔断' } });
  s.say(FLY, { send: 'none' });
  s.push({ op: 'breaker', set: { engaged: false } }, call('settled'));
  s.say('15蝴蝶 15CM', { send: 'none' });
  s.say('1.8 挂15蝴蝶 15CM 跌破 6880 止损', { send: 'none' });
  s.say(FLY, { ageMs: 5 * 60_000, send: 'none' });
  s.say('蝴蝶先走一下', { send: 'none' });
  s.push(call('settled'), dbStep);
}
{
  const s = scene('quote_credit_live_session', { router: { managed: ['U1234567'] } });
  s.say(CREDIT);
  s.push(call('settled'), dbStep);
}
for (const [i, fail] of [
  { 'marks.read': [err('broker', '引擎未连接 TWS。')] },
  { 'marks.read': [err('plain', '意料之外的错')] },
  { 'marks.read': [err('marks', 'TWS 没回合约确认')] },
  { book: { 6900: { bid: 19.9, ask: 20.3 }, 6915: { bid: 10.9, ask: 11.1 }, 6930: { bid: 0, ask: 0.05 } } },
  { book: { 6900: { bid: 19.9, ask: 20.3 }, 6915: { bid: null, ask: null }, 6930: { bid: 3.7, ask: 3.9 } } },
  { router: { noSession: true } },
].entries()) {
  const s = scene(`quote_failure_${i}`, { fakes: fail['marks.read'] ? { 'marks.read': fail['marks.read'] } : {}, book: fail.book, router: fail.router });
  s.say(FLY);
  s.push(call('settled'), dbStep);
}
{
  const s = scene('quote_not_taken_offline_or_unwired', { follow: { enabled: false } });
  s.push({ op: 'router', set: { sessions: false } });
  s.say(FLY, { send: 'none' });
  s.push(call('settled'), { op: 'router', set: { sessions: true } }, { op: 'newService' });
  const u = scene('quote_unwired', { unwired: true });
  u.say(FLY);
  u.push(call('settled'), dbStep);
  s.push(dbStep);
}
{
  const s = scene('quote_gate_does_not_block_next_message', { fakes: { 'marks.read': [ok([{ strike: 6900, right: 'C', bid: 19.9, ask: 20.3, iv: null, error: null }, { strike: 6915, right: 'C', bid: 10.9, ask: 11.1, iv: null, error: null }, { strike: 6930, right: 'C', bid: 3.7, ask: 3.9, iv: null, error: null }], 5000), ok([{ strike: 6925, right: 'C', bid: 6.8, ask: 7.2, iv: null, error: null }, { strike: 6920, right: 'C', bid: 9.0, ask: 9.4, iv: null, error: null }])] } });
  s.say(FLY);
  s.say(CREDIT);
  s.push(call('status'), call('settled'), call('status'), dbStep);
}
{
  const s = scene('quote_paper_mixed_sessions', { router: { managed: ['DU1', 'U2'] } });
  s.say(FLY);
  s.push(call('settled'), dbStep);
}

// ---- 成交之后自动建追踪
const trackOn = { track_fly: true };
const fill = (alias, n, qty, done) => [
  { op: 'store', m: 'appendEvent', a: [{ $ref: alias }, 'fill', { exec_id: `exec-${alias}-${n}-${qty}-${done}`, price: 1.8, qty, sec_type: 'BAG' }] },
  ...(done ? [{ op: 'store', m: 'appendEvent', a: [{ $ref: alias }, 'status', { status: 'Filled', order_id: 1024 + n, perm_id: 7700 + n }] }] : []),
];
const posRows = (rows) => ({ op: 'fake', key: 'router.positions', list: [ok(rows)] });
{
  const s = scene('track_default_off', { follow: {} });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_registered_waits_for_fill', { follow: { track_fly: true, track_exit_at: '15:45' } });
  s.say(FLY);
  s.push(call('status'), posRows(flyRows()), call('trackTick'), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_created_after_fill', { follow: { track_fly: true, track_exit_at: '15:45' } });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), call('trackTick'), call('status'), call('trackTick'), call('trackTick'), dbStep);
}
{
  const s = scene('track_partial_fill_creates_immediately', { follow: { track_fly: true, max_risk_usd: 1000 } });
  s.say('0.5 挂15蝴蝶 15CM 2张');
  s.push(...fill('r1', 1, 1, false), posRows(flyRows(1)), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_partial_then_rest_absorbed', { follow: { track_fly: true, max_risk_usd: 1000 } });
  s.say('0.5 挂15蝴蝶 15CM 2张');
  s.push(...fill('r1', 1, 1, false), posRows(flyRows(1)),
    { op: 'store', m: 'addTrack', a: [{ account: '别的账户', symbol: 'SPX', sec_type: 'BAG', leg: FLY_LEG, contract: {}, targets: {}, auto_close: {}, peak: null, note: '' }] },
    call('trackTick'), { op: 'store', m: 'getPref', a: ['follow.pending_tracks'] },
    { op: 'store', m: 'addTrack', a: [{ account: '模拟', symbol: 'SPX', sec_type: 'BAG', leg: FLY_LEG, contract: {}, targets: {}, auto_close: { enabled: true }, peak: null, note: '' }] },
    ...fill('r1', 1, 2, false), call('trackTick'), { op: 'store', m: 'getPref', a: ['follow.pending_tracks'] },
    { op: 'store', m: 'appendEvent', a: [{ $ref: 'r1' }, 'status', { status: 'Filled', order_id: 1025, perm_id: 7701 }] }, call('trackTick'),
    { op: 'store', m: 'getPref', a: ['follow.pending_tracks'] }, call('status'), dbStep);
}
{
  const s = scene('track_partial_then_late_fill_after_fired', { follow: { track_fly: true, max_risk_usd: 1000 } });
  s.say('0.5 挂15蝴蝶 15CM 2张');
  s.push(...fill('r1', 1, 1, false), posRows(flyRows(1)), call('trackTick'),
    { op: 'store', m: 'addTrack', a: [{ account: '模拟', symbol: 'SPX', sec_type: 'BAG', leg: FLY_LEG, contract: {}, targets: {}, auto_close: { enabled: true }, peak: null, note: '' }], as: 'trk' },
    { op: 'store', m: 'updateTrack', a: [{ $ref: 'trk' }, { enabled: false, fired_at: '2026-08-14T11:05:00', fired_state: 'profit_trail' }] },
    call('trackTick'), ...fill('r1', 1, 2, true), call('trackTick'), call('trackTick'), { op: 'store', m: 'getPref', a: ['follow.pending_tracks'] }, dbStep);
}
{
  const s = scene('track_fill_before_positions', { follow: trackOn });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), call('trackTick'), call('status'), posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_credit_spread_not_registered', { follow: trackOn });
  s.say(CREDIT);
  s.push(call('status'), ...fill('r1', 1, 1, true), call('trackTick'), dbStep);
}
{
  const s = scene('track_observe_only_not_registered', { follow: { track_fly: true, enabled: false } });
  s.say(FLY, { send: 'none' });
  s.push(call('status'), dbStep);
}
{
  const s = scene('track_order_cancelled_unfilled', { follow: trackOn });
  s.say(FLY);
  s.push({ op: 'store', m: 'appendEvent', a: [{ $ref: 'r1' }, 'status', { status: 'Cancelled', order_id: 1025, perm_id: 7701 }] }, { op: 'store', m: 'setFinalStatus', a: [{ $ref: 'r1' }, 'cancelled'] },
    posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_restart_picks_up', { follow: trackOn });
  s.say(FLY);
  s.push({ op: 'newService' }, call('status'), ...fill('r1', 1, 1, true), posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_positions_unreadable_then_covered', { follow: trackOn });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), { op: 'fake', key: 'router.positions', list: [err('broker', 'TWS 断了,读不到持仓')] },
    ...Array(7).fill(call('trackTick')), call('status'), posRows(flyRows()), { op: 'router', set: { covered: ['主账户'] } }, call('trackTick'), call('status'),
    { op: 'router', set: { covered: ['模拟', '主账户'] } }, call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_add_refused_once', { follow: trackOn, fakes: { 'follow.addTrack': [err('rpc', '找不到这个持仓(可能刚刚被平掉了),请刷新持仓列表。', 0, -32602)] } });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), call('trackTick'), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_exit_at_unusable_retries_without', {
    follow: { track_fly: true, track_exit_at: '15:45' },
    fakes: { 'follow.addTrack': [err('rpc', '到点平仓「15:45」下一次到点是美东 08/15 15:45,而这份持仓 08/14 16:00 就到期了——那时它已经不在了。', 0, -32602), ok({ track: { id: 't1', targets: { exit_at: null, exit_at_ms: null }, auto_close: { enabled: true } } })] },
  });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_exit_at_unusable_second_also_fails', {
    follow: { track_fly: true, track_exit_at: '15:45' },
    fakes: { 'follow.addTrack': [err('rpc', '到点平仓「15:45」不行', 0, -32602), err('plain', '又炸了')] },
  });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), call('trackTick'), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_add_transient_failure_then_ok', { follow: trackOn, fakes: { 'follow.addTrack': [err('rpc', '读取持仓需要 TWS / IB Gateway', 0, -32018), ok({ track: track('t2', '') })] } });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), call('trackTick'), call('status'), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_add_stuck_gives_up', { follow: trackOn, fakes: { 'follow.addTrack': [err('plain', '意料之外的错')] } });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), ...Array(12).fill(call('trackTick')), call('status'), dbStep);
}
{
  const s = scene('track_unwired_channel', { follow: trackOn, unwired: true });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_already_active_track_covers', { follow: trackOn });
  s.push({ op: 'store', m: 'addTrack', a: [{ account: '模拟', symbol: 'SPX', sec_type: 'BAG', leg: FLY_LEG, contract: {}, targets: { stop_loss: 0.9 }, auto_close: { enabled: true }, peak: null, note: '自己设的' }] });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows(2)), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_idle_old_track_blocks', { follow: trackOn });
  s.push({ op: 'store', m: 'addTrack', a: [{ account: '模拟', symbol: 'SPX', sec_type: 'BAG', leg: FLY_LEG, contract: {}, targets: {}, auto_close: { enabled: true }, peak: null, note: '' }], as: 'old' },
    { op: 'store', m: 'updateTrack', a: [{ $ref: 'old' }, { enabled: false, fired_at: '2026-08-14T09:50:00', fired_state: 'profit_trail' }] });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), call('trackTick'), call('status'), { op: 'store', m: 'listTracks', a: [] }, dbStep);
}
{
  const s = scene('track_position_never_found', { follow: trackOn });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows([legRow(6900, 1, 2000, 20.1), legRow(6915, -1, 1100, 11), legRow(6930, -1, 380, 3.8), legRow(6945, 1, 90, 0.9)]),
    ...Array(4).fill(call('trackTick')), call('status'), call('trackTick'), call('status'), dbStep);
}
for (const [i, off] of [{ enabled: false }, { track_fly: false }].entries()) {
  const s = scene(`track_authorization_withdrawn_${i}`, { follow: trackOn });
  s.say(FLY);
  s.push({ op: 'settings', patch: { follow: { ...FOLLOW_ON, track_fly: true, ...off } } }, ...fill('r1', 1, 1, true), posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_expires_after_a_day', { follow: trackOn });
  s.say(FLY);
  s.push(adv(24 * 3600_000), posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_timer_loop', { follow: trackOn, vault: {} });
  s.push(call('start'), adv(10_000));
  s.say(FLY);
  s.push(call('settled'), adv(10_000), ...fill('r1', 1, 1, false), adv(7_000), posRows(flyRows()), adv(4_000), adv(30_000), call('stop'), adv(30_000), dbStep);
}
{
  const s = scene('track_timer_restart_picks_up', { follow: trackOn });
  s.say(FLY);
  s.push({ op: 'newService' }, ...fill('r1', 1, 1, true), posRows(flyRows()), call('start'), adv(4_000), call('stop'), adv(30_000), dbStep);
}
{
  const s = scene('track_two_accounts', { follow: { track_fly: true, accounts: ['模拟', '主账户'] }, accounts: ['模拟', '主账户'], settings: { policies: { auto_execute: true, allow_live_trading: true } } });
  s.say(FLY);
  s.push(call('status'), ...fill('r2', 2, 1, true), posRows(flyRows(1, '主账户')), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_pref_read_failures', { follow: trackOn });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), { op: 'store', m: 'rawExec', a: ["CREATE TRIGGER no_prefs_update BEFORE UPDATE ON app_prefs BEGIN SELECT RAISE(ABORT, '库写不了'); END"] },
    call('trackTick'), call('status'), { op: 'store', m: 'rawExec', a: ['DROP TRIGGER no_prefs_update'] }, call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('process_error_is_logged', { follow: {}, divergent: true });
  s.push({ op: 'store', m: 'rawExec', a: ["CREATE TRIGGER no_follow_log BEFORE INSERT ON follow_log BEGIN SELECT RAISE(ABORT, '跟单日志写不了'); END"] });
  s.say(FLY);
  s.push(call('settled'), { op: 'store', m: 'rawExec', a: ['DROP TRIGGER no_follow_log'] }, dbStep);
}


// ---- 变异检验补的用例(幸存者逐个对应)
{
  const s = scene('seen_list_is_capped_at_30');
  for (let i = 0; i < 33; i += 1) s.say('蝴蝶先走一下', { send: 'none' });
  s.push(call('status'), dbStep);
}
{
  const s = scene('track_exit_rejection_with_other_code_retries', { follow: { track_fly: true, track_exit_at: '15:45' }, fakes: { 'follow.addTrack': [err('rpc', '到点平仓「15:45」读不到持仓', 0, -32018)] } });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_exit_rejection_without_exit_configured', { follow: trackOn, fakes: { 'follow.addTrack': [err('rpc', '到点平仓「」不行', 0, -32602), ok({ track: track('t9', '') })] } });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
const finalOf = (alias, status) => ({ op: 'store', m: 'setFinalStatus', a: [{ $ref: alias }, status] });
{
  const s = scene('track_final_but_position_missing', { follow: trackOn });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), finalOf('r1', 'filled'), posRows([]), ...Array(4).fill(call('trackTick')), call('status'), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_final_unfilled_then_filled_by_timeline', { follow: trackOn });
  s.say(FLY);
  s.push({ op: 'store', m: 'appendEvent', a: [{ $ref: 'r1' }, 'status', { status: 'Filled', order_id: 1025, perm_id: 7701 }] }, posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_filled_by_final_status_only', { follow: trackOn });
  s.say(FLY);
  s.push(finalOf('r1', 'filled'), posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_partially_filled_final_status', { follow: trackOn });
  s.say(FLY);
  s.push(finalOf('r1', 'partially_filled'), posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_final_rejected_not_filled', { follow: trackOn });
  s.say(FLY);
  s.push(finalOf('r1', 'ibkr_error'), posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('quote_session_manages_no_accounts', { router: { managed: [] } });
  s.say(FLY);
  s.push(call('settled'), dbStep);
}
{
  const s = scene('gateway_dropped_one_cannot_deliver', { vault: TOKEN_VAULT });
  const m = s.msg(FLY, { id: 'old1' });
  s.expect(FLY);
  s.push(call('start'), call('sync'), call('setToken', ['new.token.value']),
    { op: 'gw', i: 0, ev: 'message', msg: m }, call('settled'), call('status'),
    { op: 'gw', i: 0, ev: 'phase', phase: 'failed', error: '旧的' }, call('status'), dbStep);
}
{
  const s = scene('inbox_dropped_one_cannot_deliver', { follow: { channel_id: '', author_ids: ['local:老王'], local_inbox: true } });
  s.push(call('start'), call('sync'), { op: 'settings', patch: { follow: { ...FOLLOW_ON, channel_id: '', author_ids: ['local:老王'], local_inbox: false } } }, call('sync'));
  const m = s.msg(FLY, { author: 'local:老王', channel: 'local' });
  m.author_name = '老王';
  s.expect(FLY);
  s.push({ op: 'inbox', i: 0, ev: 'message', msg: m }, { op: 'inbox', i: 0, ev: 'error', error: '旧的' }, call('settled'), call('status'), dbStep);
}
{
  const s = scene('track_new_pending_registered_during_a_tick', { follow: trackOn });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), { op: 'fake', key: 'router.positions', list: [ok(flyRows(), 500)] },
    call('trackTick', [], { start: true, id: 'tick' }), adv(100));
  s.say('2 挂40蝴蝶 10CM', { start: 'm2' });
  s.push(adv(100), { op: 'await', id: 'm2' }, { op: 'await', id: 'tick' }, call('status'), dbStep);
}
{
  const s = scene('track_withdrawn_only_settled_items', { follow: { track_fly: true, max_risk_usd: 1000 } });
  s.say('0.5 挂15蝴蝶 15CM 2张');
  s.push(...fill('r1', 1, 1, false), posRows(flyRows(1)), call('trackTick'),
    { op: 'settings', patch: { follow: { ...FOLLOW_ON, track_fly: false, max_risk_usd: 1000 } } }, call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('track_withdrawn_mixed_items', { follow: { track_fly: true, max_risk_usd: 1000 } });
  s.say('0.5 挂15蝴蝶 15CM 2张');
  s.push(...fill('r1', 1, 1, false), posRows(flyRows(1)), call('trackTick'));
  s.say('2 挂40蝴蝶 10CM');
  s.push({ op: 'settings', patch: { follow: { ...FOLLOW_ON, track_fly: false, max_risk_usd: 1000 } } }, call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('log_row_already_exists_when_concluding', { fakes: {} });
  const m = s.msg(FLY, { id: 'race1' });
  s.expect(FLY, { delay: 500 });
  s.push(call('onMessage', [m], { start: true, id: 'a' }), adv(100),
    { op: 'store', m: 'follow.add', a: [{ at: '2026-08-14T14:32:00+00:00', message_id: 'race1', author_id: FRIEND, author_name: '老王', text: FLY, outcome: 'observed', detail: '', summary: '', record_ids: [] }] },
    { op: 'await', id: 'a' }, call('settled'), call('status'), dbStep);
}
{
  const s = scene('record_without_order_falls_back_to_payload');
  s.say(FLY, { recordNoOrder: true });
  s.push(call('settled'), dbStep);
}
{
  const s = scene('payload_with_empty_symbol');
  const p = s.parsed(FLY).payload;
  const odd = JSON.parse(JSON.stringify(p));
  odd.orders[0].contract.symbol = '';
  s.say(FLY, { payloadOverride: odd, snapOverride: { '': 6907.35 }, send: 'none' });
  s.push(dbStep);
}
{
  const s = scene('engine_summary_differs_from_ours');
  s.say(FLY, { intentSummary: '引擎自己的摘要' });
  s.push(call('settled'), dbStep);
}

{
  const s = scene('track_pending_record_missing_in_store', { follow: trackOn });
  s.push({ op: 'store', m: 'setPref', a: ['follow.pending_tracks', [{ record_id: 'ghost', message_id: 'g1', account: '模拟', symbol: 'SPX', leg: FLY_LEG, summary: '幽灵单', at_ms: NOW }]] },
    posRows(flyRows()), call('trackTick'), call('status'), { op: 'store', m: 'getPref', a: ['follow.pending_tracks'] }, dbStep);
}

{
  const s = scene('reader_dropped_one_cannot_report', { follow: { channel_id: '', author_ids: ['local:老王'], local_inbox: true, local_channel: '老王的策略' }, readerProgram: '/opt/discord-window-follow' });
  s.push(call('start'), call('sync'),
    { op: 'settings', patch: { follow: { ...FOLLOW_ON, channel_id: '', author_ids: ['local:老王'], local_inbox: true, local_channel: '另一个频道' } } }, call('sync'),
    { op: 'reader', i: 0, ev: 'status', state: 'reading', title: '旧的' }, call('status'),
    { op: 'settings', patch: { follow: { ...FOLLOW_ON, channel_id: '', author_ids: ['local:老王'], local_inbox: true, local_channel: '' } } }, call('sync'),
    { op: 'reader', i: 0, ev: 'status', state: 'waiting', title: '更旧的' }, { op: 'reader', i: 1, ev: 'status', state: 'reading', title: '也是旧的' }, call('status'), dbStep);
}
{
  const s = scene('track_timer_stops_when_prefs_unreadable', { follow: trackOn, vault: {} });
  s.push(call('start'), adv(5000));
  s.say(FLY);
  s.push(call('settled'), { op: 'store', m: 'rawExec', a: ['DROP TABLE app_prefs'] }, adv(4000), adv(10000), dbStep);
}
{
  const s = scene('track_partial_fill_open_order_position_missing', { follow: trackOn });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, false), posRows([]), ...Array(8).fill(call('trackTick')), call('status'), dbStep);
}
{
  const s = scene('track_unreadable_positions_with_final_order', { follow: trackOn });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), finalOf('r1', 'filled'), { op: 'fake', key: 'router.positions', list: [err('broker', '断了')] }, ...Array(8).fill(call('trackTick')), call('status'),
    posRows(flyRows()), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('pending_save_fails_when_registering', { follow: trackOn });
  s.push({ op: 'store', m: 'rawExec', a: ["CREATE TRIGGER no_prefs_insert BEFORE INSERT ON app_prefs BEGIN SELECT RAISE(ABORT, '偏好写不了'); END"] });
  s.say(FLY);
  s.push(call('settled'), call('status'), dbStep);
}

{
  const s = scene('track_one_item_fails_to_settle', { follow: trackOn });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), { op: 'store', m: 'rawExec', a: ['DROP TABLE position_tracks'] }, call('trackTick'), call('status'), dbStep);
}

{
  const s = scene('track_settled_record_missing_in_store', { follow: trackOn });
  s.push({ op: 'store', m: 'setPref', a: ['follow.pending_tracks', [{ record_id: 'ghost2', message_id: 'g2', account: '模拟', symbol: 'SPX', leg: FLY_LEG, summary: '幽灵单二', at_ms: NOW, settled_fills: 0 }]] },
    call('trackTick'), call('status'), { op: 'store', m: 'getPref', a: ['follow.pending_tracks'] }, dbStep);
}

// ---- 发单之后出错(C++ 与 TS 有意不同,不对拍;tst_svc_follow 的 postSubmit* 直接断言)
{
  const s = scene('post_submit_llm_key_missing', { divergent: true });
  s.say(FLY, { send: { submitted: [{ account: '模拟', intent_summary: '摘要', as: 'r1', record: { contract: s.parsed(FLY).payload.orders[0].contract, order: s.parsed(FLY).payload.orders[0].order } }], noLlmKey: true } });
  s.push(call('settled'), call('status'), dbStep);
}
{
  const s = scene('post_submit_audit_throws_in_finish', { divergent: true });
  s.push({ op: 'store', m: 'rawExec', a: ["CREATE TRIGGER no_signal_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'follow_signal' BEGIN SELECT RAISE(ABORT, '审计写不了'); END"] });
  s.say(FLY);
  s.push(call('settled'), call('status'), dbStep);
}
{
  const s = scene('post_submit_follow_add_throws', { divergent: true });
  s.push({ op: 'store', m: 'rawExec', a: ["CREATE TRIGGER no_follow_row BEFORE INSERT ON follow_log BEGIN SELECT RAISE(ABORT, '跟单日志写不了'); END"] });
  const m = s.msg(FLY, { id: 'again1' });
  s.expect(FLY);
  s.push(call('onMessage', [m]), call('settled'), call('onMessage', [{ ...m }]), call('settled'), dbStep);
}

{
  const s = scene('post_submit_outcome_throws', { divergent: true });
  s.say(FLY, { send: { raw: { submitted: [{ account: '模拟', record_id: 'rec-x', intent_summary: '摘要' }, null], queued: [], validated_only: [], rejections: [], warnings: [], llm: null } } });
  s.push(call('settled'), call('status'), dbStep);
}

{
  const s = scene('track_refused_with_exit_configured_not_retried', {
    follow: { track_fly: true, track_exit_at: '15:45' },
    fakes: { 'follow.addTrack': [err('rpc', '找不到这个持仓(可能刚刚被平掉了),请刷新持仓列表。', 0, -32602), ok({ track: track('t9', '') })] },
  });
  s.say(FLY);
  s.push(...fill('r1', 1, 1, true), posRows(flyRows()), call('trackTick'), call('trackTick'), call('status'), dbStep);
}
{
  const s = scene('post_submit_log_row_retried_once', { divergent: true });
  s.push({ op: 'store', m: 'rawExec', a: ["CREATE TRIGGER first_follow_row_fails BEFORE INSERT ON follow_log WHEN (SELECT COUNT(*) FROM audit_log WHERE action = 'follow_post_submit_error') = 0 BEGIN SELECT RAISE(ABORT, '跟单日志第一次写不了'); END"] });
  s.say(FLY);
  s.push(call('settled'), call('status'), dbStep);
}

{
  const s = scene('post_submit_retry_with_audit_also_failing', { divergent: true });
  s.push({ op: 'store', m: 'rawExec', a: ["CREATE TRIGGER first_follow_row_fails2 BEFORE INSERT ON follow_log WHEN (SELECT COUNT(*) FROM audit_log WHERE action = 'follow_post_submit_error') = 0 BEGIN SELECT RAISE(ABORT, '跟单日志第一次写不了'); END"] },
    { op: 'store', m: 'rawExec', a: ["CREATE TRIGGER no_signal_audit2 BEFORE INSERT ON audit_log WHEN NEW.action = 'follow_signal' BEGIN SELECT RAISE(ABORT, '审计写不了'); END"] });
  s.say(FLY);
  s.push(call('settled'), call('status'), dbStep);
}
{
  const s = scene('status_recent_is_30');
  for (let i = 0; i < 33; i += 1) s.say(FLY, { ageMs: 400_000, send: 'none' });
  s.push(call('status'), dbStep);
}

{
  const s = scene('status_seen_trust_is_recomputed');
  s.say(FLY, { send: 'none' });
  s.push({ op: 'settings', patch: { follow: { ...FOLLOW_ON, author_ids: [STRANGER] } } }, call('status'), dbStep);
}

// ---------------------------------------------------------------- 随机交错
const CORPUS = [
  [FLY, SPOT], ['@everyone 1.8 挂15蝴蝶 15CM', SPOT], [CREDIT, SPOT], ['2 挂40蝴蝶 10CM', SPOT], ['1.6 挂15蝴蝶 15CM 2张', SPOT], ['0.5 挂15蝴蝶 15CM 2张', SPOT],
  ['15蝴蝶 15CM', SPOT], ['00蝴蝶 15CM 1.8', { SPX: 6990 }], ['7000蝴蝶 15CM 1.8', { SPX: 6990 }], ['20 25可以挂个-2 -2.5', SPOT], ['7770 7775 bear call', SPOT],
  ['蝴蝶先走一下', SPOT], ['今天感觉要大跌', SPOT], ['1.8 挂15蝴蝶 15CM 跌破 6880 止损', SPOT], ['SPX 6915蝴蝶 15cm call 1.8', SPOT], ['1.2 挂5蝴蝶 5CM', SPOT],
];

function randomScene(seed) {
  const r = rng(seed * 977);
  const accounts = r.chance(0.3) ? ['模拟', '主账户'] : ['模拟'];
  const s = new Scene(`random_${seed}`, {
    start: NOW + r.int(3) * 600_000, vault: r.chance(0.8) ? TOKEN_VAULT : {}, accounts,
    follow: { track_fly: r.chance(0.7), track_exit_at: r.chance(0.5) ? '15:45' : '', max_orders_per_day: 1 + r.int(4), accounts, ...(r.chance(0.2) ? { enabled: false } : {}), local_inbox: r.chance(0.4), local_channel: r.chance(0.3) ? '老王的策略' : '' },
    settings: { policies: { auto_execute: r.chance(0.9), allow_live_trading: r.chance(0.5) } },
    readerProgram: r.chance(0.6) ? '/opt/discord-window-follow' : null, unwired: r.chance(0.1),
    router: { sessions: r.chance(0.9), managed: [r.chance(0.7) ? 'DU7654321' : 'U1234567'] },
  });
  s.script.fakes['marks.read'] = undefined;
  delete s.script.fakes['marks.read'];
  let clock = s.script.start;
  const lastRec = () => (s.recs > 0 ? `r${1 + r.int(s.recs)}` : 'r1');
  let gws = 0, inboxes = 0, readers = 0, fills = 0;
  const n = 40 + r.int(30);
  s.push(call('start'));
  for (let i = 0; i < n; i += 1) {
    const roll = r.next();
    if (roll < 0.30) {
      const [content, spots] = CORPUS[r.int(CORPUS.length)];
      const o = { spots, author: r.chance(0.12) ? STRANGER : FRIEND, ageMs: r.chance(0.1) ? 400_000 : 500 + r.int(5000), at: clock, channel: r.chance(0.05) ? '1100000000000000009' : CH };
      const mode = r.next();
      if (mode < 0.08) o.send = 'held';
      else if (mode < 0.14) o.send = 'rejected';
      else if (mode < 0.18) o.err = '券商断了';
      else if (mode < 0.21) o.parse = true;
      if (r.chance(0.15)) o.delay = 50 + r.int(2000);
      s.say(content, o);
    } else if (roll < 0.42) {
      s.push(call('trackTick'));
    } else if (roll < 0.52) {
      const a = lastRec();
      fills += 1;
      s.push(...fill(a, fills, 1 + r.int(2), r.chance(0.6)));
    } else if (roll < 0.58) {
      s.push(posRows(r.chance(0.2) ? [] : flyRows(1 + r.int(2), r.chance(0.7) ? '模拟' : '主账户')));
    } else if (roll < 0.66) {
      clock += [1000, 3000, 3000, 10_000, 60_000][r.int(5)];
      s.push(adv([1000, 3000, 3000, 10_000, 60_000][r.int(5)]));
    } else if (roll < 0.70) {
      s.push(call('status'));
    } else if (roll < 0.74) {
      s.push(call(['sync', 'start', 'stop', 'settled'][r.int(4)], []));
    } else if (roll < 0.77) {
      s.push({ op: 'breaker', set: { engaged: r.chance(0.4), reason: '手动熔断' } });
    } else if (roll < 0.80) {
      const patch = { follow: { ...FOLLOW_ON, enabled: r.chance(0.8), track_fly: r.chance(0.7), track_exit_at: r.chance(0.5) ? '15:45' : '', accounts, local_inbox: r.chance(0.4), local_channel: r.chance(0.3) ? '老王的策略' : '', max_orders_per_day: 1 + r.int(4), channel_id: r.chance(0.85) ? CH : '' }, policies: { auto_execute: r.chance(0.9), allow_live_trading: r.chance(0.5) } };
      s.push({ op: 'settings', patch });
    } else if (roll < 0.83) {
      gws += 1;
      s.push({ op: 'gw', i: r.int(Math.max(1, gws)), ev: 'phase', phase: ['connecting', 'ready', 'failed', 'stopped'][r.int(4)], error: r.chance(0.5) ? '网络抖了' : null });
    } else if (roll < 0.86) {
      s.push({ op: 'router', set: { sessions: r.chance(0.85), covered: r.chance(0.3) ? ['主账户'] : (r.chance(0.5) ? ['模拟', '主账户'] : null) } });
    } else if (roll < 0.88) {
      s.push(call('setToken', ['t' + i]));
    } else if (roll < 0.90) {
      s.push({ op: 'newService' });
    } else if (roll < 0.93) {
      inboxes += 1;
      const [content] = CORPUS[r.int(CORPUS.length)];
      const m = s.msg(content, { author: 'local:老王', channel: 'local', at: clock });
      m.author_name = '老王';
      s.expect(content, { at: clock });
      s.push({ op: 'inbox', i: r.int(3), ev: 'message', msg: m });
    } else if (roll < 0.95) {
      s.push({ op: 'reader', i: r.int(3), ev: 'status', state: ['reading', 'waiting', 'failed'][r.int(3)], title: null, error: r.chance(0.3) ? '起不来' : null });
    } else if (roll < 0.97) {
      s.push({ op: 'readerProgram', value: r.chance(0.5) ? '/opt/discord-window-follow' : null });
    } else {
      s.push(call('pollInbox'));
    }
  }
  s.push(call('settled'), call('status'), dbStep);
  void readers;
  return s;
}

for (let seed = 1; seed <= Number(process.env.RANDOMS ?? 20); seed += 1) scenes.push(randomScene(seed));

// ---------------------------------------------------------------- 跑
const out = [];
for (const s of scenes) {
  if (only && !s.script.name.includes(only)) continue;
  const expected = await runScenario(s.script);
  out.push({ name: s.script.name, script: enc(s.script), expected: enc(expected), ...(s.script.divergent ? { divergent: true } : {}) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, OUT), text);
console.log(`${OUT}:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
