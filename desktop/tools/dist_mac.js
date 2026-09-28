// Mac 安装包:界面构建 → 暂存引擎 → 冒烟 → electron-builder → 自验。
//
//   npm run dist:mac            ad-hoc 签名(package.json 里 mac.identity 为 "-"),没有证书也能打
//   npm run dist:mac:signed     Developer ID 签名 + 公证,双击即开:
//     APPLE_TEAM_ID=ABCDE12345 APPLE_KEYCHAIN_PROFILE=ibkr-notary npm run dist:mac:signed
//
// 签名版要两样东西,缺哪样都在开始打包之前就报,不在打了几分钟之后才报:
//   1. 证书:钥匙串里 Team 是 APPLE_TEAM_ID 的「Developer ID Application」(CI 上改用 CSC_LINK + CSC_KEY_PASSWORD 给 .p12)
//   2. 公证凭据,三选一(与 electron-builder 的判断顺序一致):
//        APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD(+ APPLE_TEAM_ID)
//        APPLE_API_KEY(.p8 文件路径)+ APPLE_API_KEY_ID + APPLE_API_ISSUER
//        APPLE_KEYCHAIN_PROFILE(先 xcrun notarytool store-credentials 存进钥匙串,本机推荐这个)
// 签名版在 electron-builder 公证完 .app 之后,再把签过名的 DMG 也公证、装订,最后按 Gatekeeper 的口径验一遍。
//
// 为什么签名身份按 Team ID 选、不改 package.json:那里的 "-" 是没证书时的默认;而 electron-builder 找证书是
// 拿 identity 在证书名里做子串匹配,Team ID 恰好在证书名的括号里,是唯一不会误中的写法。
//
// 为什么不直接调 electron-builder 命令行:项目放在 iCloud 同步的目录(「桌面与文稿」开了同步时的 ~/Desktop)里,
// 打出来的应用包目录会被 File Provider 异步挂上 com.apple.FinderInfo,codesign 当它是垃圾数据拒签——
// 赶上了就失败、没赶上就过,同一台机器上时好时坏(2026-09-27 量到)。这里发现是那种目录,就把构建输出挪到
// 不同步的 ~/Library/Caches/IBKR-Assistant/,DMG 最后拷回 dist/。CI 与普通目录下输出照旧是 dist/。
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DESKTOP = path.resolve(__dirname, '..');
const DIST = path.join(DESKTOP, 'dist');
const pkg = require('../package.json');
const env = process.env;
const signed = process.argv.includes('--signed');

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function run(cmd, args) {
  console.log(`\n$ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: DESKTOP, stdio: 'inherit' });
  if (r.status !== 0) fail(`${cmd} ${args[0]} 失败(退出码 ${r.status})`);
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

/** 目录在 iCloud 云盘(或别的 File Provider)同步范围里:「桌面与文稿」开了同步时,~/Desktop 和 ~/Documents 都是 */
function inFileProvider(dir) {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) {
    if (capture('xattr', [d]).includes('com.apple.file-provider-domain-id')) return true;
  }
  return false;
}

// ---- 1. 签名版先查齐 --------------------------------------------------------------------
if (process.platform !== 'darwin') fail('Mac 安装包只能在 macOS 上打');

// electron-builder 在 PR 构建(GitHub 上看 GITHUB_BASE_REF)里默认跳过签名,防的是外部 PR 偷用证书。
// ad-hoc 签名不碰任何密钥,没有那层风险,而跳过的后果是 PR 打出来的包和发版的不是同一个东西
// (连签名都没有,下面的 codesign 自验必挂——2026-09-27 PR #5 第一次跑就这么挂的)。所以 ad-hoc 照签;
// Developer ID 在 PR 里一律不签,CI 那边也只在非 PR 时走签名版
const isPullRequest = Boolean(env.GITHUB_BASE_REF);
if (!signed) env.CSC_FOR_PULL_REQUEST = 'true';
else if (isPullRequest) fail('PR 构建里不做 Developer ID 签名与公证(证书不该暴露给 PR);PR 上用 npm run dist:mac');

const team = (env.APPLE_TEAM_ID || '').trim();
let notary = null;
if (signed) {
  if (!/^[A-Z0-9]{10}$/.test(team)) {
    fail('APPLE_TEAM_ID 没设或格式不对:10 位大写字母与数字,在 developer.apple.com → Account → Membership details 里');
  }
  if (env.CSC_LINK) {
    console.log('证书:CSC_LINK(.p12,CI 用法)');
  } else {
    const line = capture('security', ['find-identity', '-v', '-p', 'codesigning'])
      .split('\n')
      .find((l) => l.includes('Developer ID Application:') && l.includes(`(${team})`));
    if (!line) {
      fail(
        `钥匙串里没有 Team ${team} 的「Developer ID Application」证书。\n` +
          '  Xcode → 设置 → Account → 选中团队 → Manage Certificates… → 左下 + → Developer ID Application\n' +
          '  (只有账号持有人 Account Holder 能建这种证书)'
      );
    }
    console.log(`证书:${line.trim()}`);
  }
  notary = notaryArgs();
}

// notarytool 的凭据参数,DMG 那一次公证要用;判断顺序照 electron-builder(公证 .app 的是它)
function notaryArgs() {
  if (env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD) {
    if (!env.APPLE_ID || !env.APPLE_APP_SPECIFIC_PASSWORD) fail('APPLE_ID 与 APPLE_APP_SPECIFIC_PASSWORD 要成对给');
    return ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', team];
  }
  if (env.APPLE_API_KEY || env.APPLE_API_KEY_ID || env.APPLE_API_ISSUER) {
    if (!env.APPLE_API_KEY || !env.APPLE_API_KEY_ID || !env.APPLE_API_ISSUER) {
      fail('APPLE_API_KEY、APPLE_API_KEY_ID、APPLE_API_ISSUER 三个要一起给');
    }
    if (!fs.existsSync(env.APPLE_API_KEY)) fail(`APPLE_API_KEY 要指向 .p8 文件:${env.APPLE_API_KEY} 不存在`);
    return ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER];
  }
  if (env.APPLE_KEYCHAIN_PROFILE) return ['--keychain-profile', env.APPLE_KEYCHAIN_PROFILE];
  return fail(
    '没有公证凭据。本机最省事的一种:\n' +
      `  xcrun notarytool store-credentials ibkr-notary --apple-id <Apple ID> --team-id ${team}\n` +
      '  (会问 App 专用密码:appleid.apple.com → 登录与安全 → App 专用密码)\n' +
      '  然后 APPLE_KEYCHAIN_PROFILE=ibkr-notary 再跑一次'
  );
}

const outDir = inFileProvider(DESKTOP)
  ? path.join(os.homedir(), 'Library', 'Caches', 'IBKR-Assistant', signed ? 'dist-signed' : 'dist')
  : DIST;
if (outDir !== DIST) console.log(`项目在 iCloud 同步目录里,构建输出放到 ${outDir}(DMG 最后拷回 dist/)`);

// ---- 2. 打包 --------------------------------------------------------------------------
run('npm', ['run', 'ui:build']);
run('npm', ['run', 'notices']);   // 第三方许可声明:随包进 resources(tools/gen_notices.js);许可不在白名单里的在这里就失败
run('npm', ['run', 'stage:engine:mac']);
run('npm', ['run', 'smoke:engine']);

async function main() {
  const { build, Platform, Arch } = require('electron-builder');
  console.log(`\n$ electron-builder --mac dmg --arm64(${signed ? 'Developer ID + 公证' : 'ad-hoc'})`);
  await build({
    projectDir: DESKTOP,
    targets: Platform.MAC.createTarget('dmg', Arch.arm64),
    publish: 'never',
    // 只给覆盖项:electron-builder 先读 package.json 的 build,再把这里深合并上去
    config: {
      directories: { output: outDir },
      ...(signed
        ? {
            // 签名版换一份更严的权限:同一个 Team 签的库过得了库校验,不再需要 disable-library-validation
            mac: {
              identity: team,
              notarize: true,
              entitlements: 'build/entitlements.mac.signed.plist',
              entitlementsInherit: 'build/entitlements.mac.signed.plist',
            },
            dmg: { sign: true },
          }
        : {}),
    },
  });

  const app = path.join(outDir, 'mac-arm64', `${pkg.build.productName}.app`);
  const dmg = path.join(outDir, `${pkg.build.productName}-${pkg.version}-mac-arm64.dmg`);
  if (!fs.existsSync(app) || !fs.existsSync(dmg)) fail(`找不到产物:${app} / ${dmg}`);

  if (signed) {
    // ---- 3. DMG 本身也公证 + 装订:electron-builder 只公证了里面的 .app ----------------------
    run('xcrun', ['notarytool', 'submit', dmg, '--wait', ...notary]);
    // 公证没过时 stapler 会失败;看原因:xcrun notarytool log <上面打印的 id> <同样的凭据参数>
    run('xcrun', ['stapler', 'staple', dmg]);
  }

  // ---- 4. 自验:签名完整;签名版再按 Gatekeeper 的口径验 --------------------------------------
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  if (signed) {
    run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]); // 期望 source=Notarized Developer ID
    run('xcrun', ['stapler', 'validate', app]);
    run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg]);
    run('xcrun', ['stapler', 'validate', dmg]);
  }

  if (outDir !== DIST) {
    fs.mkdirSync(DIST, { recursive: true });
    fs.copyFileSync(dmg, path.join(DIST, path.basename(dmg)));
    console.log(`\n应用包留在 ${app}`);
  }
  console.log(`\n✓ ${signed ? '已签名、已公证' : 'ad-hoc 签名'}:dist/${path.basename(dmg)}`);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
