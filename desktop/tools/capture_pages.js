// 截图集生成器:用 Electron 自己把预览台的每一页拍成 PNG。
//
//   npx electron tools/capture_pages.js <preview.html> <outDir> [--theme dark|light] [--scale 1|1.5] [--widths 1360,1900] [--only pa,trade] [--check]
//
// 为什么用 Electron 而不是浏览器:窄窗口丢弃顶栏胶囊、titleBarOverlay 留白、系统字体栈,
// 这些都只在 Electron 里才是真实的。为什么要 --scale:用户的问题截图是在 Windows 150% 缩放下
// 拍的,100% 下看不出同样的问题。
//
// 每一页对应一个 PNG:<theme>-<scale>x-<width>-<tab>.png。K线 PA 页会先填标的、点「分析」再拍。
//
// --check:不只是拍照,还收集渲染进程的控制台错误。除了 index.html 里那 6 处已知的内联样式 CSP 提示,
// 任何 error 级消息都算失败,K线 PA 页必须画出 canvas——这是 renderer 唯一的自动化 smoke:16 页各点一遍,控制台零报错。
'use strict';
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2).filter((a) => a !== '.');
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const previewPath = path.resolve(positional[0] || '.uipreview/preview.html');
const outDir = path.resolve(positional[1] || '.uipreview/baseline');
const theme = flag('theme', 'dark');
const scale = Number(flag('scale', '1'));
const widths = flag('widths', '1360').split(',').map(Number);
const only = flag('only', '');          // 只拍这些页,逗号分隔
const height = Number(flag('height', '1000'));
const check = args.includes('--check');
const consoleErrors = [];

// 每次一个全新的 userData:Electron 会把 file:// 页面的 localStorage 持久化在 %AppData%/Electron 下,
// 上一次运行记住的折叠态、密度、标的会带进下一次截图,"首次启动的样子"就再也拍不到了。
app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'dafri-capture-')));

app.commandLine.appendSwitch('force-device-scale-factor', String(scale));
app.commandLine.appendSwitch('high-dpi-support', '1');

// 最后一个窗口销毁时 Electron 默认直接退出——那会把窗口销毁之后的汇总(和 --check 的结论)一起带走
app.on('window-all-closed', () => { /* 由 run() 自己决定何时退出 */ });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);

async function shoot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
}

async function run() {
  fs.mkdirSync(outDir, { recursive: true });
  nativeTheme.themeSource = theme;
  const manifest = [];
  for (const width of widths) {
    const win = new BrowserWindow({
      width, height, show: false, useContentSize: true,
      backgroundColor: theme === 'dark' ? '#1e1e20' : '#f6f6f8',
      // 隐藏窗口默认会节流 requestAnimationFrame,canvas 图就画不出来
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    if (check) {
      win.webContents.on('console-message', (event) => {
        // Electron ≥ 36:事件对象带 level('error' 等)与 message;旧的位置参数已废弃
        if (event.level === 'error' && !/inline style/.test(String(event.message))) {
          consoleErrors.push(String(event.message).slice(0, 200));
        }
      });
    }
    await win.loadFile(previewPath);
    await sleep(600);
    const tabs = await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.nav-item[data-tab]')).map((b) => b.dataset.tab)`,
    );
    const wanted = only ? only.split(',') : tabs;
    for (const tab of tabs) {
      if (!wanted.includes(tab)) continue;
      await win.webContents.executeJavaScript(
        `document.querySelector('.nav-item[data-tab="${tab}"]').click(); document.querySelector('.content').scrollTop = 0;`,
      );
      await sleep(350);
      if (tab === 'pa') {
        await win.webContents.executeJavaScript(`
          const s = document.getElementById('pa-symbol');
          if (s && !s.value) { s.value = 'NVDA'; }
          const b = document.getElementById('btn-pa-run');
          if (b) b.click();
        `);
        await sleep(900);
      }
      const name = `${theme}-${scale}x-${width}-${tab}`;
      if (check && tab === 'pa') {
        const ok = await win.webContents.executeJavaScript(
          `(() => { const c = document.querySelector('.pa-canvas'); return !!c && c.width > 0 && c.height > 0; })()`,
        );
        if (!ok) consoleErrors.push('K线 PA 页没有画出 canvas');
      }
      await shoot(win, name);
      manifest.push(name);
    }
    // 一个窗口刚销毁就 loadFile 下一个,偶发 ERR_FAILED(-2);等一拍再建下一个
    win.destroy();
    await sleep(300);
  }
  fs.writeFileSync(path.join(outDir, `manifest-${theme}-${scale}x.json`), JSON.stringify(manifest, null, 2));

  // 结论同时落到 <outDir>/check.txt,脚本化时读文件或看退出码(0 通过 / 1 失败)都行
  let summary = `${manifest.length} 张 → ${outDir}` + NL;
  let code = 0;
  if (check) {
    if (consoleErrors.length) {
      summary += `FAIL 渲染进程 ${consoleErrors.length} 条错误:` + NL + '  ' + consoleErrors.join(NL + '  ') + NL;
      code = 1;
    } else {
      summary += `PASS ${manifest.length} 页控制台零报错,K 线画布已绘制` + NL;
    }
    fs.writeFileSync(path.join(outDir, 'check.txt'), summary);
  }
  process.stdout.write(summary);
  setTimeout(() => app.exit(code), 400);
}

app.whenReady().then(run).catch((err) => {
  process.stderr.write(String(err && err.stack || err) + NL);
  app.exit(1);
});
