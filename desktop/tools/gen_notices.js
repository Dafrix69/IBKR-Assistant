// 第三方许可声明:把随安装包发出去的开源组件、它们的许可类型与许可全文,收成一份 THIRD-PARTY-NOTICES.txt。
//
//   node tools/gen_notices.js            → build/THIRD-PARTY-NOTICES.txt(打包前跑,随包进 resources)
//   node tools/gen_notices.js --check    只查许可类型,不写文件;有不在白名单里的许可就退出码 1(CI 用)
//
// 为什么要有:MIT / BSD / ISC / Apache-2.0 都要求"许可声明随副本一起走"。卖出去的安装包里有三百多个组件,
// 而 Vite 把界面依赖打成一个文件时只留下了 React 的版权头,引擎暂存时又把 .md 一律裁掉了
// (LICENSE.md 跟着没了)——安装包里实际上没有带齐这些声明。
//
// 收哪些(= 真的随包发出去的):
//   · 引擎:engine-ts/package-lock.json 里的生产依赖闭包(和 stage_engine_ts.js 同一个口径);
//   · 主进程:desktop/package.json 的 dependencies 及其依赖;
//   · 界面:Vite 打进包里的那些——从界面直接 import 的几个库出发,顺着 lock 里的 dependencies 走到底;
//   · Electron 本身(MIT)。Chromium 与它带的组件另有一份 LICENSES.chromium.html,随 Electron 发行,
//     打包时一并拷进 resources(package.json 的 extraResources)。
// 开发工具(typescript、vite、eslint、electron-builder…)不随包发出去,不收。
//
// 许可白名单:只有宽松许可。出现 GPL / LGPL / AGPL / MPL 这类带传染或文件级义务的许可、或者认不出许可的包,
// 不是"记下来就行"的事——得有人判断能不能带进一个要卖的软件里。所以那时直接失败,判断过之后再写进 EXCEPTIONS。
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = path.resolve(__dirname, '..');
const ENGINE = path.resolve(DESKTOP, '..', 'engine-ts');
const OUT = path.join(DESKTOP, 'build', 'THIRD-PARTY-NOTICES.txt');
const checkOnly = process.argv.includes('--check');

/** 界面直接 import 的第三方库(renderer-react/src 里的裸模块名)。新加了要在这里登记:漏了的话 --check 会指出来。 */
const RENDERER_ROOTS = ['react', 'react-dom', 'antd', '@ant-design/icons', 'dayjs', 'zustand', 'lightweight-charts', 'fancy-canvas'];

/** 可以直接带进安装包的许可(SPDX 标识)。 */
const ALLOWED = new Set([
  'MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0',
  'Python-2.0', 'CC-BY-4.0',
]);

/**
 * 判断过、可以带的例外:包名 → 为什么可以。
 * 往这里加一行之前,先确认那份许可对"随闭源 / 收费软件分发"没有额外义务,或者义务已经履行。
 */
const EXCEPTIONS = {};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** SPDX 表达式里出现的每个标识都在白名单里才算过("(MIT OR Apache-2.0)" 这种二选一,有一个在就行)。 */
function licenseOk(expr) {
  const text = String(expr || '').trim();
  if (!text) return false;
  const alternatives = text.replace(/[()]/g, ' ').split(/\s+OR\s+/i);
  return alternatives.some((alt) => alt.split(/\s+AND\s+/i).every((id) => ALLOWED.has(id.trim())));
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' OR ');
  return '';
}

function repoOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
  const text = String(repo || pkg.homepage || '').replace(/^git\+/, '').replace(/\.git$/, '');
  return /^https?:\/\//.test(text) ? text : text.replace(/^github:/, 'https://github.com/').replace(/^git:\/\//, 'https://');
}

const LICENSE_FILE = /^(licen[sc]e|copying|notice)([-.].*)?$/i;

/** 包目录里的许可 / 声明文件,全文拼起来。 */
function licenseTexts(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => LICENSE_FILE.test(n))
    .sort()
    .map((n) => {
      try {
        const stat = fs.statSync(path.join(dir, n));
        if (!stat.isFile() || stat.size > 200_000) return null;
        return fs.readFileSync(path.join(dir, n), 'utf8').replace(/\r\n?/g, '\n').trim();
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** 一份 lock 里要收的包:key 是 lock 的 packages 表的键("node_modules/x" / "node_modules/a/node_modules/b")。 */
function collect(root, keys, scope, out, problems) {
  for (const key of keys) {
    const dir = path.join(root, key);
    let pkg;
    try {
      pkg = readJson(path.join(dir, 'package.json'));
    } catch {
      // 别的平台的原生包(@napi-rs/keyring-win32-x64 这种)本机没装:它和本机那一个是同一个项目、同一份许可
      continue;
    }
    const id = `${pkg.name}@${pkg.version}`;
    const license = licenseOf(pkg);
    const entry = out.get(id) || { name: pkg.name, version: pkg.version, license, repo: repoOf(pkg), texts: licenseTexts(dir), scopes: new Set() };
    entry.scopes.add(scope);
    out.set(id, entry);
    if (!licenseOk(license) && !Object.hasOwn(EXCEPTIONS, pkg.name)) {
      problems.push(`${id}(${scope}):许可「${license || '没有写'}」不在白名单里`);
    }
  }
}

/** lock 里某个包的依赖,解析成 lock 的键(先找嵌套的,再一层层往上找)。 */
function resolveDep(lock, fromKey, name) {
  let base = fromKey;
  for (;;) {
    const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (!base) return null;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut >= 0 ? base.slice(0, cut) : '';
  }
}

function closure(lock, rootNames) {
  const seen = new Set();
  const queue = [];
  for (const name of rootNames) {
    const key = resolveDep(lock, '', name);
    if (!key) throw new Error(`lock 里找不到 ${name}:是不是改了依赖没重新 npm install`);
    queue.push(key);
  }
  while (queue.length) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = lock.packages[key];
    for (const name of Object.keys({ ...(meta.dependencies || {}), ...(meta.optionalDependencies || {}) })) {
      const dep = resolveDep(lock, key, name);
      if (dep) queue.push(dep);
    }
  }
  return [...seen].sort();
}

/** 界面源码里 import 了、却没登记在 RENDERER_ROOTS 里的第三方库。 */
function unlistedRendererImports() {
  const src = path.join(DESKTOP, 'renderer-react', 'src');
  const found = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const text = fs.readFileSync(p, 'utf8');
        for (const m of text.matchAll(/(?:from|import)\s+['"]([^'".][^'"]*)['"]/g)) {
          const spec = m[1];
          found.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
        }
      }
    }
  };
  walk(src);
  return [...found].filter((name) => !RENDERER_ROOTS.includes(name)).sort();
}

