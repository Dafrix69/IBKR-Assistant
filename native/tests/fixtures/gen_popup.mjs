// 生成 popup.json:提醒弹窗的内容清洗与摆放(desktop/popup-window.js 的 sanitizePopupPayload / popupBounds)现算的结果,
// C++ 的 shell/popup_rules 逐条对。Date.now 钉死(at 不是有限数时用它)。
//   node native/tests/fixtures/gen_popup.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const P = createRequire(import.meta.url)(join(here, '..', '..', '..', 'desktop/popup-window.js'));
const NOW = 1_789_150_800_000;
Date.now = () => NOW;

const raw = (id, extra = {}) => ({ id, kind: 'anomaly', symbol: 'RKLB', title: 'RKLB 放量 3.1×', body: '说明', tone: 'up', at: 1_000, ...extra });
const [NUL, TAB, LF, BEL, DEL, RLO, ZWSP, BOM] = ['\u0000', '\t', '\n', '\u0007', '\u007f', '‮', '​', '﻿'];
// JSON 表达不了 undefined:用 { "__undefined": true } 标出来,两边各自换回"没有这个键"
const payloads = [
  null, 42, 'x', [], { items: 'nope' }, { items: { 0: raw('a') } }, { items: [], updown: 'red-up' }, { items: [], updown: 'purple-up' },
  { items: Array.from({ length: 35 }, (_, i) => raw(`id${i}`)) }, { items: [raw('a'), { id: '' }] },
  { items: [raw('RKLB:burst:up:-:1789150800'), raw('level:SPX:5000.5:1789150800000'), raw('a b<script>c' + NUL + 'd'), raw('x'.repeat(150)), raw('<>!@#'), raw(''), { ...raw('tmp'), id: undefined }, null, 'string', [raw('arr')], raw(12345), raw('中文id:9')] },
  { items: ['brk.b', 'rds-a', 'AB C<D>', 'Z'.repeat(30), 123, 'ß-straße', null].map((s, i) => raw(`s${i}`, { symbol: s })) },
  { items: [raw('a', { title: 'RKLB' + TAB + '放量' + LF + LF + '3.1×' + BEL + DEL, body: '下' + RLO + '破' + ZWSP + BOM + ' 5000' + NUL }), raw('b', { title: '长'.repeat(200), body: 'b'.repeat(500) }),
    raw('c', { title: '😀'.repeat(100) }), raw('d', { title: '  前后空白　  ', body: 12.5 }), raw('e', { title: ' a '.repeat(40) + '尾', body: '\u0085x y⁠z' })] },
  { items: [raw('a', { tone: 'rainbow', kind: 'trade', page: 'orders', at: Number.NaN }), raw('b', { tone: 'down', kind: 'level', page: 'sectors', at: 5 }),
    raw('c', { title: '   ', body: undefined, at: '1000', page: undefined }), raw('d', { page: 'tracker', at: Infinity }), raw('e', { page: 'intel', kind: 'event', tone: 'info', at: -3.5 })] },
];
const encode = (v) => JSON.stringify(v, (_k, x) => (x === undefined ? { __undefined: true } : typeof x === 'number' && !Number.isFinite(x) ? { __number: String(x) } : x));
const cases = payloads.map((p) => ({ fn: 'sanitize', input: JSON.parse(encode(p)), out: P.sanitizePopupPayload(p) }));
const once = P.sanitizePopupPayload({ items: [raw('a:b c', { title: 'x' + LF + 'y', symbol: 'brk.b', tone: '?', page: 'quality' })], updown: 'red-up' });
cases.push({ fn: 'sanitize', input: once, out: P.sanitizePopupPayload(once) });
const WORK_A = { x: 1920, y: 25, width: 2560, height: 1415 };
for (const [area, h] of [[WORK_A, 150.2], [WORK_A, 20], [WORK_A, 5000], [WORK_A, null], [{ x: 0, y: 0, width: 800, height: 100 }, 400], [{ x: -1440, y: 0, width: 1440.5, height: 875 }, 96.01]])
  cases.push({ fn: 'bounds', input: { area, height: h }, out: P.popupBounds(area, h === null ? Number.NaN : h) });
writeFileSync(join(here, 'popup.json'), JSON.stringify({ generator: 'gen_popup.mjs', now: NOW, limits: P.POPUP_LIMITS, cases }, null, 1) + '\n');
console.log(`popup.json: ${cases.length} cases`);
