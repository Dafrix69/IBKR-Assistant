// 生成 shorthand.json:engine-ts 的 shorthand.ts(原模块现跑)。输入:黄金基线的 45 条、TS 测试里写过的每一句(shorthand / follow / engine 的 spec 里
// 带「蝴蝶」「cm」「bull」「bear」的字面串)、按语法拼出来的随机句子;再随机加全角、U+3000 / NBSP / U+FEFF / U+2028、落单的代理项、换行、理由尾巴。
// 时刻有工作日、周五(「明天」跳到周一)、周六、周日;现价有缺、有串、有 NaN。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_shorthand.mjs <编过的 engine-ts 目录>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const S = await import(pathToFileURL(join(engine, 'dist/src/shorthand.js')).href);
const C = await import(pathToFileURL(join(engine, 'dist/src/config.js')).href);

let seed = 0x5ea5_0b7e;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
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
const hex = (s) => Buffer.from(s, 'utf16le').toString('hex');  // 句子按 UTF-16 存:落单的代理项进不了 JSON 的 UTF-8

// ---- 句子的来源
const texts = new Set();
const golden = JSON.parse(readFileSync(join(engine, 'baseline/golden/shorthand.json'), 'utf8'));
for (const c of golden.cases) texts.add(c.text);
texts.add(golden.weekend.text);
for (const spec of ['shorthand.spec.ts', 'follow.spec.ts', 'engine-shorthand.spec.ts', 'golden-shorthand.spec.ts']) {
  let src;
  try { src = readFileSync(join(engine, 'tests', spec), 'utf8'); } catch { continue; }
  for (const m of src.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.){2,120})\1/g)) {
    const t = m[2];
    if (/蝴蝶|cm|CM|bull|bear|BULL|BEAR|翼宽|±/.test(t) && !t.includes('${')) texts.add(t.replace(/\\(.)/g, '$1'));
  }
}
const pieces = {
  prem: ['1.8', '2', '0.5', '权利金不超过 3', '权利金上限2.5', '权利金 1', '2块', '3刀', '1.5美元', '', '', '12', '0'],
  verb: ['', '', '挂', '买', '帮我买', '来一张', '开仓', '试试', '赌博小彩票', '一下', '能不能挂进去'],
  center: ['15蝴蝶', '7520蝴蝶', '7520 蝴蝶', '7520的蝴蝶', '00蝴蝶', '580蝴蝶', '95蝴蝶', '蝴蝶', '7515.5蝴蝶', '7,520蝴蝶'],
  wing: ['15CM', '10cm', '翼宽 20', '翼宽15点', '±10点', '25 cm', '0cm', '600cm', '', '2.5cm'],
  qty: ['', '', '2张', '两张', '十张', '1500张', '0张', '十一张', '3 张'],
  sym: ['', '', 'SPX', 'QQQ', 'spy', 'X', 'NDX AAPL'],
  right: ['', '', '看涨', '看跌', 'call', 'PUT'],
  misc: ['', '', 'GTC', '一直有效', '盘外', '明天', '明天的', '今天', '0DTE', '当日到期', '止盈', '如果', '理由:看好', '理由:', '\n第二单'],
};
const spreadPieces = {
  strikes: ['7770 7775', '7775 7770', '00 95', '95 00', '7700/7695', '7700-7695', '50 55', '7770 75', '20 70', '7700 8300'],
  type: ['bear call', 'bull put', 'BULL PUT', 'bear  call spread', 'bull', 'bullput', 'bear call bull put'],
  credit: ['-2', '-2 -2.5', '-2到-2.5', '-2.5~-2', '', '-0', '-6', '-1 -1', '挂个-2', '-2 -3 -4'],
  extra: ['', '', '收租', '试下', '这个区间', '3张', 'SPX', 'QQQ', '明天', '涨到', '可以'],
};
for (let i = 0; i < 2500; i += 1) {
  const parts = rnd() < 0.7
    ? [pick(pieces.verb), pick(pieces.prem), pick(pieces.center), pick(pieces.wing), pick(pieces.qty), pick(pieces.sym), pick(pieces.right), pick(pieces.misc)]
    : [pick(spreadPieces.strikes), pick(spreadPieces.type), pick(spreadPieces.credit), pick(spreadPieces.extra), pick(pieces.misc)];
  for (let k = parts.length - 1; k > 0; k -= 1) { if (rnd() < 0.3) { const j = Math.floor(rnd() * (k + 1)); [parts[k], parts[j]] = [parts[j], parts[k]]; } }
  texts.add(parts.join(pick([' ', '', ' ', ','])));
}
const perturb = (t) => {
  const r = rnd();
  if (r < 0.06) return t.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));
  if (r < 0.1) return t.replace(/ /g, '　');
  if (r < 0.13) return t.replace(/ /g, ' ');
  if (r < 0.15) return '﻿' + t;
  if (r < 0.17) return t + ' ';
  if (r < 0.19) return t + ' \ud83d';
  if (r < 0.21) return '\udc00' + t;
  if (r < 0.23) return t + ' 理由:x\ud800y';
  if (r < 0.25) return t + '\n';
  if (r < 0.27) return ' ' + t + '  ';
  if (r < 0.28) return t.toUpperCase();
  if (r < 0.29) return t.repeat(3);
  return t;
};
const all = [...texts].flatMap((t) => (rnd() < 0.4 ? [t, perturb(t)] : [t]));
all.push('', '   ', '蝴蝶', '理由:', 'x'.repeat(81) + '蝴蝶 15cm', '\ud800', '7520蝴蝶 15cm😀');
// 写明的边:JS 才认的空白夹在中间(NFKC 之后还留着的那几个)、理由里的行分隔符、翼宽 500、中心 = 翼宽、偏离 20%、
// 1000 ≤ 中心 ≤ 2×翼宽、两个小数、相对行权价正好离 50 点、收的正好等于宽度、价差样子 + 翼宽记号、两个类型词
const ws = ['﻿', ' ', ' ', ' ', '　', ' ', ' ', ' '];
for (const w of ws) {
  all.push(`7520蝴蝶 15${w}cm`, `7520${w}蝴蝶${w}15cm`, `7520蝴蝶 翼宽${w}15`, `7520蝴蝶 ±${w}10${w}点`, `7520蝴蝶 15cm${w}2张`, `7520蝴蝶 15cm 权利金${w}2`,
    `7770 7775 bear${w}call -2`, `7770 7775 bull put -2${w}-2.5`, `7770${w}7775 bull put -2`, `7520蝴蝶 15cm 理由${w}:看好`, `7520蝴蝶 15cm${w}理由:看好`);
}
for (const t of [' ', ' ', '\r', '\n', '\u0085']) all.push(`7520蝴蝶 15cm 理由:看好${t}后市`, `7520蝴蝶 15cm 理由:${t}`);
all.push('7520蝴蝶 500cm', '7520蝴蝶 501cm', '500的看涨蝴蝶 500cm', '501的看涨蝴蝶 500cm', '1000 看涨 蝴蝶 500cm', '1001 看涨 蝴蝶 500cm',
  '7520 1.5 2 15cm 蝴蝶', '7520 1.5 15cm 蝴蝶', '9100蝴蝶 15cm', '9000蝴蝶 15cm', '6000蝴蝶 15cm', '00 05 bull put -1', '00 05 bear call -1',
  '7770 7775 bear call -5', '7770 7775 bear call -4.99', '7770 7775 -2 15cm', '7770 7775 -2 翼宽 5', '7770 7775 bear call bull put -2', 'QQQ X 7520蝴蝶 15cm',
  '蝴蝶 1000 看涨 500cm', '看涨蝴蝶 1001 500cm', '蝴蝶 7520 1.5 2 15cm', '蝴蝶 7520 1.5 15cm', '蝴蝶 7520 15cm 权利金 2 1',
  '7000 7500 bear call -2', '7000 7501 bear call -2', '7000 7500 bull put -2', '7501 7000 bear call -2');


