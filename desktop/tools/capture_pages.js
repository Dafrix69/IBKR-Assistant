// 截图集生成器:用 Electron 自己把预览台的每一页拍成 PNG。
//
//   npx electron tools/capture_pages.js <preview.html> <outDir> [--theme dark|light] [--scale 1|1.5] [--widths 1360,1900]
//
// 为什么用 Electron 而不是浏览器:窄窗口丢弃顶栏胶囊、titleBarOverlay 留白、系统字体栈,
// 这些都只在 Electron 里才是真实的。为什么要 --scale:用户的问题截图是在 Windows 150% 缩放下
// 拍的,100% 下看不出同样的问题。
//
// 每一页对应一个 PNG:<theme>-<scale>x-<width>-<tab>.png。K线 PA 页会先填标的、点「分析」再拍。
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

app.commandLine.appendSwitch('force-device-scale-factor', String(scale));
app.commandLine.appendSwitch('high-dpi-support', '1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      webPreferences: { contextIsolation: true, sandbox: true, offscreen: false },
    });
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
      await shoot(win, name);
      manifest.push(name);
    }
    // 一个窗口刚销毁就 loadFile 下一个,偶发 ERR_FAILED(-2);等一拍再建下一个
    win.destroy();
    await sleep(300);
  }
  fs.writeFileSync(path.join(outDir, `manifest-${theme}-${scale}x.json`), JSON.stringify(manifest, null, 2));
  process.stdout.write(`${manifest.length} 张 → ${outDir}\n`);
  app.quit();
}

app.whenReady().then(run).catch((err) => {
  process.stderr.write(String(err && err.stack || err) + '\n');
  app.exit(1);
});
