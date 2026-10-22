// 图表对拍用的浏览器那一半:把 React 版的图表引擎(desktop/renderer-react/src/lib/chart/engine.ts,框架是 lightweight-charts)原样打成一个
// 页面,放进预览台发的目录里(chart-harness/)。浏览器面板里打开它,跑 tools/chart_capture.js 把每个场景量出来:
// 库的公开接口读出来的可见范围、每根的 x、价格 → y、各窗格的高、价格轴宽,外加挂在 fillText 上记下的轴上的每一段字。
//   node native/tools/chart_harness.mjs <装好依赖的 desktop 目录> <预览台的 dist-preview 目录>
// 只读 React 那边的源码,不改它;打出来的文件只进 dist-preview/chart-harness/
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const [desktop, distPreview] = process.argv.slice(2);
if (!desktop || !distPreview) throw new Error('用法:chart_harness.mjs <desktop 目录> <dist-preview 目录>');
const root = join(resolve(desktop), 'renderer-react');
const out = join(resolve(distPreview), 'chart-harness');
mkdirSync(out, { recursive: true });
const entry = join(root, 'chart-harness-entry.ts');
writeFileSync(entry, `import { mountChart } from './src/lib/chart/engine';
(window as any).__chartHarness = { mountChart };
`);
process.on('exit', () => rmSync(entry, { force: true }));
const modules = join(resolve(desktop), 'node_modules');
const { build } = await import(pathToFileURL(join(modules, 'vite/dist/node/index.js')).href);
await build({
  configFile: false,
  logLevel: 'warn',
  root,
  // engine.ts 在 MODE 为 preview 时把库的图表对象挂在容器上(container.__chart),量的时候要它
  mode: 'preview',
  // 用库的开发版(同一份算法、名字没压缩):交互对拍要直接调它的模型(_internal_scrollTimeTo 之类)
  resolve: { conditions: ['development', 'module', 'browser', 'default'] },
  build: { outDir: out, emptyOutDir: false, lib: { entry, formats: ['iife'], name: 'chartHarness', fileName: () => 'harness.js' }, minify: false },
});
// 页面的 CSS 变量(涨跌色、字体)取预览台那一份样式
const css = readdirSync(join(resolve(distPreview), 'assets')).find((f) => f.endsWith('.css'));
writeFileSync(join(out, 'index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="../assets/${css}">
<style>body{margin:0;padding:0;background:#fff}#host{position:absolute;left:0;top:0}</style></head>
<body><div id="host"></div><script src="harness.js"></script></body></html>
`);
// 量的脚本与场景也放过去:页面里 eval(await (await fetch('capture.js')).text()) 就行
copyFileSync(join(here, 'chart_capture.js'), join(out, 'capture.js'));
copyFileSync(join(here, 'chart_interactions.js'), join(out, 'interactions.js'));
copyFileSync(join(here, '..', 'tests', 'fixtures', 'chart_scale_cases.json'), join(out, 'cases.json'));
console.log(`chart-harness → ${out}`);
