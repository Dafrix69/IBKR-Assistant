// 发版闸门:打正式发布包之前,把"忘了就会出事"的几件事查一遍。
//
//   node tools/check_release.js                 查当前 package.json 的版本
//   node tools/check_release.js --tag v0.6.0    另外核对标签与版本号一致(CI 的 release 任务用)
//   node tools/check_release.js --notes         查完之后把这一版的更新说明打到 stdout(给 gh release create 用)
//
// 查什么、为什么:
//   1. 版本号是合法的 x.y.z,标签对得上——安装包文件名带的是 package.json 的版本,对不上发出去就是错的;
//   2. CHANGELOG.md 里有这一版的一节、有日期、有内容——「关于」页的更新说明读的就是发布页上的这段话;
//   3. 条款文本里没有留着【发布前填写】,三份文本的版本号与主进程认的现行版本一致;
//   4. 示例配置里三个执行闸门是关的、账号是占位的——新用户首次启动拷走的就是它;
//   5. 随包的开源组件许可都在白名单里(tools/gen_notices.js --check)。
//
// 只读,不改任何文件。平时开发不跑它(条款里的占位符在正式发售前本来就该留着)。
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = path.resolve(__dirname, '..');
const ROOT = path.resolve(DESKTOP, '..');
const args = process.argv.slice(2);
const tagIndex = args.indexOf('--tag');
const tag = tagIndex >= 0 ? String(args[tagIndex + 1] || '') : '';
const wantNotes = args.includes('--notes');

const problems = [];
const say = (text) => console.error(text); // 说明走 stderr,stdout 留给 --notes
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/** CHANGELOG.md 里某一版的那一节:{ date, body };没有就是 null。 */
function changelogSection(text, version) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const head = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\](?:\\s*[-–—]\\s*(\\d{4}-\\d{2}-\\d{2}))?\\s*$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return { date: head.exec(lines[start])[1] || '', body: lines.slice(start + 1, end).join('\n').trim() };
}

function main() {
  // ---- 1. 版本号 ----
  const pkg = JSON.parse(read('desktop', 'package.json'));
  const version = String(pkg.version || '');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) problems.push(`desktop/package.json 的版本号不合法:${version}`);
  if (tag && tag.replace(/^v/, '') !== version) problems.push(`标签 ${tag} 与 desktop/package.json 的版本 ${version} 对不上`);

  // ---- 2. 更新说明 ----
  let section = null;
  try {
    section = changelogSection(read('CHANGELOG.md'), version);
    if (!section) problems.push(`CHANGELOG.md 里没有 ${version} 这一版的一节(标题写成「## [${version}] - 年-月-日」)`);
    else {
      if (!section.date) problems.push(`CHANGELOG.md 的 ${version} 一节没有写日期`);
      if (section.body.replace(/^#+.*$/gm, '').trim().length < 20) problems.push(`CHANGELOG.md 的 ${version} 一节没有内容`);
    }
  } catch {
    problems.push('找不到 CHANGELOG.md');
  }

  // ---- 3. 条款文本 ----
  const { TERMS_VERSION } = require('../consent.js');
  for (const name of ['risk-disclosure.md', 'terms.md', 'privacy.md']) {
    let text;
    try {
      text = read('docs', 'legal', name);
    } catch {
      problems.push(`找不到 docs/legal/${name}`);
      continue;
    }
    const left = (text.match(/【发布前填写】/g) || []).length;
    if (left) problems.push(`docs/legal/${name} 里还有 ${left} 处【发布前填写】`);
    const found = /^版本[::]\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(text);
    if (!found || found[1] !== TERMS_VERSION) {
      problems.push(`docs/legal/${name} 的版本(${found ? found[1] : '没写'})与 desktop/consent.js 的 TERMS_VERSION(${TERMS_VERSION})不一致`);
    }
  }

  // ---- 4. 示例配置 ----
  try {
    const example = JSON.parse(read('config', 'settings.example.json'));
    for (const gate of ['auto_execute', 'allow_live_trading', 'allow_combo_live']) {
      if (example.policies && example.policies[gate] !== false) problems.push(`示例配置的 policies.${gate} 不是 false`);
    }
    for (const account of example.accounts || []) {
      if (!/^[A-Za-z]*0+$/.test(String(account.account_id || ''))) {
        problems.push(`示例配置的账户「${account.alias}」不是占位账号——别把真实账号发出去`);
      }
    }
  } catch (err) {
    problems.push(`示例配置读不出来:${err.message}`);
  }

  // ---- 5. 开源许可 ----
  const notices = spawnSync(process.execPath, [path.join(__dirname, 'gen_notices.js'), '--check'], { encoding: 'utf8' });
  if (notices.status !== 0) problems.push(`开源许可检查没有通过:\n${String(notices.stderr || notices.stdout).trim().split('\n').map((l) => `      ${l}`).join('\n')}`);

  if (problems.length) {
    say(`\n✗ ${version} 还不能发布:\n${problems.map((p) => `  · ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  say(`✓ ${version} 可以发布:版本号、更新说明、条款文本、示例配置、开源许可都查过了`);
  if (wantNotes && section) process.stdout.write(`${section.body}\n`);
}

module.exports = { changelogSection };
if (require.main === module) main();
