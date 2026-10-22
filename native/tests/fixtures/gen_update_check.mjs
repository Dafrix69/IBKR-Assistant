// 生成 update-check.json:新版本检查(desktop/update-check.js)的版本比较、安装包挑选、发布说明、整条 release 的摘要现算的结果。
//   node native/tests/fixtures/gen_update_check.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const U = createRequire(import.meta.url)(join(here, '..', '..', '..', 'desktop/update-check.js'));
const versions = ['0.5.2', 'v0.5.2', '0.5.10', '0.6.0', '0.6.0-beta.2', '0.6.0-beta.10', '0.6.0-beta', '0.6.0-alpha.1', '0.6.0-1', '0.6.0-rc.1+build.5', '1.0.0+meta', ' 0.6.0 ', '0.6', 'x', '', null, '0.6.0-beta.a', '0.6.0-beta.1.1'];
const compare = [];
for (const a of versions) for (const b of versions) compare.push({ a, b, out: U.compareVersions(a, b) });
const parse = versions.map((v) => ({ v, out: U.parseVersion(v) }));
const D = 'https://github.com/Dafrix69/IBKR-Assistant/releases/download/v0.6.0/';
const assets = [
  { name: 'IBKR-Assistant-0.6.0-mac-arm64.dmg', browser_download_url: D + 'IBKR-Assistant-0.6.0-mac-arm64.dmg', size: 123456789 },
  { name: 'IBKR-Assistant-0.6.0-mac-arm64.dmg.blockmap', browser_download_url: D + 'x.blockmap', size: 1 },
  { name: 'IBKR-Assistant-0.6.0-win-x64.exe', browser_download_url: D + 'IBKR-Assistant-0.6.0-win-x64.exe' },
  { name: 'IBKR-Assistant-0.6.0-mac-x64.dmg', browser_download_url: 'https://evil.example.com/a-mac-x64.dmg', size: 5 },
  null, { name: 5 },
];
const pick = [['darwin', 'arm64'], ['win32', 'x64'], ['darwin', 'x64'], ['linux', 'x64'], ['win32', 'arm64']].map(([p, a]) => ({ platform: p, arch: a, out: U.assetFor(assets, p, a) }));
pick.push({ platform: 'darwin', arch: 'arm64', assetsNotArray: true, out: U.assetFor('nope', 'darwin', 'arm64') });
const notes = ['## 新功能\r\n\r\n\r\n\r\n- **重要事件** 挂顶 [文档](https://x.y)\n![图](a.png)\n<!-- 注释\n多行 -->\n### 修复\n#### 小标题', '', null, 'a'.repeat(1300), `${'b'.repeat(1199)}   tail`, '**粗*体**'];
const plain = notes.map((n) => ({ body: n, out: U.plainNotes(n) }));
const NOW = 1_789_150_800_000;
const releases = [
  { tag_name: 'v0.6.0', html_url: 'https://github.com/Dafrix69/IBKR-Assistant/releases/tag/v0.6.0', assets, published_at: '2026-10-18T01:00:00Z', body: '## 新\n- 一' },
  { tag_name: 'v0.5.2', html_url: 'https://evil.example.com/', assets: [], published_at: 5 },
  { tag_name: 'nightly' }, {}, null,
];
const summaries = [];
for (const r of releases) for (const current of ['0.5.2', '0.6.0-beta.1']) summaries.push({ release: r, current, out: U.summarizeRelease(r, { current, platform: 'darwin', arch: 'arm64', now: NOW }) });
writeFileSync(join(here, 'update-check.json'), JSON.stringify({ generator: 'gen_update_check.mjs', releasesPage: U.RELEASES_PAGE, latestApi: U.LATEST_API, compare, parse, assets, pick, plain, summaries, now: NOW }, null, 1) + '\n');
console.log(`update-check.json: ${compare.length} comparisons`);
