// 把 TS 引擎装进一个"只含运行时需要的东西"的暂存目录,供 electron-builder 的 extraResources 打包。
//
//   node tools/stage_engine_ts.js --platform win32 --arch x64      → build/engine-ts/
//
// 为什么要这一步:原来 extraResources 直接指向 ../engine-ts/node_modules,把 devDependencies
// (typescript、vite、vitest、esbuild、rollup、@types…约 51 MB)、better-sqlite3 的 8 个平台预编译
// 二进制与 sqlite 源码、protobufjs 的命令行工具、以及所有 .map / .d.ts / .md 一起打进了安装包。
// 这里按 package-lock.json 的生产依赖闭包复制(npm ci --omit=dev 在没有 C++ 工具链的机器上会因
// better-sqlite3 的 node-gyp 失败,所以不用它),再按文件类型与包名裁掉运行时用不到的部分。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const platform = flag('platform', process.platform);
const arch = flag('arch', process.arch);

const DESKTOP = path.resolve(__dirname, '..');
const TS_ROOT = path.resolve(DESKTOP, '..', 'engine-ts');
const OUT = path.join(DESKTOP, 'build', 'engine-ts');

// ---- 文件级过滤:这些在运行时一个都用不到 -----------------------------------
const SKIP_EXT = new Set(['.map', '.md', '.markdown', '.txt', '.mts', '.cts', '.ts', '.tsbuildinfo', '.flow']);
const KEEP_TXT = new Set(['LICENSE.txt', 'LICENCE.txt', 'NOTICE.txt']);   // 许可文件保留
const SKIP_DIRS = new Set(['test', 'tests', '__tests__', 'docs', 'doc', 'example', 'examples',
  '.github', 'benchmark', 'benchmarks', 'coverage', '.nyc_output', 'man']);
const SKIP_NAMES = new Set(['.npmignore', '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.prettierrc',
  '.editorconfig', '.travis.yml', 'tsconfig.json', 'tsconfig.build.json', 'yarn.lock', 'package-lock.json']);

// ---- 包级过滤:按包名裁掉明确无用的大块 --------------------------------------
const PACKAGE_RULES = {
  'better-sqlite3': (rel) => {
    // 只留当前平台的预编译二进制;deps/(sqlite 源码)与 src/(C++)只在从源码编译时才需要
    if (rel === 'prebuilds/') return true;   // 目录本身要进,里面只留一个文件
    if (rel.startsWith('prebuilds/')) return rel === `prebuilds/${platform}-${arch}.node`;
    if (rel.startsWith('deps/') || rel.startsWith('src/') || rel === 'binding.gyp') return false;
    return true;
  },
  'protobufjs': (rel) => !rel.startsWith('cli/'),          // 命令行工具(带自己的 node_modules)
  '@anthropic-ai/sdk': (rel) => !rel.startsWith('src/'),   // TypeScript 源码,运行时用 dist 里的 js
};

function shouldCopy(pkgName, rel, isDir, base) {
  if (isDir) {
    if (SKIP_DIRS.has(base)) return false;
    if (base === 'node_modules') return false;   // 嵌套依赖是 lock 里独立的条目,各自复制
  } else {
    const ext = path.extname(base);
    if (base.endsWith('.d.ts') || base.endsWith('.d.mts') || base.endsWith('.d.cts')) return false;
    if (SKIP_EXT.has(ext) && !KEEP_TXT.has(base)) return false;
    if (SKIP_NAMES.has(base)) return false;
  }
  const rule = PACKAGE_RULES[pkgName];
  if (rule && !rule(rel, isDir)) return false;
  return true;
}

function copyTree(src, dst, pkgName) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const s = path.join(src, entry);
      const isDir = fs.statSync(s).isDirectory();
      const rel = path.relative(pkgRoot(pkgName, src), s).split(path.sep).join('/');
      if (!shouldCopy(pkgName, isDir ? rel + '/' : rel, isDir, entry)) continue;
      copyTree(s, path.join(dst, entry), pkgName);
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}
const roots = new Map();
function pkgRoot(pkgName, anyPath) {
  return roots.get(pkgName) || anyPath;
}

function dirSize(p) {
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    n += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
  }
  return n;
}
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

// ---- 开始 --------------------------------------------------------------------
if (!fs.existsSync(path.join(TS_ROOT, 'dist', 'src', 'cli.js'))) {
  console.error('找不到 engine-ts/dist/src/cli.js:先在 engine-ts 下跑 npx tsc');
  process.exit(1);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1. 引擎本体:dist/src 下的 .js(ESM,需要根 package.json 的 "type": "module")+ LLM schema 资产
copyTree(path.join(TS_ROOT, 'dist', 'src'), path.join(OUT, 'dist', 'src'), '__dist__');
fs.mkdirSync(path.join(OUT, 'baseline', 'llm'), { recursive: true });
for (const f of fs.readdirSync(path.join(TS_ROOT, 'baseline', 'llm'))) {
  if (f.endsWith('.json')) fs.copyFileSync(path.join(TS_ROOT, 'baseline', 'llm', f), path.join(OUT, 'baseline', 'llm', f));
}
const pkg = JSON.parse(fs.readFileSync(path.join(TS_ROOT, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, private: true, type: pkg.type, engines: pkg.engines,
  dependencies: pkg.dependencies,
}, null, 2));

// 2. 生产依赖闭包:package-lock v3 的 packages 表,dev:true 的一律不要
const lock = JSON.parse(fs.readFileSync(path.join(TS_ROOT, 'package-lock.json'), 'utf8'));
let copied = 0;
for (const [key, meta] of Object.entries(lock.packages)) {
  if (!key || meta.dev) continue;
  const src = path.join(TS_ROOT, key);
  if (!fs.existsSync(src)) {
    console.error('lock 里有但磁盘上没有:', key, '——先在 engine-ts 下 npm install');
    process.exit(1);
  }
  const pkgName = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  roots.set(pkgName, src);
  copyTree(src, path.join(OUT, key), pkgName);
  copied += 1;
}

const total = dirSize(OUT);
const nm = dirSize(path.join(OUT, 'node_modules'));
console.log(`engine-ts 暂存完成:${OUT}`);
console.log(`  生产依赖 ${copied} 个包,node_modules ${mb(nm)},合计 ${mb(total)}(目标平台 ${platform}-${arch})`);
const sizes = fs.readdirSync(path.join(OUT, 'node_modules')).flatMap((e) => {
  const p = path.join(OUT, 'node_modules', e);
  if (e.startsWith('@')) return fs.readdirSync(p).map((s) => [`${e}/${s}`, dirSize(path.join(p, s))]);
  return [[e, dirSize(p)]];
}).sort((a, b) => b[1] - a[1]).slice(0, 8);
for (const [name, size] of sizes) console.log(`    ${mb(size).padStart(8)}  ${name}`);
