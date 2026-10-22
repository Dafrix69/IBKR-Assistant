// 生成 handlers1_ordinary.json:connection.ts / settings.ts / system.ts 三个普通域(轻量对拍:关键判断与每个方法的形状)。C++ 一半:tests/tst_h1_ordinary.cpp。
import { Builder, call, finish, setup } from './gen_handlers1_common.mjs';

const { mods, tk } = await setup();
const b = new Builder(mods, tk);
const stock = (o) => b.stock(o);
const FUT = {
  connections: { fut: { broker: 'futu', host: '127.0.0.1', port: 11111 } },
  accounts: [
    { alias: '模拟', account_id: 'DU7654321', is_paper: true, connection: 'paper', default: true },
    { alias: '主账户', account_id: 'U1234567', is_paper: false, connection: 'live' },
    { alias: '富途模拟', account_id: '8801234', is_paper: true, connection: 'fut' },
  ],
};
const HB = { alive: true, age_ms: 12, running: true };

// ---------------------------------------------------------------- system
b.add('system.status:引擎没建过 tracker_loop 是 null;碰过引擎之后有心跳;没连券商', {
  engine: { results: { trackerHeartbeat: [{ value: HB }] } },
  steps: [call('a', 'system.status'), call('b', 'tracker.list'), call('c', 'system.status'), call('d', 'system.status', { x: 1 })],
});
b.add('system.status:连着券商——index_spot 只收 router 有 spotInfo 的;upstream 掉线;保护暂停 / 冷却 / 账户暂停(键序与排序)', {
  start: Date.parse('2026-09-11T03:30:00-04:00'),
  settings: { policies: { auto_execute: true } },
  router: b.router([], { sessions: 2, connected: ['paper'], upstreamOk: false, spotInfo: { SPX: { source: 'futures', note: 'ES 推算', price: 7490 }, VIX: null } }),
  engine: {
    engineBuilt: true, pending: [{ record_id: 'r', trigger: { symbol: 'SPX', operator: '>=', value: 1 }, approved: { order: {}, account: {} } }],
    results: {
      trackerHeartbeat: [{ value: HB }],
      protectionState: [{ value: { pause: { rule: 'stoploss_guard', reason: '接连止损', untilMs: 1789150000000 }, cooldowns: { 'BE|': { rule: 'cooldown', reason: '冷却中', untilMs: 1789150000000 }, 'AA|x': { rule: 'cooldown', reason: '到期了', untilMs: 5 }, 'AAPL|': { rule: 'cooldown', reason: '冷却', untilMs: 1789151000000 } }, accountPauses: { 主账户: { rule: 'daily_loss', reason: '日亏', untilMs: 1789152000000 }, 模拟: { rule: 'daily_loss', reason: '日亏2', untilMs: 1789150500000 } } } }],
    },
  },
  steps: [{ op: 'killswitch', m: 'engage', a: ['手动'] }, call('a', 'system.status'), { op: 'router', v: 'null' }, call('b', 'system.status')],
});
b.add('system.status:有 router 但一条会话都没有 → broker_connected 为 false(边界:会话数 > 0)', {
  settings: { policies: { auto_execute: true } },
  router: b.router([], { sessions: 0, connected: [], upstreamOk: true }),
  steps: [call('a', 'system.status')],
});
b.add('system.status:盘外 / 休市 / 周末的 market_status(随虚拟时刻)', {
  engine: { results: { trackerHeartbeat: [{ value: HB }] } },
  steps: [
    call('a', 'system.status'), { op: 'advance', ms: 5 * 3600 * 1000 }, call('b', 'system.status'), { op: 'advance', ms: 4 * 3600 * 1000 }, call('c', 'system.status'),
    { op: 'advance', ms: 24 * 3600 * 1000 }, call('d', 'system.status'), { op: 'advance', ms: 2 * 24 * 3600 * 1000 }, call('e', 'system.status'),
  ],
});
b.add('system.selftest:提示词指纹、字数按码点、别名与账户', {
  settings: { symbol_aliases: { 苹果: 'AAPL', 英伟达: 'NVDA' } },
  steps: [call('a', 'system.selftest')],
});