function main() {
  const problems = [];
  const packages = new Map();

  const engineLock = readJson(path.join(ENGINE, 'package-lock.json'));
  const engineKeys = Object.entries(engineLock.packages).filter(([k, m]) => k && !m.dev).map(([k]) => k);
  collect(ENGINE, engineKeys, '交易引擎', packages, problems);

  const desktopLock = readJson(path.join(DESKTOP, 'package-lock.json'));
  const desktopPkg = readJson(path.join(DESKTOP, 'package.json'));
  collect(DESKTOP, closure(desktopLock, Object.keys(desktopPkg.dependencies || {})), '主进程', packages, problems);
  collect(DESKTOP, closure(desktopLock, RENDERER_ROOTS), '界面', packages, problems);
  collect(DESKTOP, ['node_modules/electron'], 'Electron', packages, problems);

  const unlisted = unlistedRendererImports();
  if (unlisted.length) problems.push(`界面 import 了没登记的第三方库:${unlisted.join('、')}(加进 gen_notices.js 的 RENDERER_ROOTS)`);

  const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const byLicense = new Map();
  for (const p of list) byLicense.set(p.license || '(没有写)', (byLicense.get(p.license || '(没有写)') || 0) + 1);
  const missingText = list.filter((p) => !p.texts.length);

  console.log(`随包发出去的开源组件:${list.length} 个`);
  for (const [license, count] of [...byLicense].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(4)}  ${license}`);
  if (missingText.length) {
    console.log(`\n包里没有带许可文件的(声明里按许可类型与项目地址列出):${missingText.map((p) => p.name).join('、')}`);
  }
  if (problems.length) {
    console.error(`\n✗ 许可检查没有通过:\n${problems.map((p) => `  · ${p}`).join('\n')}`);
    process.exit(1);
  }
  if (checkOnly) {
    console.log('\n✓ 许可检查通过');
    return;
  }

  // 同一份许可全文只印一次,后面跟着用它的那些包——一百多个 Apache-2.0 的包不值得印一百多遍同样的十一页
  const texts = new Map();
  for (const p of list) {
    for (const text of p.texts) {
      const key = crypto.createHash('sha256').update(text.replace(/\s+/g, ' ')).digest('hex');
      const entry = texts.get(key) || { text, users: [] };
      entry.users.push(`${p.name}@${p.version}`);
      texts.set(key, entry);
    }
  }

  const rule = '='.repeat(78);
  const lines = [
    'IBKR-Assistant · 第三方许可声明(THIRD-PARTY NOTICES)',
    '',
    `本软件 ${desktopPkg.version} 版的安装包里带有下列开源组件。它们各自沿用原有的许可,不因本软件而改变。`,
    'Chromium 及其所带组件的许可另见同目录下的 LICENSES.chromium.html。',
    '',
    `共 ${list.length} 个组件:${[...byLicense].sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l} × ${c}`).join(',')}。`,
    '',
    rule,
    '一、组件清单',
    rule,
    '',
  ];
  for (const p of list) {
    lines.push(`${p.name} ${p.version}`);
    lines.push(`  许可:${p.license}${Object.hasOwn(EXCEPTIONS, p.name) ? `(${EXCEPTIONS[p.name]})` : ''}`);
    if (p.repo) lines.push(`  来源:${p.repo}`);
    lines.push(`  用于:${[...p.scopes].join('、')}`);
    lines.push('');
  }
  lines.push(rule, '二、许可全文', rule, '');
  const sorted = [...texts.values()].sort((a, b) => b.users.length - a.users.length || a.users[0].localeCompare(b.users[0]));
  for (const { text, users } of sorted) {
    lines.push(`适用于:${users.join('、')}`, '-'.repeat(78), text, '', rule, '');
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  console.log(`\n✓ 已写出 ${path.relative(DESKTOP, OUT)}(${(fs.statSync(OUT).size / 1024).toFixed(0)} KB,${texts.size} 份不同的许可全文)`);
}

main();
