'use strict';
// 生成一个能在浏览器里看的界面预览台。
//
//   node tools/build_preview.js . .uipreview/preview.html tools/mock-bridge.js
//
// Electron 窗口截不了图,而 UI 不看见就没法改。这里把真正的 index.html / styles.css /
// app/*.js 原样装进来(全部内联,免得被当成快照转成 data: URL 之后外链全断),
// 只把 contextBridge 换成一份**假的、但形状真实**的数据源——所以看到的排版、
// 间距、层级和真应用完全一致。
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const [rootArg, outArg, stubArg] = process.argv.slice(2);
if (!rootArg || !outArg || !stubArg) {
  console.error('用法:node tools/build_preview.js <desktop 目录> <输出 html> <假 contextBridge 脚本>');
  process.exit(2);
}
const root = path.resolve(rootArg); // desktop/
const out = path.resolve(outArg);
const read = (file) => fs.readFileSync(file, 'utf8');

const html = read(path.join(root, 'renderer', 'index.html'));
let body = html.slice(html.indexOf('<body>') + '<body>'.length, html.lastIndexOf('</body>'));
// renderer 有多个脚本(pa-chart.js、app/*.js),按 body 里出现的顺序内联,和运行时加载顺序一致
const scripts = [...body.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
body = body.replace(/\s*<script src="[^"]+"><\/script>/g, '');

const css = read(path.join(root, 'renderer', 'styles.css'));
const js = scripts.map((name) => read(path.join(root, 'renderer', name))).join('\n');
const stub = read(path.resolve(stubArg));

const page = [
  '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8" />\n',
  '<title>Dafri Trading 预览台</title>\n<style>\n',
  css,
  '\n</style>\n</head>\n<body>\n<script>\n',
  stub,
  '\n</script>\n',
  body,
  '\n<script>\n',
  js,
  '\n</script>\n</body>\n</html>\n',
].join('');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page, 'utf8');
console.log('预览台:', pathToFileURL(out).href);
console.log('大小:', page.length, '字符');
