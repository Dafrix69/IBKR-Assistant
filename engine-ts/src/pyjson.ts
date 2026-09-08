/** 浮点感知的 JSON 解析与 Python 风格序列化。
 *
 * 提示词指纹 = sha256(system + "\n--\n" + json.dumps(fewshot, sort_keys=True,
 * ensure_ascii=False))。Python 把 "7520.0" 解析成 float、dumps 回 "7520.0";
 * JSON.parse 会丢掉这个信息(变成 7520)。这里自带解析器,数字带 float 标记。
 */

export type JVal =
  | { kind: "null" }
  | { kind: "bool"; value: boolean }
  | { kind: "int"; text: string }
  | { kind: "float"; value: number }
  | { kind: "str"; value: string }
  | { kind: "arr"; items: JVal[] }
  | { kind: "obj"; entries: Array<[string, JVal]> };

export function parseJson(text: string): JVal {
  let i = 0;

  const skipWs = (): void => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };

  const parseValue = (): JVal => {
    skipWs();
    const ch = text[i];
    if (ch === "{") return parseObj();
    if (ch === "[") return parseArr();
    if (ch === '"') return { kind: "str", value: parseString() };
    if (text.startsWith("true", i)) {
      i += 4;
      return { kind: "bool", value: true };
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return { kind: "bool", value: false };
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return { kind: "null" };
    }
    // number
    const start = i;
    if (text[i] === "-") i++;
    while (i < text.length && /[0-9]/.test(text[i]!)) i++;
    let isFloat = false;
    if (text[i] === ".") {
      isFloat = true;
      i++;
      while (i < text.length && /[0-9]/.test(text[i]!)) i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      isFloat = true;
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      while (i < text.length && /[0-9]/.test(text[i]!)) i++;
    }
    const raw = text.slice(start, i);
    if (!raw || raw === "-") throw new Error(`JSON 解析失败于位置 ${start}`);
    return isFloat ? { kind: "float", value: Number(raw) } : { kind: "int", text: raw };
  };

  const parseString = (): string => {
    // text[i] === '"'
    i++;
    let out = "";
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '"') {
        i++;
        return out;
      }
      if (ch === "\\") {
        const esc = text[i + 1]!;
        i += 2;
        if (esc === "u") {
          out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16));
          i += 4;
        } else {
          out += ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as
            Record<string, string>)[esc] ?? esc;
        }
      } else {
        out += ch;
        i++;
      }
    }
    throw new Error("JSON 字符串未闭合");
  };

  const parseArr = (): JVal => {
    i++; // [
    const items: JVal[] = [];
    skipWs();
    if (text[i] === "]") {
      i++;
      return { kind: "arr", items };
    }
    for (;;) {
      items.push(parseValue());
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return { kind: "arr", items };
      }
      throw new Error(`JSON 数组解析失败于位置 ${i}`);
    }
  };

  const parseObj = (): JVal => {
    i++; // {
    const entries: Array<[string, JVal]> = [];
    skipWs();
    if (text[i] === "}") {
      i++;
      return { kind: "obj", entries };
    }
    for (;;) {
      skipWs();
      const key = parseString();
      skipWs();
      if (text[i] !== ":") throw new Error(`JSON 对象缺少冒号于位置 ${i}`);
      i++;
      entries.push([key, parseValue()]);
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return { kind: "obj", entries };
      }
      throw new Error(`JSON 对象解析失败于位置 ${i}`);
    }
  };

  const out = parseValue();
  skipWs();
  return out;
}

/** JVal → 普通 JS 值(丢弃 float 标记,给业务侧用)。 */
export function toPlain(v: JVal): unknown {
  switch (v.kind) {
    case "null":
      return null;
    case "bool":
      return v.value;
    case "int":
      return Number(v.text);
    case "float":
      return v.value;
    case "str":
      return v.value;
    case "arr":
      return v.items.map(toPlain);
    case "obj": {
      const out: Record<string, unknown> = {};
      for (const [k, val] of v.entries) out[k] = toPlain(val);
      return out;
    }
  }
}

/** Python repr(float) —— 整数值带 .0,其余最短表示。 */
function floatRepr(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return `${v}.0`;
  const s = String(v);
  const m = s.match(/^(-?[\d.]+)e([+-])(\d+)$/);
  if (m) return `${m[1]}e${m[2]}${m[3]!.padStart(2, "0")}`;
  return s;
}

function escapeStr(s: string): string {
  // Python json.dumps(ensure_ascii=False):只转义 " \ 与控制字符
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

/** json.dumps(v, ensure_ascii=False) —— 保持键序,默认分隔符 (", ", ": ")。 */
export function pyDumps(v: JVal): string {
  switch (v.kind) {
    case "null":
      return "null";
    case "bool":
      return v.value ? "true" : "false";
    case "int":
      return String(Number(v.text));
    case "float":
      return floatRepr(v.value);
    case "str":
      return escapeStr(v.value);
    case "arr":
      return "[" + v.items.map(pyDumps).join(", ") + "]";
    case "obj":
      return "{" + v.entries.map(([k, val]) => `${escapeStr(k)}: ${pyDumps(val)}`).join(", ") + "}";
  }
}

/** json.dumps(v, ensure_ascii=False, sort_keys=True) —— 默认分隔符 (", ", ": ")。 */
export function pyDumpsSorted(v: JVal): string {
  switch (v.kind) {
    case "null":
      return "null";
    case "bool":
      return v.value ? "true" : "false";
    case "int":
      return String(Number(v.text));
    case "float":
      return floatRepr(v.value);
    case "str":
      return escapeStr(v.value);
    case "arr":
      return "[" + v.items.map(pyDumpsSorted).join(", ") + "]";
    case "obj": {
      const entries = [...v.entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return "{" + entries.map(([k, val]) => `${escapeStr(k)}: ${pyDumpsSorted(val)}`).join(", ") + "}";
    }
  }
}
