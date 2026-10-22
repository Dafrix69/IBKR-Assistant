// 生成 level-strip.json:价位条的排版(desktop/renderer-react/src/lib/LevelStrip.tsx 的 buildLevelStripSvg)现算的结果,
// C++ 的 shell/level_strip 逐个元素对:轴、断口、引线、刻度、现价点、每个标签的位置与文字。
// 原文件是 .tsx(组件部分有 JSX),这里只要 buildLevelStripSvg 及它上面的纯函数:切出来、去掉类型,在一个最小的假 DOM 里跑。
// 量字宽换成确定的规则(每个字符宽度固定,汉字两倍),C++ 那边用同一条规则——比的是排版算法,不是字体。
//   node native/tests/fixtures/gen_level_strip.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '..', '..', '..', 'desktop/renderer-react/src/lib');
const src = readFileSync(join(lib, 'LevelStrip.tsx'), 'utf8');
const start = src.indexOf('const CORE_PCT');
const end = src.indexOf('/** 会按容器宽度自绘的价位条。 */');
let body = src.slice(start, end)
  .replace('let measureCtx: CanvasRenderingContext2D | null = null;', 'let measureCtx = null;')
  .replace('function measure(text: string, mono: boolean, weight: number): number {', 'function measure(text, mono, weight) {')
  .replace('function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {', 'function svgEl(tag, attrs) {')
  .replace(/interface Item \{[\s\S]*?\n\}\n/, '')
  .replace('function spread(items: Item[], width: number, gap: number): void {', 'function spread(items, width, gap) {')
  .replace('function lanes(items: Item[], gap: number): Item[][] {', 'function lanes(items, gap) {')
  .replace('const out: Item[][] = [];', 'const out = [];')
  .replace('function scale(prices: number[], spot: number | null, width: number, margin: number) {', 'function scale(prices, spot, width, margin) {')
  .replace('const xOf = (price: number): number => {', 'const xOf = (price) => {')
  .replace('const breaks: number[] = [];', 'const breaks = [];')
  .replace('function fmtLevelPrice(price: number): string {', 'function fmtLevelPrice(price) {')
  .replace('export function buildLevelStripSvg(levels: AlertLevel[], spot: number | null | undefined, width: number): SVGElement | null {', 'function buildLevelStripSvg(levels, spot, width) {')
  .replace('const pts: { price: number; level?: AlertLevel; spot?: boolean }[] = (levels || [])', 'const pts = (levels || [])')
  .replace('const items: Item[] = pts.map((pt) => {', 'const items = pts.map((pt) => {')
  .replace('const labelY = (it: Item) =>', 'const labelY = (it) =>');
if (/: (number|string|Item|AlertLevel|SVGElement|boolean)\b/.test(body)) throw new Error('还有没去掉的类型标注:' + body.match(/.{40}: (number|string|Item|AlertLevel|SVGElement|boolean)\b.{20}/)[0]);

// 字宽:ASCII 每个 0.6 × 字号、别的(汉字、希腊字母)1 × 字号;粗细与等宽不影响——C++ 的 measureFixed 同一条
const charWidth = (text, size) => [...text].reduce((w, ch) => w + (ch.charCodeAt(0) < 128 ? 0.6 : 1) * size, 0);
class El {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.textContent = ''; }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(c) { this.children.push(c); return c; }
}
const document = {
  createElementNS: (_ns, tag) => new El(tag),
  createElement: () => ({ getContext: () => ({ set font(f) { this._f = f; }, measureText: (t) => ({ width: charWidth(t, 10) }) }) }),
  documentElement: {}, body: {},
};
const getComputedStyle = () => ({ getPropertyValue: () => 'mono', fontFamily: 'sans' });
const isOwnLine = (l) => String(l?.source ?? '').startsWith('own:');
const T = await import(join(lib, 'trackLevels.ts'));
// 两张名字表在 store/alerts.ts(它引 zustand,这里不跑它):从源文件里把字面量整张切出来求值,不手抄
const alertsSrc = readFileSync(join(lib, '../store/alerts.ts'), 'utf8');
const table = (name) => {
  const m = alertsSrc.match(new RegExp(`export const ${name}: Record<string, string> = (\\{[\\s\\S]*?\\});`));
  if (!m) throw new Error(`store/alerts.ts 里找不到 ${name}`);
  return new Function(`return ${m[1]};`)();
};
const A = { ALERT_SOURCE_SHORT: table('ALERT_SOURCE_SHORT'), ALERT_SOURCE_LABEL: table('ALERT_SOURCE_LABEL') };
const build = new Function('document', 'getComputedStyle', 'isOwnLine', 'ALERT_SOURCE_SHORT', 'ALERT_SOURCE_LABEL', `${body}\nreturn buildLevelStripSvg;`)(
  document, getComputedStyle, isOwnLine, A.ALERT_SOURCE_SHORT, A.ALERT_SOURCE_LABEL);

const dump = (el) => (el ? { tag: el.tag, attrs: el.attrs, text: el.textContent || undefined, children: el.children.map(dump) } : null);
const L = (price, source, label, kind = 'pivot') => ({ price, source, label, kind });
const nvda = [L(230, 'call_wall', 'Call 墙', 'resistance'), L(225, 'call_vol_wall', '成交墙', 'resistance'), L(220, 'round', '整数关口'), L(221.3, 'ma20', '20日线'), L(218.6, 'gamma_flip', 'Gamma'),
  L(215, 'max_pain', '痛点'), L(215, 'round', '整数关口'), L(210, 'put_wall', 'Put 墙', 'support'), L(196.4, 'ma60', '60日线')];
const far = [...nvda, L(380, 'high_52w', '52周高'), L(90, 'low_52w', '52周低', 'support')];
const own = T.ownLines('STK', { stop_loss: 200, take_profit: 240 }, { stop_effective: 213.75 });
const cases = [];
for (const [name, levels, spot, width] of [
  ['NVDA 墙与均线', nvda, 219.74, 1005], ['加上自己的线', [...nvda, ...own], 219.74, 1005], ['窄', nvda, 219.74, 360], ['两端压缩区', far, 219.74, 700],
  ['没有现价', nvda, null, 700], ['只有现价', [], 100, 300], ['空', [], null, 300], ['一个价位', [L(7700, 'put_wall', 'Put 墙', 'support')], 7712.25, 500],
  ['SPX 一团挤在一起', [7680, 7690.4, 7700, 7725, 7735, 7750, 7775].map((p, i) => L(p, ['put_vol_wall', 'ma20', 'put_wall', 'max_pain', 'gamma_flip', 'call_wall', 'call_vol_wall'][i], 'x')), 7722.35, 1005],
  ['价位相同', [L(100, 'round', 'a'), L(100, 'ma20', 'b'), L(100, 'max_pain', 'c')], 100, 400],
]) cases.push({ name, levels, spot, width, svg: dump(build(levels, spot, width)) });
writeFileSync(join(here, 'level-strip.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_level_strip.mjs', short: A.ALERT_SOURCE_SHORT, label: A.ALERT_SOURCE_LABEL, cases }, null, 2) + '\n');
console.log(`level-strip.json: ${cases.length} cases`);
