// 生成 symbol-mentions.json:engine-ts 的 symbolMentions.ts(原模块现跑)在拼出来的句子上认出的标的。
// 句子由碎片随机拼:cashtag、名单里的代码大小写、中英文叫法(含配置盖过内置的、整词与子串)、Discord 的提及 / 表情 / @everyone、链接、
// 行话(两个行权价、7700C、15CM、±25 点、翼宽、bear call)、JS 的各种空白(NBSP、全角空格、U+2028、BOM、U+1680)、全角字母、
// 连字、落单的代理项、喊叫的整句;叫法表的值不是串时命中那一刻抛的话也记下。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_symbol_mentions.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const M = await import(pathToFileURL(join(engine, 'dist/src/symbolMentions.js')).href);

let seed = 0x5e7b_1c0d;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const run = (f) => { try { return { out: f() }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };
const uJson = (u) => ({ known: [...u.known], aliases: u.aliases, implied: u.implied });

// ---------------------------------------------------------------- 名单
const universes = [];
const made = [];
const addMade = (known, aliases, implied) => {
  const u = implied === '__default__' ? (aliases === undefined ? M.makeUniverse(known) : M.makeUniverse(known, aliases)) : M.makeUniverse(known, aliases ?? {}, implied);
  made.push({ known, aliases: aliases ?? '__undefined__', implied: implied === '__default__' ? '__undefined__' : implied, out: uJson(u) });
  universes.push(uJson(u));
};
addMade([], undefined, '__default__');
addMade(['NVDA', 'aapl', ' tsla ', null, 5, '', 'ALL', 'IT', 'BRK.B', 'ab', 'Allstate', 'ß', '　mu '], undefined, '__default__');
addMade(['AMD', 'COIN', 'ON', 'DE'], { 英伟达: 'amd', Nvidia: 'nvda', 500: 'X', 'S&P': 'spx', 'big tech': 'qqq', 'Meta Platforms': 'META', 'a.b': 'AB', 标普500指数: 'SPX', 'Tesla ': 'tsla' }, 'SPX');
addMade(['SPY', 'QQQ', 'KORU'], { 苹果: 'aapl', apple: 'AAPL', 'x-y': 'XY', "o'neil": 'ON', 'ﬁ': 'FI', '7': 'SEVEN', '': 'EMPTY', 'ab': 'AB' }, null);
addMade(['TSLA', 'GLD', 'NVDA'], { 'Nv': 'NV', 'nvidia corp': 'NVDA', 'ma': 'MA', 'é': 'E' }, '');
addMade(['MSFT', 'P/L', 'A'], { 标普: 'SPX', '标': 'BIAO', 'ss': 'SS', 'S&P500': 'SPX5', 'Q3财报': 'QQQ' }, 'spy');
// 手拼的名单(调用方用 { ...universe, implied: null } 拼)
universes.push({ known: ['SPX', 'NVDA', 'AL', 'AB.C'], aliases: { 'Nvidia': 'NVDA', 'ﬀ': 'FF', 'ab': 'XX' }, implied: null });
universes.push({ known: [], aliases: {}, implied: 'SPX' });
universes.push({ known: ['ALL', 'FOR', 'STOP', 'SEE'], aliases: { '£': 'GBP' }, implied: 'Qqq' });
const nU = universes.length;
const live = universes.map((u) => ({ ...u, known: new Set(u.known) }));

const frags = [
  '$NVDA', '$nvda', '$brk.b', '$BRK.BB', '$ABCDEF', '$A', '$A.B.C', '$ 5', '$$TSLA', 'x$AAPL', '$SPX7700', '＄TSLA', 'ＮＶＤＡ', '＄ｍｕ',
  'NVDA', 'nvda', 'Nvda', 'AAPL', 'aapl', 'TSLA', 'tsla', 'SPX', 'spx', 'Spx', 'ES', 'es', 'all', 'ALL', 'All', 'it', 'IT', 'ON', 'on', 'on.', 'De',
  'BRK.B', 'brk.b', 'AB.C', 'AB.CD', 'ABCDEF', 'ABCDEFG', 'ABCDEF.G', 'MU', 'mu', 'Mu', 'COIN', 'coin', 'KORU', 'P/L', 'IBKR', 'XYZ', 'AB', 'A', 'Q',
  'CALL', 'PUT', 'CPI', 'FOMC', 'LOL', 'OK', 'TODAY', 'GTC', 'DTE', 'CM', 'EM',
  '英伟达', '苹果', '特斯拉', '标普', '标普500', '标普500指数', '标普五百', '纳指', '恐慌指数', '理想汽车', '小摩', '大摩', '超微', '超威', '标',
  'Nvidia', 'nvidia', 'NVIDIA', 'Nvidiax', 'xNvidia', 'Nvidia2', 'Tesla', 'tesla', 'apple', 'Apple Inc', 'Meta', 'META', 'meta', 'Meta Platforms', 'Alphabet',
  'big tech', 'BIG TECH', 'big  tech', 'S&P', 's&p', 'S&P500', 'a.b', 'A.B', 'x-y', "o'neil", "O'NEIL", 'Nv', 'nvidia corp', 'é', 'ma', 'ss', 'ß', 'ſs', 'ﬁ',
  '<@123456>', '<@!42>', '<@&7>', '<#99>', '<#x>', '<:spx:123>', '<a:NVDA:9>', '<:a b:1>', '<a:x:>', '@everyone', '@Everyone', '@here', '@HERE', '@heree', '@everyone2',
  'https://x.com/AAPL', 'HTTP://SPX.com', 'http:// x', 'https://', 'ftp://NVDA', 'Https://a.b/c?d=TSLA',
  '7700 7725', '7700  7725', '7700 7725', '7700　7725', '77007725', '7700 77250', '1.7700 7725', '7700 7725.5', '7700C', '7700c', '7700 P', '7700Px', '77000C', '770C', '77C',
  '.770C', '15CM', '15cm', '15 cm', '15 CMX', '0dte', '0DTE', '7700C/7725C', '±25点', '± 2.5 点', '±2.点', '±点', '翼宽10', '翼宽 5', '翼宽', '蝴蝶', '铁鹰', '价差',
  'bear call', 'Bull  Put', 'callspread', 'put spread', 'xbear call', 'bear callx', 'BEAR CALL', 'bull﻿put', 'call spread', 'bear\u2029call', 's&p500', 'q3财报', 'Q3财报', 'x\u2029NVDA',
  '\ud800', '\udc00NVDA', '😀', 'Ⅻ', '７７００ ７７２５', '１５ＣＭ', 'K', 'ı', 'İ', 'ǅ', '£', 'ﬀ', '，', '。', '!', '?', '(', ')', '\n', '\t',
  'LOOK AT THIS NOW BUY', 'THE FED IS GO', 'GO GO GO GO GO', 'IBKR AMD ON IT NOW GO',
];
const seps = [' ', ' ', ' ', '', ',', '\n', '。', '$', '.', '-', ' ', '　', '/', '1', 'x'];
const sentence = () => {
  const parts = [];
  for (let n = 1 + Math.floor(rnd() * 7); n > 0; n -= 1) parts.push(pick(frags));
  let s = '';
  for (const p of parts) s += (s ? pick(seps) : '') + p;
  return s;
};

const cases = [];
const fixed = [
  '', 'spx 7700 蝴蝶', '7700 7725 bear call', '15蝴蝶 15CM', '$NVDA 英伟达 Nvidia nvda', '标普500 标普', 'all in on AAPL', 'LOOK AT TSLA AND NVDA AND AMD NOW',
  '<@123> $TSLA https://x.com/NVDA @everyone', 'NVDA NVDA $NVDA', '英伟达 then $NVDA', 'Nvidia,nvidia;NVIDIA', 'BRK.B and brk.b', '0dte spx', 'IBKR XYZ ABC',
];
for (const t of fixed) for (let u = 0; u < nU; u += 1) cases.push({ text: t, u, ...run(() => M.extractMentions(t, live[u])) });
for (let i = 0; i < 6000; i += 1) {
  const t = sentence();
  const u = Math.floor(rnd() * nU);
  cases.push({ text: t, u, ...run(() => M.extractMentions(t, live[u])) });
}
// null / undefined 的原文
const nullish = [null, undefined].map((t) => ({ u: 1, ...run(() => M.extractMentions(t, live[1])) }));

// 叫法表的值不是串
const badUniverses = [5, null, true, ['X'], { a: 1 }, 'ok'].map((v) => ({ known: ['SPX'], aliases: { 英伟达: v, Tesla: 'TSLA' }, implied: 'SPX' }));
const bad = [];
for (const [i, u] of badUniverses.entries()) for (const t of ['英伟达 涨了', 'Tesla only', '$NVDA']) bad.push({ text: t, b: i, ...run(() => M.extractMentions(t, { ...u, known: new Set(u.known) })) });

// 行话
const talk = [];
for (const f of frags) talk.push({ text: f, out: M.looksLikeOptionTalk(f) });
for (let i = 0; i < 3000; i += 1) { const t = sentence(); talk.push({ text: t, out: M.looksLikeOptionTalk(t) }); }

// 去重
const lists = [];
for (let i = 0; i < 300; i += 1) {
  const ms = Array.from({ length: Math.floor(rnd() * 6) }, () => ({ symbol: pick(['SPX', 'NVDA', 'AAPL', 'X']), how: pick(['cashtag', 'known', 'alias', 'implied', 'guess', 'guess']), term: 'x' }));
  lists.push({ ms, confident: M.confidentSymbols(ms), guessed: M.guessedSymbols(ms) });
}

const fixture = { generator: 'gen_symbol_mentions.mjs', builtinAliases: M.BUILTIN_ALIASES, builtinKnown: M.BUILTIN_KNOWN, made, universes, cases, nullish, badUniverses, bad, talk, lists };
writeFileSync(join(here, 'symbol-mentions.json'), JSON.stringify(fixture) + '\n');
console.log(`symbol-mentions.json: ${cases.length} 句, ${talk.length} 条行话, ${made.length} 份名单`);
