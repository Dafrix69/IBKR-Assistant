// 生成 tests/fixtures/zod-gaps.json:util/zod 与 util/ordered_json 里「早先的移植者绕过去的缺口」的对拍——zod 3.25.76 的原模块现跑。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tools/gen_zod_gaps.mjs <编过的 engine-ts 目录>
//
// 三块:
//   issues  :一批 schema × 一批输入,记下 safeParse 的 issue 清单,**带 keys / expected / received / unionErrors**(describeIssue 读的就是它们),
//             unionErrors 里每个分支的 issue 递归记。输入一律先写成 JSON 文本再 JSON.parse(同 RPC 的读法)。
//   values  :transform 可以返回 undefined、mergeObject 在「键在来稿里、值是 undefined」时的结果(键不出现 / 数组里是 null),按 JSON.stringify 的样子记。
//   numbers :JSON.parse 对各种数的读法(1e999、1e-400、-0、非规格化数的舍入边界……),util/ordered_json 的 parseOJson 要一样。
// schema 只给名字;C++ 那边(tests/tst_zod_gaps.cpp)按同样的名字用 util/zod 拼一遍。固定输入、无随机;同一台机器上跑两次逐字节相同。
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const { z } = await import(pathToFileURL(join(engine, 'node_modules/zod/index.js')).href);

const nullishTo = (s, fallback) => s.nullish().transform((v) => v ?? fallback);
const SCHEMAS = {
  req: () => z.object({ a: z.string() }),
  strictObj: () => z.object({ a: z.string(), b: z.number().optional() }).strict(),
  nestedStrict: () => z.object({ x: z.object({ y: z.string() }).strict(), z: z.array(z.object({ w: z.number() }).strict()) }).strict(),
  union3: () => z.object({ v: z.union([z.number(), z.string(), z.boolean()]) }),
  unionObj: () => z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
  unionDeep: () => z.object({ v: z.union([z.object({ c: z.object({ d: z.number() }) }), z.object({ c: z.object({ d: z.string() }) })]) }),
  unionNested: () => z.object({ v: z.union([z.union([z.number(), z.string()]), z.boolean()]) }),
  unionLit: () => z.object({ v: z.union([z.literal(''), z.literal(5)]) }),
  unionDirty: () => z.object({ v: z.union([z.number().int(), z.string()]) }),
  unionStrict: () => z.object({ v: z.union([z.object({ a: z.string() }).strict(), z.object({ b: z.number() }).strict()]) }),
  arrUnion: () => z.array(z.union([z.string(), z.object({ k: z.number() })])),
  enumField: () => z.object({ e: z.enum(['a', 'b']) }),
  recordNum: () => z.record(z.number()),
  record2: () => z.record(z.string(), z.object({ n: z.number() })),
  numberChecks: () => z.object({ n: z.number().int().min(1).max(5), s: z.string().min(2).max(3) }),
  pipeLike: () => z.object({ t: z.string().trim().min(1) }),
  // 键在来稿里、值被 transform 成 undefined
  objUndef: () => z.object({ a: nullishTo(z.string(), undefined), b: z.number(), c: nullishTo(z.number(), undefined) }),
  objUndefStrict: () => z.object({ a: nullishTo(z.string(), undefined), b: nullishTo(z.string(), '') }).strict(),
  arrUndef: () => z.array(nullishTo(z.number(), undefined)),
  recordUndef: () => z.record(nullishTo(z.string(), undefined)),
  unknownT: () => z.object({ u: z.unknown().transform((v) => v), w: z.unknown().transform((v) => v === undefined ? 'was-undefined' : v) }),
  optionalUnknownT: () => z.object({ u: z.unknown().optional().transform((v) => v) }),
  topUndef: () => z.unknown().transform(() => undefined),
  litNull: () => z.object({ v: z.literal(null) }),
  litTrue: () => z.object({ v: z.literal(true) }),
  litFalse: () => z.object({ v: z.literal(false) }),
  litStr: () => z.object({ v: z.literal('x') }),
  numBounds: () => z.object({ a: z.number().gte(1), b: z.number().lte(5), c: z.number().gt(1), d: z.number().lt(5), e: z.number().finite().optional() }),
  strBounds: () => z.object({ s: z.string().min(2).max(3) }),
  arrBounds: () => z.array(z.number()).min(2).max(3),
  passthroughObj: () => z.object({ a: z.string() }).passthrough(),
  recordEnumKey: () => z.record(z.enum(['a', 'b']), z.number()),
  trimOnly: () => z.object({ t: z.string().trim() }),
  transformThenObj: () => z.object({ inner: z.object({ a: nullishTo(z.string(), undefined) }) }),
};