// ---- 时刻与现价
const moments = ['2026-08-14T10:32:00-04:00', '2026-10-16T15:00:00-04:00', '2026-10-17T11:00:00-04:00', '2026-10-18T09:00:00-04:00', '2026-10-19T09:31:00-04:00', '2026-12-31T12:00:00-05:00']
  .map((s) => C.etNowFromEpoch(Date.parse(s)));
const snaps = [{ SPX: 7512.3, QQQ: 612.4, SPY: 600 }, { SPX: 6907.35 }, {}, { SPX: '7600' }, { SPX: null }, { SPX: NaN }, { SPX: 7550, QQQ: 'x' }, { SPX: 7700.5 }, { SPX: 7550 }, { SPX: 7520 },
  { SPX: 7552.5 }, { SPX: 7500 }, { SPX: 7583.34 }];

const out = { looks: [], parses: [] };
const crafted = new Set(all.slice(-200));
for (const t of all) {
  out.looks.push({ t: hex(t), shorthand: S.looksLikeShorthand(t), order: S.looksLikeOrder(t), noType: S.spreadWithoutType(t), symbols: S.shorthandSymbols(t) });
  const reps = crafted.has(t) ? snaps.length : rnd() < 0.3 ? 2 : 1;
  for (let k = 0; k < reps; k += 1) {
    const m = crafted.has(t) ? moments[k % 2 === 0 ? 0 : 4] : pick(moments), snap = crafted.has(t) ? snaps[k] : pick(snaps), meta = { relativeCenter: 'unset' };
    let res;
    try { res = { out: enc(S.tryParseShorthand(t, snap, m, meta)) }; } catch (e) { res = { error: `${e.constructor.name}: ${e.message}` }; }
    // reason / original_text 里可能有落单的代理项:按 UTF-16 存那两格
    const fix = (o) => {
      for (const order of o?.orders ?? []) order.reason = { hex: hex(order.reason) };
      for (const rej of o?.rejections ?? []) rej.original_text = { hex: hex(rej.original_text) };
      return o;
    };
    if (res.out && res.out !== null) {
      const raw = S.tryParseShorthand(t, snap, m);
      res.out = enc(fix(raw));
    }
    out.parses.push({ t: hex(t), moment: m, snap: enc(snap), meta: meta.relativeCenter, ...res });
  }
}
writeFileSync(join(here, 'shorthand.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('shorthand.json', `texts=${all.length}`, `parses=${out.parses.length}`, `hits=${out.parses.filter((p) => p.out && p.out !== null && p.out.orders?.length).length}`,
  `rejections=${out.parses.filter((p) => p.out?.rejections?.length).length}`);
