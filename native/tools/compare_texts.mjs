// 排版对照:Qt 版(--dump-texts)和 React 版(text_dump.js)量出来的字逐段对。
//   node native/tools/compare_texts.mjs <qt.json> <react.json> [--anchor 某段字] [--from 某段字] [--to 某段字] [--tol 2]
// 两边按文字内容对齐(最长公共子序列),以 anchor 那段字为原点比相对位置(两边滚动位置、窗口原点不必一样),
// 报出:只有一边有的字、位置差超过 tol 像素的、字号或字重不一样的、颜色不一样的(任一通道差过 0.04)。退出码:有差别 1,没有 0。
import { readFileSync } from 'node:fs';

const [qtPath, reactPath, ...rest] = process.argv.slice(2);
const opt = (name, def) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : def; };
const tol = Number(opt('--tol', '2'));
const norm = (s) => s.replace(/\s+/g, ' ').replace(/[​]/g, '').trim();
const qt = JSON.parse(readFileSync(qtPath, 'utf8')).map((t) => ({ ...t, text: norm(t.text) }));
const react = JSON.parse(readFileSync(reactPath, 'utf8')).map((t) => ({ ...t, text: norm(t.text) }));
const order = (list) => list.slice().sort((a, b) => a.y - b.y || a.x - b.x);
// --from / --to:只比两段字之间的那一截(含两头;按从上到下、从左到右的次序),比如一张卡片
const from = opt('--from', null), to = opt('--to', null);
const scope = (list) => {
  const i = from === null ? 0 : list.findIndex((t) => t.text === from);
  const rest = list.slice(Math.max(0, i));
  const j = to === null ? rest.length - 1 : rest.findIndex((t) => t.text === to);
  return rest.slice(0, j < 0 ? rest.length : j + 1);
};
const A = scope(order(qt)), B = scope(order(react));

// 最长公共子序列(按文字)
const n = A.length, m = B.length;
const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = A[i].text === B[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
const pairs = [], onlyQt = [], onlyReact = [];
for (let i = 0, j = 0; i < n || j < m;) {
  if (i < n && j < m && A[i].text === B[j].text) { pairs.push([A[i], B[j]]); i += 1; j += 1; }
  else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) { onlyQt.push(A[i]); i += 1; }
  else { onlyReact.push(B[j]); j += 1; }
}
const anchorText = opt('--anchor', pairs[0]?.[0].text);
const anchor = pairs.find(([a]) => a.text === anchorText);
if (!anchor) { console.error(`两边都找不到 anchor「${anchorText}」`); process.exit(2); }
const [qa, ra] = anchor;
/** 颜色 → [r, g, b, a](0..1):Qt 写 #aarrggbb / #rrggbb,浏览器写 rgb() / rgba() / color(srgb r g b / a) */
function rgba(c) {
  if (typeof c !== 'string') return null;
  let m = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (m) return [m[2], m[3], m[4], m[1]].map((h) => parseInt(h, 16) / 255);
  m = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (m) return [...[m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255), 1];
  m = c.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
  if (m) return [m[1] / 255, m[2] / 255, m[3] / 255, m[4] === undefined ? 1 : Number(m[4])];
  m = c.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  return null;
}
const colorDiff = (a, b) => { const x = rgba(a), y = rgba(b); return x && y ? Math.max(...x.map((v, i) => Math.abs(v - y[i]))) : 0; };
let bad = 0;
const rows = [];
for (const [a, b] of pairs) {
  const dx = (a.x - qa.x) - (b.x - ra.x), dy = (a.y - qa.y) - (b.y - ra.y);
  const notes = [];
  if (Math.abs(dx) > tol || Math.abs(dy) > tol) notes.push(`位置差 dx ${dx.toFixed(1)} dy ${dy.toFixed(1)}`);
  if (Math.abs(a.w - b.w) > tol) notes.push(`宽 ${a.w} ≠ ${b.w}`);
  if (Math.abs(a.size - b.size) > 0.3) notes.push(`字号 ${a.size} ≠ ${b.size}`);
  if (Math.abs(a.weight - b.weight) > 60) notes.push(`字重 ${a.weight} ≠ ${b.weight}`);
  if (colorDiff(a.color, b.color) > 0.04) notes.push(`颜色 ${a.color} ≠ ${b.color}`);
  if (notes.length) { bad += 1; rows.push(`  「${a.text.slice(0, 40)}」 ${notes.join(';')}`); }
}
console.log(`对上 ${pairs.length} 段,只在 Qt ${onlyQt.length} 段,只在 React ${onlyReact.length} 段;以「${anchorText.slice(0, 30)}」为原点,差别超过 ${tol}px 或字号字重颜色不同的 ${bad} 段`);
if (rows.length) console.log(rows.join('\n'));
if (onlyQt.length) console.log('只在 Qt:\n' + onlyQt.map((t) => `  「${t.text.slice(0, 60)}」 @${t.x},${t.y}`).join('\n'));
if (onlyReact.length) console.log('只在 React:\n' + onlyReact.map((t) => `  「${t.text.slice(0, 60)}」 @${t.x},${t.y}`).join('\n'));
process.exit(bad || onlyQt.length || onlyReact.length ? 1 : 0);