// ---------------------------------------------------------------- settings / llm / keychain / data
b.add('settings.get:默认配置的各段(键序同 TS);accounts / connections 的视图', {
  steps: [call('a', 'settings.get'), call('b', 'settings.get', { x: 1 })],
});
b.add('settings.get:按账户覆盖的限额、风险预算、保护规则、跟单配置', {
  settings: {
    limits: { by_account: { 模拟: { max_order_notional: 1000, max_mkt_shares: 50 }, 主账户: { max_underlying_contracts: 2, max_open_risk_usd: 300.5 } } },
    risk_budget: { enabled: true, equity_usd: { 模拟: 100000, 主账户: 250000.5 }, max_risk_pct: 1.5 },
    protections: { cooldown: { enabled: true, minutes: 15, scope: 'position' }, daily_loss: { enabled: true, basis: 'account', max_loss_usd: 800 } },
    follow: { enabled: true, channel_id: '1234567890123456', author_ids: ['111222333444555', '111222333444555', '999888777666555'], accounts: ['模拟', '模拟'], track_fly: true, track_exit_at: '15:50', local_inbox: true, local_channel: '频道' },
    policies: { auto_outside_rth: false, review_feature_enabled: true },
  },
  steps: [call('a', 'settings.get')],
});
b.add('settings.patch:账户 / 连接不许从界面改;只认五段;值不对回滚;成功后写文件、记审计、重载、推 settings 事件', {
  files: ['settings.json', 'settings.json.bak'],
  steps: [
    call('a', 'settings.patch', { patch: { accounts: [] } }), call('b', 'settings.patch', { patch: { connections: {}, accounts: [] } }),
    call('c', 'settings.patch', { patch: { llm: { model: 'x' } } }), call('d', 'settings.patch', { patch: { zzz: 1, aaa: 2, policies: {} } }),
    call('e', 'settings.patch', { patch: { limits: { max_order_notional: -1 } } }), call('f', 'settings.patch', { patch: { limits: { max_order_notional: 40000.0 } } }),
    call('g', 'settings.patch', { patch: { policies: { auto_execute: true }, protections: { cooldown: { enabled: true } } } }),
    call('h', 'settings.patch', { patch: { follow: { enabled: true, channel_id: 'abc' } } }), call('i', 'settings.patch', { patch: { risk_budget: { equity_usd: { 模拟: 50000 } } } }),
    call('j', 'settings.patch', {}), call('k', 'settings.patch', { patch: [] }), call('l', 'settings.patch', { patch: { limits: { by_account: { 模拟: { max_mkt_shares: 10 } } } } }),
    call('m', 'settings.get'), call('n', 'settings.patch', { patch: null }), call('o', 'settings.patch', { patch: { policies: { bogus: true } } }),
  ],
});
b.add('llm.catalog:供应商目录、当前配置、Key 有没有存过(只查不解密)', {
  secrets: { exists: { 'dafri-llm|anthropic': true } },
  steps: [call('a', 'llm.catalog'), call('b', 'llm.catalog')],
});
b.add('llm.patch:白名单外的字段拒;切供应商时 keychain_account 跟着切;校验失败回滚;成功重载并推 llm 事件', {
  files: ['settings.json', 'settings.json.bak'],
  steps: [
    call('a', 'llm.patch', { llm: { bogus: 1 } }), call('b', 'llm.patch', { llm: { keychain_service: 'x' } }), call('c', 'llm.patch', { llm: { model: 'claude-sonnet-5' } }),
    call('d', 'llm.patch', { llm: { provider: 'openai_compatible', base_url: 'https://api.example.com/v1', model: 'gpt-x' } }),
    call('e', 'llm.patch', { llm: { provider: 'nope' } }), call('f', 'llm.patch', { llm: { temperature: 7 } }), call('g', 'llm.patch', {}), call('h', 'llm.patch', { llm: { base_url: 'http://example.com' } }),
    call('i', 'llm.patch', { llm: { provider: null } }), call('j', 'llm.patch', { llm: { effort: 'low', max_tokens: 4096, timeout_s: 30, temperature: 0.2 } }),
  ],
});
b.add('llm.test:改不了凭证条目;换了供应商 / 端点必须自己带 Key;(自家官方端点的供应商除外)', {
  steps: [
    call('a', 'llm.test', { llm: { keychain_account: 'other' } }), call('b', 'llm.test', { llm: { keychain_service: 'x', keychain_account: 'y', bogus: 1 } }),
    call('c', 'llm.test', { llm: { provider: 'openai_compatible', base_url: 'https://api.example.com/v1' } }),
    call('d', 'llm.test', { llm: { base_url: 'https://api.example.com/v1' }, api_key: '' }),
    call('e', 'llm.test', { llm: { provider: 'openai_compatible', base_url: 'http://evil.example.com/v1' }, api_key: 'sk-test' }),
    call('f', 'llm.test', { llm: { provider: 'openai_compatible', base_url: 'http://127.0.0.1:9/v1/' }, api_key: 'k' }),
    call('g', 'llm.test', { api_key: 5 }), call('h', 'llm.test', { llm: [] }),
  ],
});
const OAI = { llm: { provider: 'openai_compatible', base_url: 'https://api.example.com/v1', model: 'gpt-x', keychain_account: 'openai_compatible' } };
b.add('llm.test:同端点才复用已存的 Key——供应商变(base_url 没变)→ 拒;供应商没变、base_url 变 → 拒;都没变(含末尾斜杠 / 空白)→ 照用,不碰网络', {
  settings: { llm: { provider: 'anthropic', base_url: 'https://api.example.com/v1', model: 'm' } },
  steps: [
    call('a', 'llm.test', { llm: { provider: 'openai_compatible' } }),
    call('b', 'llm.test', { llm: { provider: 'openai_compatible', base_url: 'https://api.example.com/v1' } }),
    call('c', 'llm.test', {}),
    call('d', 'llm.test', { llm: { base_url: 'https://api.example.com/v1/' } }),
    call('e', 'llm.test', { llm: { provider: 'anthropic' } }),
  ],
});
b.add('llm.test(openai 兼容):base_url 变 → 拒;没变(末尾斜杠、空白)→ 照用已存的 Key(这里没存,报没有 Key,不碰网络);换回 anthropic 官方端点免填', {
  settings: OAI,
  steps: [
    call('a', 'llm.test', { llm: { base_url: 'https://other.example.com/v1' } }),
    call('b', 'llm.test', { llm: { base_url: 'https://api.example.com/v1///' } }),
    call('c', 'llm.test', { llm: { base_url: '  https://api.example.com/v1  ' } }),
    call('d', 'llm.test', {}),
    call('e', 'llm.test', { llm: { provider: 'anthropic' } }),
  ],
});
b.add('keychain.set:写进凭证库(默认账户 / 指定供应商)、空密钥拒、凭证库出错 → -32008;审计只记 service', {
  secrets: {},
  steps: [
    call('a', 'keychain.set', { secret: 'sk-test-1' }), call('b', 'keychain.set', { secret: 'sk-test-2', provider: 'openai_compatible' }), call('c', 'keychain.set', { secret: '' }),
    call('d', 'keychain.set', { secret: 'sk-test-3', provider: '' }), call('e', 'keychain.set', {}), call('f', 'keychain.set', { secret: 'x', extra: 1 }),
    { op: 'secrets', set: { writeError: '钥匙串不让写' } }, call('g', 'keychain.set', { secret: 'sk-test-4' }),
  ],
});
b.add('data.export:写整本记录到指定路径(2 空格缩进,含审计),回执带条数;缺路径 / 路径写不了', {
  files: ['export.json'],
  steps: [
    { op: 'store', m: 'createRecord', a: [{ id: 'rec-1', created_at: '2026-09-11T10:00:00+00:00', signature: 's', order: { totalQuantity: 5 }, contract: { symbol: 'AAPL' }, account: { alias: '模拟', account_id: 'DU7654321' }, llm: {} }] },
    { op: 'store', m: 'audit', a: ['t', 'seed', { a: 1 }] },
    call('a', 'data.export', { path: '$DIR/export.json' }), call('b', 'data.export', { path: '' }), call('c', 'data.export', {}),
    call('d', 'data.export', { path: '$DIR/no/such/x.json' }), call('e', 'data.export', { path: '$DIR/export.json' }),
  ],
});
b.add('data.backups / data.backup:清单、出一份手动备份、审计', {
  steps: [call('a', 'data.backups'), call('b', 'data.backup'), { op: 'advance', ms: 1000 }, call('c', 'data.backup'), call('d', 'data.backups')],
});

