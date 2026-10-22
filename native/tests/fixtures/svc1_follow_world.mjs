// 跟单(services/follow.ts)对拍的世界:假引擎、假来源(Gateway / 收件 / 读窗口的程序 / 凭证库,都是 svc1_stubs/*.mjs 垫片转进来的)、
// 假 router 与会话、假行情流、假建追踪通道,以及这一份脚本特有的步。C++ 一半在 tests/tst_svc_follow.cpp。约定见 svc1_world.mjs 开头,这里补:
//
//  脚本顶层:{ name, start, settings:{follow:{…}, policies:{…}}, router:{on?,sessions?,noSession?,covered?,managed?}, vault:{"服务/账号":"值"},
//    readerProgram:"路径"|null, book:{"行权价":{bid,ask}}, unwired?:true, breaker:{engaged,reason}, fakes, steps }
//  假答案队列(没有这个键用括号里的缺省):
//    engine.tryLocalShorthand|<原文>(再 |*)  {ok:{payload, snap:{代码:价}, meta:{relativeCenter}|null}}  (缺省:没接住 {payload:null,snap:{},meta:null})
//    engine.handleInstruction|<原文>(再 |*)  {ok:{submitted:[项], queued:[项], validated_only:[项], rejections:[{message, code?, record?}], warnings:[…], llm:null|{model}, parse?:true}}
//        项 = {account, intent_summary, record:{…交易记录…}, events?:[[kind, payload]…], as?:"别名"};record 在这一刻由假引擎落库,id 记到别名上
//    engine.resolveFanout {ok:[别名…]}(缺省 ["模拟"])      engine.orderLegId|<代码>:<行权价,…>(再 |*) {ok:"腿身份"}(缺省:抛错)
//    router.positions {ok:[持仓行…]}   marks.read {ok:[{strike,right,bid,ask,iv,error}…]}(缺省:按 book 现拼)   follow.addTrack {ok:{track}}
//    secret.exists / secret.read / secret.write {delay?, err?}(缺省:按 vault 答)
//  步:
//    {op:"call", m, a}  m: start stop sync(restart?) pollInbox settled setToken(token) onMessage(msg) status trackTick
//    {op:"newService"}      换一个新的 FollowService(同一个宿主与库;进程内的去重表是空的),照样接上假通道
//    {op:"attach"}          把假的行情流与建追踪通道接上(缺省开场就接,脚本写了 unwired 就不接)
//    {op:"gw", i, ev:"phase"|"message"|"set", …}  {op:"inbox", i, ev:"message"|"error"|"set", …}  {op:"reader", i, ev:"status", state, title, error}
//    {op:"breaker", set:{engaged, reason}}   {op:"readerProgram", value}   {op:"manualSeen"}(无)
import { clone, dec, makeError } from './svc1_world.mjs';

