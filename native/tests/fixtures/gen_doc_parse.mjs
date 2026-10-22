// 生成 doc-parse.json:条款文本解析器(desktop/renderer-react/src/lib/docParse.ts)对一组输入切出来的块,
// 原样记下,C++ 的 shell/doc_parse 逐个对。输入 = 仓库里三份真条款 + 专挑边界的几段。
//   node native/tests/fixtures/gen_doc_parse.mjs     (Node ≥ 23 直接跑 .ts)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const { parseDoc } = await import(join(repo, 'desktop/renderer-react/src/lib/docParse.ts'));

const legal = (name) => readFileSync(join(repo, 'docs/legal', name), 'utf8');
const sources = {
  risk: legal('risk-disclosure.md'),
  terms: legal('terms.md'),
  privacy: legal('privacy.md'),
  // 句号后面紧跟 ** 的加粗(CommonMark 不认、这里认)、一行里两段加粗、没收尾的 **、单个 *
  bold: '盯盘。**软件没有开着时,它不会触发。**托管单照样有效。\n**甲**乙**丙**\n只有开头 **没有收尾\n*单星* 与 ***三星***',
  // 标题级数、#### 不算标题、# 后面没空格不算、列表前的缩进、连续段落拼成一行(中文不加空格)
  headings: '# 一\n## 二\n### 三\n#### 四\n#没空格\n  - 缩进的项\n-没空格\n- 项 **粗**\n第一行\n第二行\n\n新段',
  // 表格:对齐冒号、首尾不带竖线、单元格里的加粗、规则行不够三个横线就不是表格、表格后紧跟段落
  tables: '| 甲 | 乙 |\n|:---|---:|\n| 1 | **2** |\n|3|4|\n后面的段落\n\n甲 | 乙\n--- | ---\n| x | y |\n|--|--|\n| p | q |',
  // CRLF、单独的 CR、全角空格(JS 的 \\s 认、trim 也认)、空串
  whitespace: '# 标题\r\n段落\r一行\n　\n-　全角空格的项\n   \n尾',
  empty: '',
};
const cases = Object.entries(sources).map(([name, source]) => ({ name, source, blocks: parseDoc(source) }));
writeFileSync(join(here, 'doc-parse.json'), JSON.stringify({ generator: 'gen_doc_parse.mjs', cases }, null, 1) + '\n');
console.log(`doc-parse.json: ${cases.length} cases`);
