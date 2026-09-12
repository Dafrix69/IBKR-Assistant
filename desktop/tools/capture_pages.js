// 截图集生成器:用 Electron 自己把预览台的每一页拍成 PNG。
//
//   npx electron tools/capture_pages.js <preview.html> <outDir> [--theme dark|light] [--scale 1|1.5] [--widths 1360,1900] [--only pa,trade] [--check] [--demo]
//
// 为什么用 Electron 而不是浏览器:窄窗口丢弃顶栏胶囊、titleBarOverlay 留白、系统字体栈,
// 这些都只在 Electron 里才是真实的。为什么要 --scale:用户的问题截图是在 Windows 150% 缩放下
// 拍的,100% 下看不出同样的问题。
//
// 每一页对应一个 PNG:<theme>-<scale>x-<width>-<tab>.png。K线 PA 页会先填标的、点「分析」再拍。
//
// --check:不只是拍照,还收集渲染进程的控制台错误。任何 error 级消息都算失败(CSP 违规也在内:
// 动态注入的 <style> 都该带 nonce),K线 PA 页必须画出 canvas——这是渲染层唯一的自动化 smoke:每页各点一遍,控制台零报错。
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
const demo = args.includes('--demo');  // 各页先点一遍主按钮(解析 / 分析 / 回测 / 扫描),拍出有内容的样子,给 README 用
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
  // 隐藏窗口只在被截图时才合成一帧,canvas 图的 requestAnimationFrame 绘制发生在那一帧之后:
  // 第一张里图是空的。有哪个图表容器一块定了尺寸的画布都没有,就再截,最多三次。
  // (不能要求每块画布都有尺寸:图表库给隐藏的左侧价格轴留的画布本来就是 0 宽)
  // capturePage 拿到的是**上一次合成**的那一帧:页面在后台更新(点完「分析」结果回来)不会触发合成,
  // 直接拍会拍到点按钮那一刻。先空拍一张触发合成,等一拍再拍正式的
  await win.webContents.capturePage();
  await sleep(150);
  let img = await win.webContents.capturePage();
  for (let i = 0; i < 3; i++) {
    const undrawn = await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.chart-host')).some((h) => !h.querySelector('.chart-empty') && !Array.from(h.querySelectorAll('canvas')).some((c) => c.width > 0 && c.height > 0))`,
    );
    if (!undrawn) break;
    await sleep(400);
    img = await win.webContents.capturePage();
  }
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
        // Electron ≥ 36:事件对象带 level('error' 等)与 message;旧的位置参数已废弃。
        // CSP 违规也算错误:动态 <style> 都该带 nonce(见 renderer-react/src/main.tsx),不再豁免
        if (event.level === 'error') {
          consoleErrors.push(String(event.message).slice(0, 200));
        }
      });
    }
    await win.loadFile(previewPath);
    await sleep(600);
    // 隐藏窗口里 CSS 过渡不会推进:控件从"禁用"翻到"可用"时会停在起始色,拍出来全是灰的。
    // 截图只要终态,过渡与动画一律关掉(insertCSS 走调试通道,不受页面 CSP 约束)。
    await win.webContents.insertCSS('*, *::before, *::after { transition: none !important; animation: none !important; }');
    // 叶子页:侧栏里不带 data-default 的项 + 合并页(行情 / 接入)页头分段控件里的子页
    // 叶子页清单由 React 壳报出(window.__dafriLeafTabs:侧栏项 + 合并页的子页)
    const tabs = await win.webContents.executeJavaScript(`window.__dafriLeafTabs || []`);
    const wanted = only ? only.split(',') : tabs;
    for (const tab of tabs) {
      if (!wanted.includes(tab)) continue;
      await win.webContents.executeJavaScript(
        `(() => {
          if (window.__dafriNavigate) window.__dafriNavigate('${tab}');
          const c = document.querySelector('#root .content');
          if (c) c.scrollTop = 0;
        })()`,
      );
      await sleep(350);
      if (tab === 'pa') {
        // React 的受控输入框:直接赋 value 状态不会变,要走原生 setter 再派发 input 事件
        await win.webContents.executeJavaScript(`
          const s = document.getElementById('pa-symbol');
          if (s && !s.value) {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, 'NVDA');
            s.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const b = document.getElementById('btn-pa-run');
          if (b) setTimeout(() => b.click(), 50);
        `);
        // 等结果出来(图画出来,或页面说明了为什么没有),最多 6 秒;固定等 900 毫秒经常拍到「正在取 K 线…」。
        // 初始提示「输入标的后点「分析」」和报错用的是同一个空状态组件,只能按文字区分,不然一进来就算"好了"
        for (let waited = 0; waited < 6000; waited += 150) {
          await sleep(150);
          const ready = await win.webContents.executeJavaScript(
            `(() => {
              if (document.querySelector('.pa-chart-wrap canvas')) return true;
              const box = document.getElementById('pa-result');
              if (!box) return false;
              const text = box.innerText || '';
              if (text.includes('正在取 K 线') || text.includes('输入标的后点')) return false;
              return !!box.querySelector('.empty, .empty-state, .ant-empty, .ant-alert');
            })()`,
          );
          if (ready) break;
        }
        await sleep(400);
      }
      if (demo) {
        const DEMO = {
          trade: "(() => { const t = document.getElementById('instruction'); if (t) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, '买入 AAPL 100股 limit 316,理由:回调到位'); t.dispatchEvent(new Event('input', { bubbles: true })); } const b = document.getElementById('btn-parse'); if (b) setTimeout(() => b.click(), 50); })();",
          review: "(() => { const b = document.getElementById('btn-review-run'); if (b) b.click(); })();",
          records: "(() => { const r = document.querySelector('.records-table tbody tr[data-row-key]'); if (r) r.click(); })();",
          tracker: "(() => { const b = [...document.querySelectorAll('#page-tracker button')].find((x) => x.textContent.trim() === '设置追踪'); if (b) b.click(); setTimeout(() => { const f = document.querySelector('.track-form > .track-field:has(.sub) input'); if (f) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, '450'); f.dispatchEvent(new Event('input', { bubbles: true })); } }, 120); })();",
          // React 的受控输入框:直接赋 value 状态不会变,要走原生 setter 再派发 input 事件
          backtest: "(() => { const i = document.getElementById('bt-symbol'); if (i) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'NVDA'); i.dispatchEvent(new Event('input', { bubbles: true })); } const b = document.getElementById('btn-bt-run'); if (b) setTimeout(() => b.click(), 50); })();",
          book: "(() => { const i = document.getElementById('book-symbol'); if (i) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'SPY'); i.dispatchEvent(new Event('input', { bubbles: true })); } const b = document.getElementById('btn-book-load'); if (b) setTimeout(() => b.click(), 50); })();",
          rs: "(() => { const b = document.getElementById('btn-rs-run'); if (b) b.click(); })();",
          inflection: "(() => { const b = document.getElementById('btn-infl-run'); if (b) b.click(); })();",
          deviation: "(() => { const b = document.getElementById('btn-dev-run'); if (b) b.click(); })();",
        };
        if (DEMO[tab]) {
          await win.webContents.executeJavaScript(DEMO[tab]);
          // 隐藏窗口里 requestAnimationFrame 来得慢,canvas 图要多等一拍才画出来
          await sleep(1800);
        }
      }
      const name = `${theme}-${scale}x-${width}-${tab}`;
      if (check && tab === 'pa') {
        // 只在真出了结果时要求画布:首次启动那份数据源里 paAnalyze 是拒绝的,页面本就该显示"还没数据",
        // 那种情况下要求 canvas 等于要求它凭空画一张图
        const verdict = await win.webContents.executeJavaScript(
          `(() => {
            const c = document.querySelector('.pa-chart-wrap canvas');
            if (c && c.width > 0 && c.height > 0) return 'drawn';
            const box = document.getElementById('pa-result');
            return box && box.querySelector('.empty, .empty-state, .ant-empty, .ant-alert') ? 'no-data' : 'missing';
          })()`,
        );
        if (verdict === 'missing') consoleErrors.push('K线 PA 页既没画出 canvas,也没说明为什么没有');
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