// ---------------------------------------------------------------- connection
b.add('broker.catalog:两家的连接与账户、没配连接时给该抄的配置、富途解锁密码存没存(只查不解密)', {
  secrets: { exists: { 'dafri-futu|unlock': true } },
  router: b.router([], { connected: ['paper', 'live'] }),
  steps: [call('a', 'broker.catalog'), { op: 'router', v: 'null' }, call('b', 'broker.catalog')],
});
b.add('broker.catalog:配了富途连接的样子', {
  settings: { ...FUT, broker: { provider: 'futu', futu: { trd_market: 'US', security_firm: 'FUTUSECURITIES', symbol_map: { BRK: 'BRK.B' } } } },
  steps: [call('a', 'broker.catalog')],
});
b.add('broker.select:只支持 ibkr / futu;没有连接的那家拒(带配置模板);成功后断旧连接、忘掉重连、丢引擎、记审计', {
  files: ['settings.json', 'settings.json.bak'],
  router: b.router([], { connected: ['paper'] }),
  steps: [
    call('a', 'broker.select', { provider: 'schwab' }), call('b', 'broker.select', {}), call('c', 'broker.select', { provider: 'futu' }),
    call('d', 'broker.select', { provider: 'ibkr' }), call('e', 'broker.select', { provider: 'ibkr' }),
    { op: 'config', patch: FUT }, call('f', 'broker.select', { provider: 'futu' }), call('g', 'broker.select', { provider: 5 }),
  ],
});
b.add('broker.select:断旧连接出错时配置已改但 router 还在;配置文件写不了 → -32007', {
  router: b.router([], { results: { disconnectAll: [{ error: '断不开' }] } }),
  steps: [call('a', 'broker.select', { provider: 'ibkr' }), { op: 'file', path: 'settings.json', content: '{坏的' }, call('b', 'broker.select', { provider: 'ibkr' })],
});
b.add('broker.connect / disconnect:交给 brokerLink(connections 缺省 = undefined)', {
  services: { brokerLink: { results: { connect: [{ value: { provider: 'ibkr', connected: ['paper'], failed: {}, listeners: 1 } }, { value: { provider: 'ibkr', connected: [], failed: { live: '拒绝连接' }, listeners: 0 } }, { error: '连接炸了', cls: 'RpcError', code: -32001 }], disconnect: [{ value: null }] } } },
  steps: [call('a', 'broker.connect', {}), call('b', 'broker.connect', { connections: ['live'] }), call('c', 'broker.connect', { connections: [] }), call('d', 'broker.disconnect'), call('e', 'broker.connect', { connections: 'live' })],
});
b.add('tws.diagnose / tws.launch:未定义的连接、空名单、不认识的应用', {
  steps: [call('a', 'tws.diagnose', { connections: ['nope', 'paper', 'zzz'] }), call('b', 'tws.diagnose', { connections: [] }), call('c', 'tws.launch', { app: 'nope' }), call('d', 'tws.launch', {}), call('e', 'tws.launch', { app: 5 })],
});
b.add('futu.unlock:当前接入不是富途 → -32010;是富途但没连(或连的不是富途 router) → -32004', {
  steps: [call('a', 'futu.unlock', {}), { op: 'config', patch: { ...FUT, broker: { provider: 'futu' } } }, call('b', 'futu.unlock', { connection: 'fut' }), { op: 'router', v: 'make' }, call('c', 'futu.unlock', {})],
  router: b.router([]),
});
b.add('futu.set_password:只存 md5;勾"已经是 md5"时核对 32 位十六进制;凭证库出错 → -32008', {
  steps: [
    call('a', 'futu.set_password', { password: 'xyz' }), call('b', 'futu.set_password', { password: 'xyz', already_md5: true }),
    call('c', 'futu.set_password', { password: ' D41D8CD98F00B204E9800998ECF8427E ', already_md5: true }), call('d', 'futu.set_password', {}),
    call('e', 'futu.set_password', { password: '' }), call('f', 'futu.set_password', { password: '密码', already_md5: false }), call('g', 'futu.set_password', { password: 'x', bogus: 1 }),
    call('h', 'futu.set_password', { password: 'd41d8cd98f00b204e9800998ecf8427e', already_md5: 1 }), call('i', 'futu.set_password', { password: 'g41d8cd98f00b204e9800998ecf8427e', already_md5: true }),
    { op: 'secrets', set: { writeError: '不让写' } }, call('j', 'futu.set_password', { password: 'x' }),
  ],
});
await finish(b, mods, 'handlers1_ordinary.json');