export function installFollowWorld(world, mods, store, ctx) {
  const state = {
    breaker: { engaged: false, reason: null, ...(world.script.breaker ?? {}) },
    readerProgram: world.script.readerProgram ?? null,
  };
  const vault = new Map(Object.entries(world.script.vault ?? {}));
  const created = { gateway: [], inbox: [], reader: [] };
  const book = world.script.book ?? {};
  const probe = mods.services_follow.refuseModelWhileFollowing({ parse: async () => 'probe' });
  const modelParser = mods.services_follow.refuseModelWhileFollowing({ parse: async (text) => { world.rec('model.parse', [text]); return 'model'; } });

  const svc1 = {
    rec: (m, a) => world.rec(m, a),
    created(kind, obj, extra) {
      const index = created[kind].length;
      created[kind].push(obj);
      world.rec(`${kind}.new`, [index, ...extra]);
      return index;
    },
    readerProgram: () => state.readerProgram,
    resolveFanout(settings, names) {
      world.rec('engine.resolveFanoutAccounts', [names]);
      const e = world.next('engine.resolveFanout', { ok: ['模拟'] });
      if (e.err !== undefined) throw makeError(e.err, mods);
      return clone(dec(e.ok));
    },
    orderLegId(order) {
      const c = order.contract;
      world.rec('engine.orderLegId', [c]);
      const key = `engine.orderLegId|${c.symbol}:${(c.legs ?? []).map((l) => l.strike).join(',')}`;
      const e = world.queues.has(key) ? world.next(key, null) : world.next('engine.orderLegId|*', { err: { kind: 'plain', message: '没有脚本化的 orderLegId' } });
      if (e.err !== undefined) throw makeError(e.err, mods);
      return e.ok;
    },
    async tryLocalShorthand(text, snap, at, meta) {
      world.rec('engine.tryLocalShorthand', [text, at.epochMs]);
      const entry = world.queues.has(`engine.tryLocalShorthand|${text}`)
        ? world.next(`engine.tryLocalShorthand|${text}`, null)
        : world.next('engine.tryLocalShorthand|*', { ok: { payload: null, snap: {}, meta: null } });
      const ok = await world.answer(entry, mods);
      for (const [k, v] of Object.entries(ok.snap ?? {})) snap[k] = v;
      if (ok.meta) meta.relativeCenter = ok.meta.relativeCenter;
      return ok.payload;
    },
    async secret(kind, service, account, secret) {
      world.rec(`secret.${kind}`, kind === 'write' ? [service, account, secret] : [service, account]);
      const e = world.next(`secret.${kind}`, {});
      await new Promise((r) => world.schedule(e.delay ?? 0, r));
      if (e.err !== undefined) throw makeError(e.err, mods);
      const key = `${service}/${account}`;
      if (kind === 'exists') return vault.has(key);
      if (kind === 'read') return vault.get(key) ?? null;
      vault.set(key, secret);
      return undefined;
    },
  };
  globalThis.__svc1 = svc1;

  const engine = {
    store,
    notifier: { notify(title, body, subtitle) { world.rec('notify', [title, body, subtitle ?? '', true]); } },
    killswitch: { state() { return { engaged: !!state.breaker.engaged, reason: state.breaker.reason ?? null }; } },
    async handleInstruction(text, channel, at, snap, accounts, dryRun) {
      let localOnly = false;
      try { await probe.parse(); } catch (e) { if (e instanceof mods.services_follow.FollowLocalOnlyError) localOnly = true; else throw e; }
      world.rec('engine.handleInstruction', [text, channel, at.epochMs, snap, accounts, dryRun, localOnly]);
      const entry = world.queues.has(`engine.handleInstruction|${text}`)
        ? world.next(`engine.handleInstruction|${text}`, null)
        : world.next('engine.handleInstruction|*', { ok: {} });
      const ok = await world.answer(entry, mods);
      if (ok.raw) return clone(ok.raw); // 原样当引擎的返回(造畸形的结果用)
      if (ok.parse) await modelParser.parse(text); // 跟单那一趟里被当场拒;手动指令不受影响
      const make = (items) => (items ?? []).map((it) => {
        const id = store.createRecord(clone(it.record));
        if (it.as) ctx.aliases.set(it.as, id);
        for (const [kind, payload] of it.events ?? []) store.appendEvent(id, kind, clone(payload));
        return { account: it.account, record_id: id, intent_summary: it.intent_summary };
      });
      const submitted = make(ok.submitted), queued = make(ok.queued), validatedOnly = make(ok.validated_only);
      const rejections = (ok.rejections ?? []).map((r) => {
        const out = { code: r.code ?? 'REJECTED', message: r.message };
        if (r.record) {
          const id = store.createRecord(clone(r.record));
          if (r.as) ctx.aliases.set(r.as, id);
          out.record_id = id;
        }
        return out;
      });
      return { submitted, queued, validated_only: validatedOnly, rejections, warnings: ok.warnings ?? [], ...(ok.noLlmKey ? {} : { llm: ok.llm === undefined ? null : ok.llm }), executed: !dryRun };
    },
  };

  const session = {
    managedAccounts() { world.rec('session.managedAccounts', []); return [...(ctx.routerState.managed ?? ['DU7654321'])]; },
  };

  const marks = {
    async read(_session, legs, delayedOk, silentLimitMs) {
      world.rec('marks.read', [legs, delayedOk, silentLimitMs]);
      const e = world.next('marks.read', null);
      const entry = e ?? { ok: legs.map((leg) => ({ strike: leg.strike, right: leg.right, bid: book[String(leg.strike)]?.bid ?? null, ask: book[String(leg.strike)]?.ask ?? null, iv: null, error: null })) };
      return world.answer(entry, mods);
    },
  };
  let tracksAdded = 0;
  const wiring = {
    marks,
    async addTrack(params) {
      tracksAdded += 1;
      world.rec('addTrack', [params]);
      const e = world.next('follow.addTrack', null) ?? { ok: { track: { id: `t${tracksAdded}`, targets: {}, auto_close: { enabled: true } } } };
      return world.answer(e, mods);
    },
  };

  const ops = {
    async attach() { ctx.service.attach(wiring); },
    async newService() {
      ctx.makeService();
      if (!world.script.unwired) ctx.service.attach(wiring);
    },
    async gw(step) {
      const g = created.gateway[step.i];
      if (!g) return; // 没有这个序号的来源(场景里还没造出来):什么都不做
      if (step.ev === 'phase') g.hooks.onPhase(step.phase, step.error ?? null);
      else if (step.ev === 'message') g.hooks.onMessage(clone(dec(step.msg)));
      else if (step.ev === 'set') {
        if ('bot' in step) g.bot = step.bot;
        if ('guildsSeen' in step) g.guildsSeen = step.guildsSeen;
        if (step.channels) g.channels = new Set(step.channels);
      }
      await world.advance(0);
    },
    async inbox(step) {
      const g = created.inbox[step.i];
      if (!g) return;
      if (step.ev === 'message') { g.received += 1; g.lastAt = step.lastAt ?? g.lastAt; g.hooks.onMessage(clone(dec(step.msg))); }
      else if (step.ev === 'error') g.hooks.onError(step.error);
      else if (step.ev === 'set') {
        if ('lastAt' in step) g.lastAt = step.lastAt;
        if ('received' in step) g.received = step.received;
        if ('error' in step) g.error = step.error;
      }
      await world.advance(0);
    },
    async reader(step) {
      const g = created.reader[step.i];
      if (!g) return;
      g.view = { state: step.state, title: step.title ?? null, error: step.error ?? null };
      g.hooks.onStatus();
      await world.advance(0);
    },
    async breaker(step) { Object.assign(state.breaker, step.set); },
    async readerProgram(step) { state.readerProgram = step.value; },
  };
  return { engine, wiring, ops, state, cleanup() { delete globalThis.__svc1; } };
}