const INPUTS = {
  generic: ['', 'null', '1', '"x"', 'true', '[]', '{}', '[1,"a"]', '{"a":1}', '{"a":"x"}', '{"a":"x","b":2}', '{"a":"x","b":"2"}', '{"a":"x","c":1}',
    '{"a":"x","b":null}', '{"b":1}', '{"x":{"y":"s"},"z":[]}', '{"x":{"y":"s","q":1},"z":[{"w":1,"extra":2}]}', '{"x":{},"z":[{}]}',
    '{"v":1}', '{"v":"s"}', '{"v":true}', '{"v":null}', '{"v":[]}', '{"v":{}}', '{}', '{"v":1.5}', '{"v":{"a":"x"}}', '{"v":{"a":1}}', '{"v":{"b":1}}',
    '{"v":{"c":{"d":true}}}', '{"v":{"c":{}}}', '{"v":{"c":1}}', '{"v":""}', '{"v":5}', '{"v":6}', '["s",{"k":1},{"k":"x"},3,null,{}]', '{"e":"a"}', '{"e":"c"}', '{"e":1}',
    '{"x":1,"y":2}', '{"x":{"n":1},"y":{"n":"2"},"z":{}}', '{"n":3,"s":"ab"}', '{"n":0,"s":"a"}', '{"n":6,"s":"abcd"}', '{"n":1.5,"s":"ab"}', '{"t":"  "}', '{"t":" ab "}',
    '{"a":null,"b":1,"c":null}', '{"a":"s","b":1,"c":2}', '{"b":1}', '{"a":null,"b":null}', '{"a":1,"b":2}', '[null,1,null,"x"]', '[1,2]', '{"k":null,"j":"s","i":null}',
    '{"u":null,"w":null}', '{"u":1}', '{"w":1}', '{"inner":{"a":null}}', '{"inner":{}}', '{"inner":{"a":"s"}}', '{"v":1e999}', '{"v":-0}', '{"v":"y"}', '{"v":null}', '{"v":false}', '{"v":0}',
    '{"a":1,"b":5,"c":2,"d":4}', '{"a":0,"b":6,"c":1,"d":5}', '{"a":1,"b":5,"c":1.0001,"d":4.9999,"e":1e999}', '{"a":1,"b":5,"c":2,"d":4,"e":3}', '{"s":"abc"}', '{"s":"abcd"}', '[1,2,3]', '[1]', '[1,2,3,4]',
    '{"a":"x","extra":1,"z":{"q":2}}', '{"a":"x","extra":null}', '{"a":1,"extra":1}', '{"a":1,"b":2}', '{"a":1,"c":3}', '{"b":1,"a":2}', '{"t":"  "}', '{"t":" x "}', '{"a":"x","b":1e999}'],
};

const encIssue = (i) => {
  const o = { code: i.code, path: i.path.map(String), message: i.message };
  if (i.code === 'invalid_type') { o.expected = i.expected; o.received = i.received; }
  if (i.code === 'unrecognized_keys') o.keys = i.keys;
  if (i.code === 'invalid_union') o.unionErrors = i.unionErrors.map((e) => e.issues.map(encIssue));
  return o;
};
const encValue = (v) => JSON.parse(JSON.stringify(v === undefined ? '__undefined__' : v, (k, x) => {
  if (x === undefined) return '__undefined__';
  if (typeof x === 'number') {
    if (Number.isNaN(x)) return '__NaN__';
    if (x === Infinity) return '__Inf__';
    if (x === -Infinity) return '__-Inf__';
    if (Object.is(x, -0)) return '__neg0__';
  }
  return x;
}));
const parseInput = (t) => (t === '' ? undefined : JSON.parse(t));

const out = { schemas: Object.keys(SCHEMAS), cases: [], numbers: [] };
for (const name of Object.keys(SCHEMAS)) {
  const schema = SCHEMAS[name]();
  for (const t of INPUTS.generic) {
    const sp = schema.safeParse(parseInput(t));
    const c = { s: name, t };
    if (sp.success) {
      c.ok = encValue(sp.data);
      // 「键在、值是 undefined」与「键不在」在 JSON 里一样;另记哪些键是 undefined,测试要的是 C++ 这边也不出现
      c.json = JSON.stringify(sp.data) ?? '__undefined__';
    } else {
      c.issues = sp.error.issues.map(encIssue);
    }
    out.cases.push(c);
  }
}

// ---------------------------------------------------------------- JSON.parse 的数
const NUMS = ['0', '-0', '1', '-1', '0.5', '1e0', '1E2', '1e+2', '1e-2', '123456789012345678901234567890', '1e21', '1e22', '1e308', '1.7976931348623157e308',
  '1.7976931348623158e308', '1.7976931348623159e308', '1.79769313486232e308', '1e309', '1e999', '-1e999', '1e99999999999', '5e-324', '4.9e-324', '2.4703282292062327e-324',
  '2.4703282292062328e-324', '2.5e-324', '1e-323', '1e-324', '1e-325', '1e-400', '-1e-400', '0e-999', '-0e5', '0.0000e5', '1e-99999999999', '123456789012345678901234567890e-400',
  '0.00000000000000000000000000000000000001e-300', '9007199254740993', '9007199254740992', '0.1', '0.30000000000000004', '100000000000000000000', '1.5e300', '-1.5e-300'];
for (const t of NUMS) {
  const v = JSON.parse(t);
  out.numbers.push({ t, v: encValue(v), s: JSON.stringify(v) });
}

writeFileSync(join(here, '..', 'tests', 'fixtures', 'zod-gaps.json'), JSON.stringify(out));
console.log(`zod-gaps.json:${out.cases.length} 例,${out.numbers.length} 个数`);
