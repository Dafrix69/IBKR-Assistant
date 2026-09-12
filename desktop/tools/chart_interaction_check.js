// 图表交互的端到端核对:截图只看得出"画得对不对",看不出"用起来对不对"。这里在预览台的 K线 PA 图上
// 真的发鼠标事件(滚轮、拖动、双击),读图表库的视口与价格轴状态,核对几条写进界面说明里的承诺:
//
//   1. 打开时铺满全部 K 线
//   2. 滚轮缩放后,再点一次「分析」(与 20 秒自动刷新同一条路径)不会把缩放到的位置刷掉
//   3. 平移到中间后切换「涨跌配色」,视图不被拽回最右边
//   4. 双击时间轴回到打开时铺满的样子(不是库默认的 6px 一根)
//   5. 拖过价格轴(自动缩放被库关掉)之后换一个标的,价格轴恢复自动
//   6. 全程渲染进程零 error 级控制台消息
//
//   npm run ui:preview && npx electron tools/chart_interaction_check.js renderer-react/dist-preview/index.html
//
// 依赖预览构建里挂在图表容器上的 __chart(engine.ts,生产构建里没有)。退出码 0 通过 / 1 失败。
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const previewPath = path.resolve(process.argv.slice(2).find((a) => a.endsWith('.html')) || 'renderer-react/dist-preview/index.html');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'dafri-chartcheck-')));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => { /* 由 run() 决定何时退出 */ });
// 卡住(比如预览页没加载出来)也要退出,别让脚本化的调用方一直等
setTimeout(() => { process.stderr.write('超时 90 秒,放弃\n'); app.exit(1); }, 90_000).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const consoleErrors = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}\n`);
};

async function run() {
  const win = new BrowserWindow({
    width: 1360, height: 1000, show: false, useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') consoleErrors.push(String(e.message).slice(0, 200));
  });
  const js = (code) => win.webContents.executeJavaScript(code);
  await win.loadFile(previewPath);
  await sleep(600);
  await win.webContents.insertCSS('*, *::before, *::after { transition: none !important; animation: none !important; }');

  // ---- 打开 K线 PA,分析 NVDA ----
  await js(`window.__dafriNavigate && window.__dafriNavigate('pa')`);
  await sleep(350);
  const analyze = async (symbol) => {
    await js(`(() => {
      const s = document.getElementById('pa-symbol');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, ${JSON.stringify(symbol)});
      s.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => document.getElementById('btn-pa-run').click(), 50);
    })()`);
    for (let waited = 0; waited < 6000; waited += 150) {
      await sleep(150);
      if (await js(`!!document.querySelector('.pa-chart-wrap')?.__chart`)) break;
    }
    await sleep(500);
  };
  await analyze('NVDA');
  if (!(await js(`!!document.querySelector('.pa-chart-wrap')?.__chart`))) {
    check('K线 PA 图挂上了', false, '没找到 .pa-chart-wrap.__chart(预览构建?)');
    return finish(win);
  }
  await js(`document.querySelector('.pa-chart-wrap').scrollIntoView({ block: 'center' })`);
  await sleep(300);

  const state = () => js(`(() => {
    const host = document.querySelector('.pa-chart-wrap');
    const c = host.__chart;
    const r = c.timeScale().getVisibleLogicalRange();
    const rect = c.chartElement().getBoundingClientRect();
    return {
      from: r ? r.from : null, to: r ? r.to : null,
      bars: document.querySelectorAll('.pa-chart-wrap').length && c.panes()[0].getSeries().length,
      n: (c.panes()[0].getSeries()[0].data() || []).length,
      autoScale: c.priceScale('right', 0).options().autoScale,
      axisH: c.timeScale().height(), axisW: c.priceScale('right', 0).width(),
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    };
  })()`);
  const fmt = (s) => `[${s.from == null ? '-' : s.from.toFixed(1)}, ${s.to == null ? '-' : s.to.toFixed(1)}] / n=${s.n}`;
  // 隐藏窗口收不到 sendInputEvent 的鼠标事件(实测滚轮、拖动全被丢掉),改在页面里对那个点下的元素派发 DOM 事件。
  // 图表库听的就是 mousedown / mousemove / mouseup / wheel / dblclick,不检查 isTrusted
  const mouse = (type, x, y, extra = {}) => js(`(() => {
    const x = ${Math.round(x)}, y = ${Math.round(y)};
    const el = document.elementFromPoint(x, y) || document.body;
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    const t = ${JSON.stringify(type)};
    const extra = ${JSON.stringify(extra)};
    if (t === 'mouseWheel') {
      el.dispatchEvent(new WheelEvent('wheel', { ...base, deltaY: extra.deltaY || 0, deltaMode: 0 }));
    } else {
      const map = { mouseDown: 'mousedown', mouseUp: 'mouseup', mouseMove: 'mousemove', dblclick: 'dblclick' };
      const pressed = t === 'mouseDown' || (t === 'mouseMove' && extra.button === 'left');
      el.dispatchEvent(new MouseEvent(map[t], { ...base, button: 0, buttons: pressed ? 1 : 0, detail: extra.clickCount || 0 }));
    }
  })()`);
  // 连续渲染几帧,让库处理完输入(隐藏窗口里 capturePage 会推动合成)
  const settle = async () => { for (let i = 0; i < 3; i += 1) { await win.webContents.capturePage(); await sleep(120); } };

  let s0 = await state();
  const fitted = (s) => s.from <= 0.5 && s.to >= s.n - 1.5;
  check('1. 打开时铺满全部 K 线', fitted(s0), fmt(s0));

  // ---- 2. 滚轮缩放,再点「分析」 ----
  const cx = s0.left + (s0.width - s0.axisW) * 0.6;
  const cy = s0.top + s0.height * 0.45;
  await mouse('mouseMove', cx, cy);
  for (let i = 0; i < 6; i += 1) {
    await mouse('mouseWheel', cx, cy, { deltaX: 0, deltaY: -120, wheelTicksY: 1, canScroll: true });
    await sleep(40);
  }
  await settle();
  const s1 = await state();
  const zoomed = s1.to - s1.from < (s0.to - s0.from) * 0.9;
  check('2a. 滚轮能缩放', zoomed, `${fmt(s0)} → ${fmt(s1)}`);
  await analyze('NVDA');
  await settle();
  const s2 = await state();
  const kept = Math.abs((s2.to - s2.from) - (s1.to - s1.from)) < 1 && Math.abs(s2.to - s1.to) < 1.5;
  check('2b. 再点「分析」不刷掉缩放', zoomed && kept, `${fmt(s1)} → ${fmt(s2)}`);

  // ---- 3. 平移到中间,切换涨跌配色 ----
  await mouse('mouseDown', cx, cy, { button: 'left', clickCount: 1 });
  for (let i = 1; i <= 10; i += 1) {
    await mouse('mouseMove', cx + i * 25, cy, { button: 'left' });
    await sleep(20);
  }
  await mouse('mouseUp', cx + 250, cy, { button: 'left', clickCount: 1 });
  await settle();
  const s3 = await state();
  const panned = s3.to < s3.n - 3;
  await js(`document.documentElement.dataset.updown = document.documentElement.dataset.updown === 'red-up' ? 'green-up' : 'red-up'`);
  await settle();
  const s4 = await state();
  const stayed = Math.abs(s4.from - s3.from) < 1 && Math.abs(s4.to - s3.to) < 1;
  check('3. 平移后换涨跌配色,视图不动', panned && stayed, `${fmt(s3)} → ${fmt(s4)}${panned ? '' : '(没拖动成功)'}`);

  // ---- 4. 双击时间轴复位 ----
  const ax = s4.left + (s4.width - s4.axisW) * 0.5;
  const ay = s4.top + s4.height - s4.axisH / 2;
  await mouse('mouseDown', ax, ay, { button: 'left', clickCount: 1 });
  await mouse('mouseUp', ax, ay, { button: 'left', clickCount: 1 });
  await mouse('mouseDown', ax, ay, { button: 'left', clickCount: 2 });
  await mouse('mouseUp', ax, ay, { button: 'left', clickCount: 2 });
  await mouse('dblclick', ax, ay, { clickCount: 2 });
  await settle();
  const s5 = await state();
  check('4. 双击时间轴回到铺满', fitted(s5), `${fmt(s4)} → ${fmt(s5)}`);

  // ---- 5. 拖价格轴(关掉自动缩放),换标的 ----
  const px = s5.left + s5.width - s5.axisW / 2;
  const py = s5.top + s5.height * 0.4;
  await mouse('mouseDown', px, py, { button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i += 1) {
    await mouse('mouseMove', px, py + i * 12, { button: 'left' });
    await sleep(20);
  }
  await mouse('mouseUp', px, py + 96, { button: 'left', clickCount: 1 });
  await settle();
  const s6 = await state();
  await analyze('AAPL');
  await settle();
  const s7 = await state();
  check('5. 拖过价格轴后换标的,价格轴恢复自动', s6.autoScale === false && s7.autoScale === true, `拖完 autoScale=${s6.autoScale} → 换标的后 ${s7.autoScale}`);

  return finish(win);
}

function finish(win) {
  check('6. 渲染进程零 error 级控制台消息', consoleErrors.length === 0, consoleErrors.join(' | ') || '0 条');
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(failed ? `\n${failed} 项失败\n` : `\n全部通过(${results.length} 项)\n`);
  win.destroy();
  setTimeout(() => app.exit(failed ? 1 : 0), 300);
}

app.whenReady().then(run).catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + '\n');
  app.exit(1);
});
