// 桌面端 npm start / npm run dev 之前:确认 ../engine-ts/dist 存在且不比 src 旧,缺或过期就用
// engine-ts 自带的 tsc 重编。dist 不进仓库(见根 .gitignore),新 clone 或改完 TS 忘了编都在这里补上。
//
// engine-ts 缺源码或没装依赖都直接报错退出:桌面端没有别的引擎可退。
// tsc 失败也不启动——带着坏 dist 起来比起不来更难排查。
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = path.resolve(__dirname, '..');
const TS_ROOT = path.resolve(DESKTOP, '..', 'engine-ts');
const ENTRY = path.join(TS_ROOT, 'dist', 'src', 'cli.js');
const TSC = path.join(TS_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

function newestTs(dir) {
  let newest = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) newest = Math.max(newest, newestTs(p));
    else if (name.endsWith('.ts')) newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}

function main() {
  if (!fs.existsSync(path.join(TS_ROOT, 'src'))) {
    console.error('[engine-ts] 找不到 ../engine-ts/src:仓库不完整,桌面端没有引擎可用');
    return 1;
  }
  if (!fs.existsSync(TSC)) {
    console.error('[engine-ts] engine-ts 还没装依赖:先 cd engine-ts && npm install');
    return 1;
  }
  const have = fs.existsSync(ENTRY) ? fs.statSync(ENTRY).mtimeMs : 0;
  const srcNewest = Math.max(
    newestTs(path.join(TS_ROOT, 'src')),
    fs.statSync(path.join(TS_ROOT, 'tsconfig.json')).mtimeMs,
  );
  if (have && have >= srcNewest) return 0;
  console.log(have ? '[engine-ts] dist 比 src 旧,重编…' : '[engine-ts] 还没有 dist,首次编译…');
  const r = spawnSync(process.execPath, [TSC, '-p', TS_ROOT], { cwd: TS_ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[engine-ts] tsc 失败,不启动:先修好 engine-ts 再 npm start');
    return r.status || 1;
  }
  return 0;
}

process.exit(main());
