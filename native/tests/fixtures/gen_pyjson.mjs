// 生成 pyjson.json:engine-ts/src/pyjson.ts 的 parseJson / pyDumps / pyDumpsSorted / toPlain(原模块现跑),
// 输入是 prompts/ 下每一份真的 fewshot 文件,外加一把边角(浮点记号、转义、宽松处、读不出的)。
//   node native/tests/fixtures/gen_pyjson.mjs <编过的 engine-ts 目录>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const pj = await import(pathToFileURL(join(engine, 'dist/src/pyjson.js')).href);

const texts = [];
for (const f of readdirSync(join(repo, 'prompts')).filter((n) => n.endsWith('.json')).sort()) texts.push({ name: f, text: readFileSync(join(repo, 'prompts', f), 'utf8') });
const edge = ['7520.0', '7520', '-0', '-0.0', '1e3', '1E-7', '0.1', '1.5e300', '123456789012345678901234567890', '-12.50', '{"b": 1, "a": [1.0, 2, "x"], "A": null}',
  '{"z": {"y": true, "x": false}, "é": "中文", "\\u00e9": 1}', '"a\\"b\\\\c\\/d\\b\\f\\n\\r\\t"', '"\\u4e2d\\u6587"', '"\\uZZZZ"', '"\\q"', '"ctrl\\u0001x"',
  '[ 1 , 2 ,3 ]', '  {"a" : 1}  trailing', '[]', '{}', '[[]]', '{"k": {}}', '"unterminated', '[1, 2', '{"a" 1}', '{"a": 1 "b": 2}', '-', '', 'x', '{"dup": 1, "dup": 2}',
  '{"b": 1, "a": 2, "B": 3, "_": 4, "1": 5}', '"emoji 😀"', '[1.0e2, 1e21, 1.0e-5, 100.0, 0.0001]'];
edge.forEach((t, i) => texts.push({ name: `edge${i}`, text: t }));
const cases = texts.map(({ name, text }) => {
  try {
    const v = pj.parseJson(text);
    return { name, text, dumps: pj.pyDumps(v), sorted: pj.pyDumpsSorted(v), plain: JSON.stringify(pj.toPlain(v)) };
  } catch (e) {
    return { name, text, error: e.message };
  }
});
writeFileSync(join(here, 'pyjson.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_pyjson.mjs', cases }, null, 1) + '\n');
console.log(`pyjson.json:${cases.length} 段`);
