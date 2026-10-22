// 生成 v8json.json:V8 的 JSON.parse 在一大把坏文本上报的那句话(TS 引擎读配置读坏了时把它原样给用户看:
// 「配置文件不是合法的 JSON(多半是手改时少了逗号或引号):Unexpected token ...」)。
// 手写的边角(各种错的位置、上下文截取的三种样子、行列、\r\n、BOM、代理对)外加对几份真配置文本的随机损坏(删一个字、插一个字、换一个字)。
//   node native/tests/fixtures/gen_v8json.mjs <编过的 engine-ts 目录>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const docs = [readFileSync(join(engine, 'baseline/rpc/base_config.json'), 'utf8'), JSON.stringify(JSON.parse(readFileSync(join(engine, 'baseline/rpc/base_config.json'), 'utf8'))),
  '{"a":[1,-2.5e3,true,false,null,"x\\n\\u00e9"],"b":{"c":"中文"}}', '[0, 1.0, -0, 1E+2, "\\"\\\\\\/\\b\\f\\n\\r\\t"]', '{"k":"😀","r":"\r\n"}'.replace('\r\n', '\\r\\n')];
const hand = ['', ' ', '\n', '{', '}', ']', ':', ',', 'not json', 'nul', 'tru', 'fals', 'nulL', 'tr1', 'tr"', 'tr ', 'trueX', 'true false', '{"a":1,}', '{"a" 1}', '{a:1}', '[1,2', '[1,]', '[1 2]',
  '{"a":1} x', '"abc', '"a\\x"', '"a\u0001"', '"a\u001f"', '"a\u007f"', '-', '-a', '--1', '-01', '01', '00', '0x1', '1.', '1.e1', '.5', '1e', '1e+', '1e-x', '1E5', '1.5.5', '{"a":1,"b":}',
  '{,}', '﻿{}', '{"a":"\\u12"}', '{"a":"\\u12', '"\\', '"\\u', '"\\uZ000"', '"\\u00e9"', '[', '[[', '[1,[2,]]', '{"a"', '{"a":', '{"a":1', '{"a":1,', '{"a":1,"b"', '{"a":{"b":1}',
  'x'.repeat(19), 'x'.repeat(20), 'x'.repeat(21), 'x'.repeat(22), 'x'.repeat(60), '[' + '1,'.repeat(15) + 'x]', '[' + '1,'.repeat(4) + 'x' + ',1'.repeat(10) + ']', '1'.repeat(30) + 'x',
  ' '.repeat(9) + 'x' + ' '.repeat(11), ' '.repeat(10) + 'x' + ' '.repeat(10), ' '.repeat(11) + 'x' + ' '.repeat(9), ' '.repeat(10) + 'x' + ' '.repeat(9), ' '.repeat(10) + 'x' + ' '.repeat(11),
  '{"long":"' + 'y'.repeat(40) + '", bad}', '{\n  "a": 1,\n  "b": 2\n  "c": 3\n}', '{\r\n  "a": 1\r\n  "b": 2\r\n}', '{\r  "a": 1\r  "b"}', '{\n\r"a" 1}', '{"a":1}\n\n}', 'NaN', 'Infinity',
  '-Infinity', 'undefined', '[object Object]', 'nan', '[-]', '[.5]', '{"a":tru}', '\t\n{"x": [1, 2, 3,, 4]}', '{"中文":"值" "x"}', '😀', '{"a":1}😀', '[1]😀', '"😀', '{"😀":1 2}',
  ' {}', '{} ', ' {}', '{"a":1}\u0000', '{"a":"b\u0000"}', '"\ud800"', '[1,2]]', '{"a":1}}', '{"a":1]', '[1}', '{"a":[}', '{"a" : , }', '"a"b', '1 2', 'true1', '{"__proto__":1,}'];
let seed = 20261019;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const alphabet = ['{', '}', '[', ']', ',', ':', '"', '\\', ' ', '\n', '\r', '\t', '0', '1', '-', '+', '.', 'e', 'E', 'x', 'u', 't', 'n', 'f', 'a', '中', '😀', '\u0001', '﻿'];
const random = [];
for (let i = 0; i < 4000; i++) {
  let t = docs[Math.floor(rnd() * docs.length)];
  for (let k = 0, n = 1 + Math.floor(rnd() * 3); k < n; k++) {
    const at = Math.floor(rnd() * (t.length + 1));
    const op = Math.floor(rnd() * 3);
    const ch = alphabet[Math.floor(rnd() * alphabet.length)];
    t = op === 0 ? t.slice(0, at) + t.slice(at + 1) : op === 1 ? t.slice(0, at) + ch + t.slice(at) : t.slice(0, at) + ch + t.slice(at + 1);
  }
  random.push(t);
}
const run = (t) => { try { JSON.parse(t); return { t, ok: true }; } catch (e) { return { t, e: e.message }; } };
const cases = [...hand, ...docs, ...random].map(run);
writeFileSync(join(here, 'v8json.json'), JSON.stringify({ node: process.version, cases }, null, 0) + '\n');
console.log(`v8json.json:${cases.length} 条(${cases.filter((c) => c.e).length} 条报错),node ${process.version}`);
