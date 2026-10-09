// 编译「本地收件」读窗口的程序:tools/discord-window-follow.swift → build/inbox-reader/discord-window-follow。
//
//   node tools/build_inbox_reader.js                 打包用(dist_mac.js 调):编不出来就失败
//   node tools/build_inbox_reader.js --arch arm64    指定架构;不给 = 本机的
//   node tools/build_inbox_reader.js --if-possible   开发用(npm start 之前):不是 macOS、没装 swiftc 就跳过——
//                                                    软件照常起,只是不自己读窗口(界面上会说明)
//
// 软件自己拉起的是编译好的这一份(engine-ts/src/followReader.ts 照环境变量 DAFRI_INBOX_READER 找它),
// 用户的电脑上不需要装 Swift。它只链接系统自带的库;最低系统版本和 Electron 一样定在 macOS 12。
// 产物比源文件新就不重编。签名不在这里做:打包时 electron-builder 连同应用里别的可执行文件一起签。
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = path.resolve(__dirname, '..');
const SOURCE = path.join(__dirname, 'discord-window-follow.swift');
const OUT_DIR = path.join(DESKTOP, 'build', 'inbox-reader');
const OUT = path.join(OUT_DIR, 'discord-window-follow');
const MIN_MACOS = '12.0';

const lenient = process.argv.includes('--if-possible');
const archAt = process.argv.indexOf('--arch');
const arch = archAt > -1 ? process.argv[archAt + 1] : process.arch;

function skip(why) {
  if (!lenient) {
    console.error(`\n✗ 读窗口的程序编不出来:${why}\n`);
    process.exit(1);
  }
  console.log(`[inbox-reader] 跳过:${why}(软件照常起,只是不自己读 Discord 窗口)`);
  process.exit(0);
}

if (process.platform !== 'darwin') skip('只有 macOS 上有这个程序');
const triple = { arm64: 'arm64', x64: 'x86_64' }[arch];
if (!triple) skip(`不认识的架构 ${arch}`);

// 架构记在旁边:同一台机器上换着架构打包时,不拿上一次的顶替
const STAMP = path.join(OUT_DIR, 'arch.txt');
const fresh = fs.existsSync(OUT) && fs.statSync(OUT).mtimeMs >= fs.statSync(SOURCE).mtimeMs &&
  fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === triple;
if (fresh) {
  console.log(`[inbox-reader] 已是最新:${path.relative(DESKTOP, OUT)}`);
  process.exit(0);
}

if (spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).status !== 0) {
  skip('没找到 swiftc(装 Xcode 命令行工具:xcode-select --install)');
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const args = ['swiftc', '-O', '-target', `${triple}-apple-macos${MIN_MACOS}`, SOURCE, '-o', OUT];
console.log(`[inbox-reader] $ xcrun ${args.join(' ')}`);
const built = spawnSync('xcrun', args, { stdio: 'inherit' });
if (built.status !== 0) {
  fs.rmSync(OUT, { force: true });
  skip(`swiftc 失败(退出码 ${built.status})`);
}
fs.writeFileSync(STAMP, `${triple}\n`);
console.log(`[inbox-reader] ✓ ${path.relative(DESKTOP, OUT)}(${triple},macOS ${MIN_MACOS}+)`);
