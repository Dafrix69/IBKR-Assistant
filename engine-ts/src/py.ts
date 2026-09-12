/** Python 兼容的数值格式化与舍入。
 *
 * 对拍一致性的地基:Python 的 round() 是十进制正确舍入(nd=0 时平分取偶),
 * str(float) 对整数值带 ".0","%g" 是 6 位有效数字——这些都和 JS 默认行为不同,
 * 而黄金对拍里的每一条 message/readout 字符串都依赖它们逐字节一致。
 */

/** Python round(x, nd):十进制正确舍入,平分取偶。
 *
 * 精确的 .5 平局只可能发生在二进可表示(dyadic)的值上——46.25、0.5、7520.125
 * 这类价格在行情里真实存在,所以不能只在 nd=0 处理。dyadic 的十进制展开是有限的
 * (≤ ~55 位),用足够长的 toFixed 展开检测"nd 位之后恰好是 5 后接全 0"。 */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x)) return x;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  if (ax >= 1e21) return x; // toFixed 之外的量级,交易数值不会到这里
  const expand = Math.min(100, Math.max(nd + 55, 20));
  const s = ax.toFixed(expand);
  const dot = s.indexOf(".");
  const frac = s.slice(dot + 1);
  const tail = frac.slice(nd);
  if (/^50*$/.test(tail)) {
    // 精确平局 → 取偶
    const truncStr = nd > 0 ? s.slice(0, dot) + "." + frac.slice(0, nd) : s.slice(0, dot);
    const lastDigit = nd > 0 ? Number(frac[nd - 1]) : Number(s[dot - 1]);
    let out = parseFloat(truncStr);
    if (lastDigit % 2 === 1) {
      out = parseFloat((out + Math.pow(10, -nd)).toFixed(nd));
    }
    return sign * out;
  }
  return sign * parseFloat(ax.toFixed(nd));
}

/** "%.Nf" —— C printf 定点(IEEE 最近舍入,平分取偶;toFixed 是平分远离零)。 */
export function fmtF(x: number, nd: number): string {
  if (!Number.isFinite(x)) return x > 0 ? "inf" : Number.isNaN(x) ? "nan" : "-inf";
  let s = pyRound(x, nd).toFixed(nd);
  if ((x < 0 || Object.is(x, -0)) && !s.startsWith("-") && Number(s) === 0) s = "-" + s;
  return s;
}

/** "%+.Nf" —— 带符号定点。 */
export function fmtSF(x: number, nd: number): string {
  const s = fmtF(x, nd);
  return s.startsWith("-") ? s : "+" + s;
}

/** "%g" —— 6 位有效数字,去尾零,必要时科学计数(指数 <-4 或 >=6)。 */
export function pyG(v: number): string {
  if (v === 0) return Object.is(v, -0) ? "-0" : "0";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : Number.isNaN(v) ? "nan" : "-inf";
  const [mRaw, eRaw] = v.toExponential(5).split("e") as [string, string];
  const e = parseInt(eRaw, 10);
  if (e < -4 || e >= 6) {
    let m = mRaw;
    if (m.includes(".")) m = m.replace(/0+$/, "").replace(/\.$/, "");
    const sign = e < 0 ? "-" : "+";
    return `${m}e${sign}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  let s = v.toFixed(Math.max(0, 5 - e));
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/** Python str(float):整数值带 ".0",指数格式至少两位指数。用在所有 "%s" % <float> 处。 */
export function pyFloat(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? "inf" : Number.isNaN(v) ? "nan" : "-inf";
  if (Number.isInteger(v) && Math.abs(v) < 1e16) {
    return (Object.is(v, -0) ? "-0" : String(v)) + ".0";
  }
  const a = Math.abs(v);
  if (a >= 1e16 || (a > 0 && a < 1e-4)) {
    // Python repr 在这个区间转科学计数;JS 阈值不同(<1e-6 / >=1e21),补齐差异
    const [m, eRaw] = v.toExponential().split("e") as [string, string];
    // 用最短表示:toExponential() 不带精度时即最短
    const e = parseInt(eRaw, 10);
    const sign = e < 0 ? "-" : "+";
    return `${m}e${sign}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  const s = String(v);
  const m = s.match(/^(-?[\d.]+)e([+-])(\d+)$/);
  if (m) return `${m[1]}e${m[2]}${m[3]!.padStart(2, "0")}`;
  return s;
}

/** Python repr():字符串单引号,None/True/False,浮点同 pyFloat。用在 "%r" 处。 */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") {
    return Number.isInteger(v) && !floatMarked(v) ? String(v) : pyFloat(v);
  }
  if (typeof v === "string") {
    // Python repr 优先单引号;含单引号且不含双引号时用双引号
    const useDouble = v.includes("'") && !v.includes('"');
    const q = useDouble ? '"' : "'";
    let out = q;
    for (const ch of v) {
      if (ch === "\\") out += "\\\\";
      else if (ch === q) out += "\\" + q;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += ch;
    }
    return out + q;
  }
  return String(v);
}

// pyRepr 需要区分 int 与 float 的场景由调用方直接用 pyFloat;这里仅按整数值判断。
function floatMarked(_v: number): boolean {
  return false;
}

/** "%d" —— 向零取整后十进制。 */
export function fmtD(x: number): string {
  return String(Math.trunc(x));
}

/** Python 的真值语义:0 / -0 / NaN? —— NaN 在 Python 是 truthy;0 与 "" 与 null 是 falsy。 */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "number") return v !== 0; // NaN !== 0 → truthy,与 Python 一致
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** 有限数解析,非法回 null(对应各模块的 _finite / _num 帮手)。 */
export function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const out = typeof value === "number" ? value : Number(value);
  return Number.isFinite(out) ? out : null;
}
