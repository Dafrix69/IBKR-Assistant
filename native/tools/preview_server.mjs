// 排版对照用的预览台服务器:照常发 React 版的 dist-preview,另外收浏览器里 text_dump.js 量出来的结果,
// 写进 <落盘目录>/<名字>.json(不用把一大段 JSON 抄来抄去)。只听本机。
//   node native/tools/preview_server.mjs <端口> <dist-preview 目录> <落盘目录>
//   浏览器里:fetch('/__dump/tracker', { method: 'POST', body: JSON.stringify(结果) })
import { createServer } from 'node:http';
import { mkdirSync, readFile, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const [port = '5213', rootArg = '.', dumpArg = './dumps'] = process.argv.slice(2);
const root = resolve(rootArg);
const dumps = resolve(dumpArg);
mkdirSync(dumps, { recursive: true });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (req.method === 'POST' && url.startsWith('/__dump/')) {
    const name = url.slice('/__dump/'.length).replace(/[^\w.-]/g, '_');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const file = join(dumps, `${name}.json`);
      writeFileSync(file, body);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(file);
    });
    return;
  }
  const file = join(root, url === '/' ? 'index.html' : url);
  // 加上分隔符再比:只比前缀的话,同名开头的兄弟目录(dist-preview-x/)也会被放出去
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(Number(port), '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}, dumps → ${dumps}`));
