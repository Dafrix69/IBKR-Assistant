'use strict';
// 界面静态审计:找那些用肉眼一页页看很容易漏、但机器一扫就出来的问题。
//
//   node tools/audit_ui.js
//
// 查四类:
//   1. 没有可访问名字的按钮(读屏软件只会念"按钮")
//   2. 没有标签也没有 placeholder 的输入框
//   3. app/*.js 引用了但 index.html 里不存在的 DOM id(点了没反应的按钮多半是这个)
//   4. 界面文案里漏出来的内部枚举(BUY / LMT / Submitted 这类)
//
// 不是替代人眼看,是把人眼不擅长的那部分交给机器。
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="(app\/[^"]+)"><\/script>/g)].map((m) => m[1]);
const app = scripts.map((name) => fs.readFileSync(path.join(root, 'renderer', name), 'utf8')).join('\n');

const problems = [];

// ---- 1. 按钮的可访问名字 ----
for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
  const attrs = m[1];
  const text = m[2].replace(/<[^>]+>/g, '').trim();
  if (text || attrs.includes('aria-label') || attrs.includes('title=')) continue;
  const ident = /id="([^"]+)"/.exec(attrs);
  problems.push('无名按钮:' + (ident ? ident[1] : attrs.trim().slice(0, 40)));
}

// ---- 2. 输入框的标签 ----
const labelled = new Set([...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1]));
for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
  const attrs = m[2];
  if (attrs.includes('type="checkbox"') || attrs.includes('type="radio"')) continue; // 这两种在本项目里都包在 <label> 里
  const ident = /id="([^"]+)"/.exec(attrs);
  if (!ident) continue;
  if (labelled.has(ident[1]) || attrs.includes('placeholder') || attrs.includes('aria-label')) continue;
  problems.push('输入框没有标签也没有 placeholder:' + ident[1]);
}

// ---- 3. 引用了不存在的 id ----
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([
  ...[...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...app.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
]);
// 运行时动态创建的不算
const created = new Set([...app.matchAll(/\.id = '([^']+)'/g)].map((m) => m[1]));
for (const name of [...used].filter((n) => !ids.has(n) && !created.has(n)).sort()) {
  problems.push('引用了不存在的 DOM id:' + name);
}

// ---- 4. 漏到界面上的内部枚举 ----
// 只查静态 HTML 里的可见文本;动态渲染的那部分由预览台的运行时扫描覆盖。
const LEAKS = ['Submitted', 'PreSubmitted', 'Filled', 'Cancelled', 'Inactive'];
const visible = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
const words = new Set(visible.split(/[^A-Za-z0-9_]+/));
for (const token of LEAKS) {
  if (words.has(token)) problems.push('界面文案里有内部枚举:' + token);
}

if (problems.length) {
  console.log(`发现 ${problems.length} 个问题:`);
  for (const p of problems) console.log('  ·', p);
  process.exit(1);
}
console.log('界面静态审计:未发现问题');
