// 生成 discord-gateway.json:engine-ts 的 discordGateway.ts(原模块现跑)。
// 不碰网络、不碰 discord.com:socket 是假的(TS 自己的测试也是这么注入的),计时器是假的(这里把全局 setTimeout / clearTimeout 换成一条手拨的时间线),
// 随机数是给定的一串。每个场景是一串动作(start / stop / 对方发来一帧 / 连接断了 / 往前拨时间 / 下一次 open 抛错),
// 每一步记下:网关做了什么(开了哪条 socket、发了哪一行、关了哪条 socket 用什么码、阶段的变化、递出来的消息)与对外可见的状态(bot、频道表)。
// token 只有 "bot.token.value"(不是真的);没有任何真 token。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_discord_gateway.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const G = await import(pathToFileURL(join(engine, 'dist/src/discordGateway.js')).href);

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

// ---------------------------------------------------------------- 手拨的时间线
function makeClock() {
  let now = 0, seq = 0;
  const queue = [];
  return {
    setTimeout(fn, ms) { const t = { at: now + Number(ms), seq: (seq += 1), fn, active: true }; queue.push(t); return t; },
    clearTimeout(t) { if (t) t.active = false; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = queue.filter((t) => t.active).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
        if (!due || due.at > end) break;
        due.active = false;
        now = Math.max(now, due.at);
        due.fn();
      }
      now = end;
    },
  };
}

class FakeSocket {
  constructor(url, i, log) { this.url = url; this.i = i; this.log = log; this.onmessage = null; this.onclose = null; }
  send(data) { this.log().push({ e: 'send', i: this.i, data }); }
  close(code) { this.log().push({ e: 'close', i: this.i, code: code ?? null }); }
}

const MESSAGE_ID = String(((BigInt(Date.UTC(2026, 7, 14, 14, 32, 0)) - 1420070400000n) << 22n) + 7n);
const idAt = (ms, n = 7n) => String(((BigInt(ms) - 1420070400000n) << 22n) + n);

