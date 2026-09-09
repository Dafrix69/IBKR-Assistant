// React 壳的构建配置。
//
//   npx vite build                      → dist/         主进程默认加载这一份
//   npx vite build --mode preview       → dist-preview/ 预览台:window.dafri 换成 tools/mock-bridge.js 的假数据源
//
// 三件事值得说明:
//   · base './':产物用相对路径引用,Electron 用 file:// 加载,绝对路径会指到盘符根;
//   · 每次构建生成一个随机 nonce,写进 index.html 的 CSP 与 <meta name="csp-nonce">,
//     并落到 dist/csp-nonce.txt——主进程把它拼进响应头的 CSP,两处必须一致;
//   · 去掉 Vite 给 <script type="module"> 加的 crossorigin:file:// 下的 origin 是 null,
//     带 crossorigin 的模块脚本会被 CORS 拦掉。
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function dafriHtml(preview: boolean, nonce: string, outDir: string): Plugin {
  return {
    name: 'dafri-html',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        let out = html.replaceAll('__CSP_NONCE__', nonce).replace(/ crossorigin(="[^"]*")?/g, '');
        if (preview) {
          // 假数据源必须先于应用脚本执行:经典脚本同步执行,模块脚本 defer,顺序天然满足
          out = out.replace('<div id="root">', '<script src="./mock-bridge.js"></script>\n    <div id="root">');
        }
        return out;
      },
    },
    closeBundle() {
      fs.writeFileSync(path.join(outDir, 'csp-nonce.txt'), nonce);
      if (preview) {
        // DAFRI_MOCK 选数据源:mock-bridge.js(有数据)/ mock-bridge-empty.js(首次启动)/ mock-bridge-stress.js
        const mock = process.env.DAFRI_MOCK || 'mock-bridge.js';
        fs.copyFileSync(path.resolve(__dirname, '../tools', mock), path.join(outDir, 'mock-bridge.js'));
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const preview = mode === 'preview';
  const nonce = crypto.randomBytes(16).toString('base64');
  const outDir = path.resolve(__dirname, preview ? 'dist-preview' : 'dist');
  return {
    // 从 desktop/ 里用 --config 调起时 cwd 不是这里,根目录要显式指定
    root: __dirname,
    base: './',
    plugins: [react(), dafriHtml(preview, nonce, outDir)],
    build: {
      outDir,
      emptyOutDir: true,
      target: 'esnext',
      modulePreload: { polyfill: false },
      // 单个包:Electron 本地加载没有分包的收益,却多出一堆 modulepreload 的 crossorigin 要处理
      rollupOptions: { output: { manualChunks: undefined, inlineDynamicImports: true } },
      chunkSizeWarningLimit: 4000,
    },
  };
});
