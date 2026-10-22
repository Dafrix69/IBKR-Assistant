// 把界面用的图标从 React 版原样渲染成 SVG 文件(native/app/kit/icons/),Qt 版画的就是同一份线稿,不手抄。
//   DESKTOP_MODULES=<装好依赖的 desktop/node_modules> node native/tools/gen_icons.mjs
// 来源:desktop/renderer-react/src/ui/Icons.tsx(侧栏与页面的线稿,描边 currentColor)、ui/AppMark.tsx(应用标)。
// 线稿里的 currentColor 原样留着:Qt 那边按要的颜色现替换(app/icon_provider)。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const ui = join(repo, 'desktop/renderer-react/src/ui');
const modules = process.env.DESKTOP_MODULES || join(repo, 'desktop/node_modules');
const req = createRequire(join(modules, 'x.js'));
const { build } = await import(pathToFileURL(req.resolve('rolldown')).href);
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');

const tmp = join(process.env.TMPDIR || '/tmp', 'gen-icons');
mkdirSync(tmp, { recursive: true });
const entry = join(tmp, 'entry.tsx');
writeFileSync(entry, `export { SfIcon } from ${JSON.stringify(join(ui, 'Icons.tsx'))};\nexport { AppMark } from ${JSON.stringify(join(ui, 'AppMark.tsx'))};\n`);
const out = join(tmp, 'icons.cjs');
await build({ input: entry, external: ['react', 'react/jsx-runtime'], output: { file: out, format: 'cjs' }, transform: { jsx: 'react-jsx' }, write: true, logLevel: 'silent' });
const Module = await import('node:module');
// 打出来的包 require('react'):从装好依赖的那份 node_modules 找
const resolved = Object.fromEntries(['react', 'react/jsx-runtime'].map((r) => [r, req.resolve(r)]));
const origResolve = Module.default._resolveFilename;
Module.default._resolveFilename = function (request, ...rest) {
  return resolved[request] ?? origResolve.call(this, request, ...rest);
};
const mod = createRequire(out)(out);

const names = [...readFileSync(join(ui, 'Icons.tsx'), 'utf8').matchAll(/^\s*'(sf-[a-z0-9-]+)':/gm)].map((m) => m[1]);
const dest = join(repo, 'native/app/kit/icons');
mkdirSync(dest, { recursive: true });
const xmlns = (svg) => svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ').replace(/ aria-hidden="true"| focusable="false"| class="[^"]*"/g, '');
for (const name of names) writeFileSync(join(dest, `${name}.svg`), xmlns(renderToStaticMarkup(React.createElement(mod.SfIcon, { name, size: 16 }))) + '\n');
writeFileSync(join(dest, 'app-mark.svg'), xmlns(renderToStaticMarkup(React.createElement(mod.AppMark, { size: 24 }))) + '\n');
// AntD 自带的几枚(搜索框、清空、表头排序的上下三角、折叠箭头):@ant-design/icons 的组件原样渲染,fill 是 currentColor
const antd = { 'ad-search': 'SearchOutlined', 'ad-close-circle': 'CloseCircleFilled', 'ad-caret-up': 'CaretUpOutlined', 'ad-caret-down': 'CaretDownOutlined', 'ad-right': 'RightOutlined', 'ad-left': 'LeftOutlined', 'ad-double-left': 'DoubleLeftOutlined', 'ad-double-right': 'DoubleRightOutlined', 'ad-swap-right': 'SwapRightOutlined', 'ad-calendar': 'CalendarOutlined' };
for (const [name, component] of Object.entries(antd)) {
  const Icon = req(`@ant-design/icons/lib/icons/${component}`).default;
  const html = renderToStaticMarkup(React.createElement(Icon));
  const svg = html.match(/<svg[\s\S]*<\/svg>/)[0].replace(/ width="1em" height="1em"/, ' width="16" height="16"').replace(/ data-icon="[^"]*"/, '');
  writeFileSync(join(dest, `${name}.svg`), xmlns(svg) + '\n');
}
console.log(`${names.length} 个线稿 + ${Object.keys(antd).length} 枚 AntD 图标 + app-mark.svg → ${dest}`);