function runScenario(sc) {
  const clock = makeClock();
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  try {
    let cur = [];
    const sockets = [];
    let openThrows = null, ri = 0;
    const gw = new G.DiscordGateway('bot.token.value', {
      onMessage: (m) => cur.push({ e: 'message', m }),
      onPhase: (p, err) => cur.push({ e: 'phase', p, err }),
    }, {
      url: sc.url,
      open: (url) => {
        if (openThrows !== null) { const m = openThrows; openThrows = null; cur.push({ e: 'open-throws', url }); throw new Error(m); }
        const s = new FakeSocket(url, sockets.length, () => cur);
        sockets.push(s);
        cur.push({ e: 'open', i: s.i, url });
        return s;
      },
      random: () => sc.random[ri++ % sc.random.length],
    });
    const steps = [];
    for (const step of sc.steps) {
      cur = [];
      const sock = () => sockets[step.i ?? sockets.length - 1];
      switch (step.do) {
        case 'start': gw.start(); break;
        case 'stop': gw.stop(); break;
        case 'raw': sock()?.onmessage?.(step.text); break;
        case 'drop': sock()?.onclose?.(step.code); break;
        case 'advance': clock.advance(step.ms); break;
        case 'openThrows': openThrows = step.message; break;
        default: throw new Error(step.do);
      }
      steps.push({ events: enc(cur), state: enc({ bot: gw.bot, guildsSeen: gw.guildsSeen, channels: [...gw.channels].sort() }) });
    }
    return steps;
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

// ---------------------------------------------------------------- 场景
const HELLO = { op: 10, d: { heartbeat_interval: 40_000 } };
const READY = (extra = {}) => ({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess-1', resume_gateway_url: 'wss://resume.discord.gg', user: { username: 'follow-bot' }, ...extra } });
const MSG = (d = {}, s = 2) => ({ op: 0, t: 'MESSAGE_CREATE', s, d: { id: MESSAGE_ID, channel_id: '1100000000000000001', type: 0, content: '1.8 挂15蝴蝶 15CM', author: { id: '220000000000000002', username: 'laowang', global_name: '老王' }, ...d } });
const start = { do: 'start' }, stop = { do: 'stop' };
const raw = (text, i) => ({ do: 'raw', text, ...(i === undefined ? {} : { i }) });
const frame = (payload, i) => raw(JSON.stringify(payload), i);  // 夹具里存的是 TS 那边实际收到的那一行文字
const drop = (code, i) => ({ do: 'drop', code, ...(i === undefined ? {} : { i }) });
const adv = (ms) => ({ do: 'advance', ms });
const connect = (...more) => [start, frame(HELLO), frame(READY()), ...more];

const scenarios = [];
const add = (name, steps, random = [0.5], url) => scenarios.push({ name, random, steps, ...(url === undefined ? {} : { url }) });

add('hello identify ready', [start, frame(HELLO), frame(READY())]);
add('hello without interval uses default', [start, frame({ op: 10, d: {} }), frame(READY()), adv(20_624), adv(1), adv(41_250)]);
add('hello interval not a number', [start, frame({ op: 10, d: { heartbeat_interval: '40000' } }), adv(41_250 / 2 - 1), adv(1)]);
add('hello d missing', [start, frame({ op: 10 }), adv(41_250)]);
add('hello tiny interval', [start, frame({ op: 10, d: { heartbeat_interval: 1.5 } }), adv(1), adv(1), frame({ op: 11 }), adv(2), adv(2)], [0.4, 0.9]);
add('hello zero interval', [start, frame({ op: 10, d: { heartbeat_interval: 0 } }), adv(1), adv(5)]);
add('messages', connect(
  frame(MSG()), frame(MSG({ type: 7 }, 3)), frame(MSG({ author: null }, 4)), frame({ op: 0, t: 'MESSAGE_UPDATE', s: 5, d: { id: MESSAGE_ID } }),
  frame(MSG({ type: 19, id: idAt(Date.UTC(2026, 7, 14, 14, 33, 1, 0), 9n), content: '回复' }, 6)), frame(MSG({ type: null, id: idAt(Date.UTC(2026, 0, 1), 1n) }, 7)),
  frame(MSG({ type: '0' }, 8)), frame(MSG({ type: 19.5 }, 9)), frame(MSG({ id: 'abc' }, 10)), frame(MSG({ id: 5 }, 11)), frame(MSG({ channel_id: '' }, 12)), frame(MSG({ channel_id: 7 }, 13)),
  frame(MSG({ author: { id: '' } }, 14)), frame(MSG({ author: { id: 5, username: 'x' } }, 15)), frame(MSG({ author: { id: '9', username: 'plain', global_name: '' } }, 16)),
  frame(MSG({ author: { id: '9', username: 'plain', global_name: null } }, 17)), frame(MSG({ author: { id: '9' } }, 18)), frame(MSG({ author: [1] }, 19)), frame(MSG({ content: 5 }, 20)),
  frame(MSG({ content: undefined }, 21)), frame(MSG({ content: '含 "引号" 与\\反斜杠\n换行 ' }, 22)), frame({ op: 0, t: 'MESSAGE_CREATE', s: 23, d: 'x' }), frame({ op: 0, t: 'MESSAGE_CREATE', s: 24, d: null }),
  frame({ op: 0, t: 'MESSAGE_CREATE', s: 25, d: [1] }), frame({ op: 0, t: 'MESSAGE_CREATE', s: 26 }), frame(MSG({ id: '1'.repeat(21) }, 27)), frame(MSG({ id: '9'.repeat(21) }, 28)),
  frame(MSG({ id: '1'.repeat(15) }, 29)), frame(MSG({ id: '1'.repeat(14) }, 30)), frame(MSG({ id: '1'.repeat(22) }, 31)), frame(MSG({ id: '０１２３４５６７８９０１２３４５' }, 32)),
));
add('guild and channel tables', connect(
  frame({ op: 0, t: 'GUILD_CREATE', s: 2, d: { channels: [{ id: '1100000000000000001' }], threads: [{ id: '1100000000000000005' }] } }),
  frame({ op: 0, t: 'CHANNEL_CREATE', s: 3, d: { id: '1100000000000000006' } }), frame({ op: 0, t: 'THREAD_CREATE', s: 4, d: { id: '1100000000000000007' } }),
  frame({ op: 0, t: 'CHANNEL_CREATE', s: 5, d: { id: '' } }), frame({ op: 0, t: 'CHANNEL_CREATE', s: 6, d: { id: 5 } }), frame({ op: 0, t: 'CHANNEL_CREATE', s: 7, d: null }),
  frame({ op: 0, t: 'GUILD_CREATE', s: 8, d: { channels: 'x', threads: [null, 5, { id: 5 }, { id: '' }, { id: '1100000000000000009' }, [1]] } }),
  frame({ op: 0, t: 'GUILD_CREATE', s: 9, d: {} }), frame({ op: 0, t: 'GUILD_CREATE', s: 10, d: null }), frame(READY()),
));
add('guild table before ready is wiped by ready', [start, frame(HELLO), frame({ op: 0, t: 'GUILD_CREATE', s: 1, d: { channels: [{ id: '1' }] } }), frame(READY()), frame({ op: 0, t: 'GUILD_CREATE', s: 3, d: { channels: [{ id: '2' }] } }), frame(READY())]);
add('ready shapes', [start, frame(HELLO), frame({ op: 0, t: 'READY', s: 1, d: null }), frame({ op: 0, t: 'READY', s: 2, d: {} }), frame({ op: 0, t: 'READY', s: 3, d: { session_id: 5, resume_gateway_url: 7, user: 'x' } }),
  frame({ op: 0, t: 'READY', s: 4, d: { session_id: 's', resume_gateway_url: 'wss://r.example/path//', user: { username: '' } } }), frame({ op: 0, t: 'RESUMED', s: 5 }), frame({ op: 0, t: 5, s: 6 }), frame({ op: 0, s: 7 }),
  frame({ op: 0, t: 'READY', s: 8, d: { session_id: 's2', resume_gateway_url: '', user: { username: 'bot2' } } })]);
add('heartbeat cadence and seq', [start, frame(HELLO), frame(READY()), adv(19_999), adv(1), frame({ op: 11 }), frame(MSG({}, 7)), adv(40_000), frame({ op: 11 }), adv(40_000), frame({ op: 11 }),
  frame({ op: 1 }), frame({ op: 0, t: 'MESSAGE_CREATE', s: 'x', d: {} }), frame({ op: 1 }), frame({ op: 0, t: 'X', s: 2.5 }), frame({ op: 1 }), frame({ op: 0, t: 'X', s: null }), frame({ op: 1 }), frame({ op: 11, s: 99 }), frame({ op: 1 })]);
add('heartbeat requested before any seq', [start, frame(HELLO), frame({ op: 1 })]);
add('zombie connection resumes', [start, frame(HELLO), frame(READY()), adv(20_000), adv(40_000), adv(1_999), adv(1), adv(0), frame(HELLO, 1), frame({ op: 0, t: 'RESUMED', s: 2 }), adv(20_000), frame({ op: 11 }), adv(40_000)]);
add('zombie before ready identifies again', [start, frame(HELLO), adv(20_000), adv(40_000), adv(2_000), frame(HELLO, 1)]);
add('op 7 reconnect then resume', [start, frame(HELLO), frame(READY()), frame(MSG({}, 7)), frame({ op: 7 }), adv(1_000), adv(1_000), frame(HELLO, 1), frame({ op: 0, t: 'RESUMED', s: 8 }), frame({ op: 1 })]);
add('op 7 with late frames on the old socket', [start, frame(HELLO), frame(READY()), frame({ op: 7 }), frame(MSG(), 0), raw('{"op":1}', 0), drop(1006, 0), adv(1_500), frame(HELLO, 1), frame(READY(), 1), drop(1006, 0), drop(1000, 0)]);
add('op 9 not resumable identifies again', [start, frame(HELLO), frame(READY()), frame({ op: 9, d: false }), adv(2_000), frame(HELLO, 1), frame(READY({ session_id: 'sess-2' }), 1)]);
add('op 9 resumable resumes', [start, frame(HELLO), frame(READY()), frame({ op: 9, d: true }), adv(2_000), frame(HELLO, 1)]);
add('op 9 without d identifies again', [start, frame(HELLO), frame(READY()), frame({ op: 9 }), adv(2_000), frame(HELLO, 1)]);
add('op 9 d as truthy non-true', [start, frame(HELLO), frame(READY()), frame({ op: 9, d: 1 }), adv(2_000), frame(HELLO, 1)]);
add('op 9 before ready', [start, frame(HELLO), frame({ op: 9, d: true }), adv(2_000), frame(HELLO, 1)]);
for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) add(`fatal close ${code}`, [...connect(), drop(code), adv(120_000), start, frame(HELLO, 1)]);
for (const code of [1000, 1001, 4007, 4009, 1006, 4000, 4001, 1005, 4003, 4008, 1011]) add(`close ${code} retries`, [...connect(frame(MSG({}, 7))), drop(code), adv(2_000), frame(HELLO, 1)]);
add('close before ready', [start, frame(HELLO), drop(1006), adv(2_000), frame(HELLO, 1), drop(1006, 1), adv(4_000)]);
add('backoff grows and caps', [start, ...Array.from({ length: 10 }, (_v, i) => [drop(1006, i), adv(70_000)]).flat()], [0.5, 0, 0.999, 0.25, 0.75, 1 - 1e-12]);
add('backoff resets on ready', [start, drop(1006), adv(70_000), drop(1006, 1), adv(70_000), frame(HELLO, 2), frame(READY(), 2), drop(1006, 2), adv(70_000)], [0.5, 0.2]);
add('backoff resets on resumed', [...connect(), drop(1006), adv(70_000), frame(HELLO, 1), frame({ op: 0, t: 'RESUMED', s: 3 }), drop(1006, 1), adv(70_000)], [0.5, 0.2, 0.9]);
add('open throws then recovers', [{ do: 'openThrows', message: 'boom' }, start, adv(2_000), adv(70_000), frame(HELLO)], [0.5, 0.0, 1.0]);
add('open throws repeatedly', [{ do: 'openThrows', message: 'a' }, start, { do: 'openThrows', message: 'b' }, adv(1_000), { do: 'openThrows', message: 'c' }, adv(2_000), adv(4_000), adv(8_000), frame(HELLO)], [0.3]);
add('open throws on resume', [...connect(), drop(1006), { do: 'openThrows', message: '解析失败' }, adv(2_000), adv(5_000), frame(HELLO, 1)]);
add('stop while connected', [...connect(), adv(20_000), stop, adv(100_000), drop(1000, 0), frame(MSG(), 0)]);
add('stop while retry pending', [start, drop(1006), stop, adv(100_000)]);
add('stop while connecting', [start, stop, adv(100_000)]);
add('stop twice and stop before start', [stop, start, stop, stop, adv(100_000)]);
add('start twice', [start, start, frame(HELLO), start, frame(READY()), start]);
add('restart after stop reconnects with identify or resume', [...connect(), stop, start, frame(HELLO, 1), frame({ op: 0, t: 'RESUMED', s: 3 }, 1)]);
add('restart after fatal identifies', [...connect(), drop(4004), start, frame(HELLO, 1), frame(READY(), 1)]);
add('timers cleared by close', [...connect(), adv(20_000), drop(1006), adv(30_000), adv(30_000), frame(HELLO, 1)]);
add('socket close error ignored', [...connect(), frame({ op: 7 }), frame({ op: 7 })]);
add('malformed frames', [start, raw('not json'), raw(''), raw('[1]'), raw('null'), raw('"x"'), raw('5'), raw('{"op":"10","d":{}}'), raw('{"d":{}}'), raw('{"op":null}'), raw('{"op":0}'), raw('{"op":0,"t":null}'), raw('{"op":10.5}'), raw('{"op":11}'), raw('{"op":99}'),
  raw('{"op":10,"d":{"heartbeat_interval":1000}}'), raw('﻿{"op":1}'), raw('{"op":1} '), raw(' {"op":1}'), raw('{"op":1,"s":3}{"op":1}'), raw('{"op":1,"op":10}'), adv(10_000)]);
add('session without resume url', [start, frame(HELLO), frame({ op: 0, t: 'READY', s: 1, d: { session_id: 'only-session', user: { username: 'b' } } }), drop(1006), adv(2_000), frame(HELLO, 1), drop(1006, 1), adv(5_000)]);
add('resume url without session', [start, frame(HELLO), frame({ op: 0, t: 'READY', s: 1, d: { resume_gateway_url: 'wss://r.example', user: { username: 'b' } } }), drop(1006), adv(2_000), frame(HELLO, 1)]);
add('custom url', [start, frame(HELLO), frame(READY()), drop(1006), adv(2_000), drop(1006, 1), adv(5_000)], [0.5], 'ws://127.0.0.1:9/gw?x=1');
add('resume url trailing slashes', [start, frame(HELLO), frame(READY({ resume_gateway_url: 'wss://resume.discord.gg////' })), drop(1006), adv(2_000), frame(HELLO, 1), drop(1006, 1), adv(5_000)]);
add('session gone then identify', [...connect(), drop(4007), adv(2_000), frame(HELLO, 1), frame(READY({ session_id: 'sess-9' }), 1), frame({ op: 7 }), adv(2_000), frame(HELLO, 2)]);
add('reconnect after reconnect', [...connect(), frame({ op: 7 }), adv(1_000), adv(1_000), frame(HELLO, 1), frame({ op: 7 }, 1), adv(60_000), frame(HELLO, 2)], [0.5, 0.1, 0.9]);
add('ready then beat acked forever', [...connect(), ...Array.from({ length: 6 }, () => [adv(40_000), frame({ op: 11 })]).flat()]);
add('random edge values', [start, frame(HELLO), frame(READY()), adv(40_000), drop(1006), adv(100_000), frame(HELLO, 1), adv(40_000)], [0, 0, 0.99999999, 0.5, 0, 1 - 1e-16]);

const out = scenarios.map((sc) => ({ name: sc.name, random: sc.random, ...(sc.url === undefined ? {} : { url: sc.url }), steps: sc.steps, expected: runScenario(sc) }));

// ---------------------------------------------------------------- 纯函数
const snow = [];
for (const id of [MESSAGE_ID, idAt(Date.UTC(2015, 0, 1), 0n), idAt(Date.UTC(2015, 0, 1), 5n), idAt(Date.UTC(2026, 11, 31, 23, 59, 59, 999), 4194303n), idAt(Date.UTC(2090, 0, 1), 3n), '9'.repeat(21), '1'.repeat(21), '1'.repeat(16), '1'.repeat(15), '1'.repeat(14), '1'.repeat(22),
  '000000000000000', '0'.repeat(21), '4194304', 'abc', '', ' 123456789012345678', '123456789012345678 ', '12345678901234567\n', '-123456789012345678', '1.23456789012345e17', '０１２３４５６７８９０１２３４５', '٠١٢٣٤٥٦٧٨٩٠١٢٣٤٥', '175928847299117063', '1100000000000000001', '999999999999999999999']) {
  snow.push({ id, out: enc(G.snowflakeMs(id)) });
}
const parse = [];
const dm = (o) => ({ id: MESSAGE_ID, channel_id: '1', type: 0, content: 'c', author: { id: '2', username: 'u', global_name: 'g' }, ...o });
for (const d of [dm({}), dm({ type: undefined }), dm({ type: 19 }), dm({ type: 7 }), dm({ type: null }), dm({ type: '0' }), dm({ type: 0.0 }), dm({ type: -0 }), dm({ type: 19.0 }), dm({ type: 18.9999 }), dm({ type: [0] }), dm({ type: [19] }), dm({ type: false }),
  dm({ author: undefined }), dm({ author: null }), dm({ author: 'x' }), dm({ author: [] }), dm({ author: {} }), dm({ author: { id: '2' } }), dm({ author: { id: '2', username: 'u' } }), dm({ author: { id: '2', global_name: 'g' } }), dm({ author: { id: '2', global_name: '', username: 'u' } }),
  dm({ author: { id: '2', global_name: 5, username: 'u' } }), dm({ author: { id: '2', global_name: 'g', username: 5 } }), dm({ author: { id: 2, username: 'u' } }),
  dm({ id: 'abc' }), dm({ id: undefined }), dm({ id: '' }), dm({ channel_id: '' }), dm({ channel_id: undefined }), dm({ channel_id: 1 }), dm({ content: undefined }), dm({ content: null }), dm({ content: 5 }), dm({ content: '' }), dm({ content: '带换行\n与 "引号"' }),
  null, undefined, 5, 'x', [], [1], true, {}, { type: 0 }]) {
  parse.push({ d: enc(d), out: enc(G.parseMessage(d)) });
}
writeFileSync(join(here, 'discord-gateway.json'), JSON.stringify({ intents: G.INTENTS, url: G.GATEWAY_URL, scenarios: out, snowflake: snow, parse }) + '\n');
console.log('discord-gateway.json', out.length, '场景', out.reduce((n, s) => n + s.steps.length, 0), '步', snow.length, 'snowflake', parse.length, 'parse');
