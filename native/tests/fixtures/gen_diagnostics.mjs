// 生成 diagnostics.json:诊断包(desktop/diagnostics.js)的 buildReport / buildSummary / defaultFileName / tailFile 现算的结果。
// 文件在临时目录里真的写出来再读;结果里的目录换成 <DIR>,C++ 那边在自己的临时目录里造同样的文件、同样换掉再比。
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_diagnostics.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const D = createRequire(import.meta.url)(join(here, '..', '..', '..', 'desktop/diagnostics.js'));

const config = '{\n  "zeta": 1,\n  "accounts": [{"alias": "模拟", "account_id": "DU7654321", "is_paper": true}, {"alias": "主", "account_id": "U1234567", "note": "备注 U1234567 sk-abcdefghijk"}],\n  "llm": {"model": "claude", "max_tokens": 8000, "keychain_service": "dafri-llm-api-key"},\n  "policies": {"auto_execute": true}\n}';
const long = 'x'.repeat(2100);
const logLines = Array.from({ length: 1600 }, (_, i) => (i === 1590 ? `[engine] 账户 U1234567 被拒 key sk-zzzzzzzzzz at /Users/zhangsan/app ${long}` : i === 1595 ? '[通知] 成交回报 | BUY AAPL 100' : `line ${i}`));
const files = {
  'settings.json': config,
  'main.log': logLines.join('\n') + '\n',
  'main.old.log': Array.from({ length: 320 }, (_, i) => `old ${i}`).join('\r\n'),
  'empty.log': '',
  'broken.json': '{ "accounts": [',
};
const status = '{"protocol":"1.0","broker_provider":"ibkr","broker_connected":true,"broker_upstream_ok":false,"market_status":"盘中","now_et":"2026-10-08 09:42:11","auto_execute":true,"allow_live_trading":false,"breaker":{"engaged":true,"reason":"Dock 菜单触发熔断"},"model":"claude-opus-5","prompt_version":"v7","accounts":[{"alias":"主","account_id":"U1234567"}]}';
const selftest = '{"ok":true,"checks":[{"name":"db","ok":true}],"symbol_aliases":{"标普":"SPX","纳指":"NDX"}}';
const backups = '{"dir":"/Users/zhangsan/Library/Application Support/IBKR-Assistant/backups","db_path":"/Users/zhangsan/x/trades.db","list":[]}';
const app = '{"name":"IBKR-Assistant","version":"0.5.1","packaged":false,"qt":"6.12.0","platform":"darwin","arch":"arm64","os":"Darwin 27.0.0","locale":"zh-CN","memory_mb":16384,"user_data":"/Users/zhangsan/Library/Application Support/IBKR-Assistant"}';

const dir = mkdtempSync(join(tmpdir(), 'dg-'));
for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
const NOW = Date.UTC(2026, 9, 18, 4, 5, 6);
const swap = (s) => s.split(dir).join('<DIR>');
const reports = [];
const inputs = [
  { name: 'full', configFile: 'settings.json', logFile: 'main.log', oldLogFile: 'main.old.log', engine: { running: true, restarts: 2, status, selftest, backups, errors: ['data.backups:超时'] }, extra: '{"consent":{"version":"2026-10-15"},"last_update_check":null}' },
  { name: 'engine-down', configFile: 'broken.json', logFile: 'missing.log', oldLogFile: 'nope.log', engine: { running: false, restarts: 0, errors: [] }, extra: '{}' },
  { name: 'no-config', configFile: 'absent.json', logFile: 'empty.log', oldLogFile: null, engine: null, extra: null },
];
for (const inp of inputs) {
  const engine = inp.engine ? { ...inp.engine, status: inp.engine.status ? JSON.parse(inp.engine.status) : undefined, selftest: inp.engine.selftest ? JSON.parse(inp.engine.selftest) : undefined, backups: inp.engine.backups ? JSON.parse(inp.engine.backups) : undefined } : undefined;
  const input = { app: JSON.parse(app), configPath: join(dir, inp.configFile), logPath: join(dir, inp.logFile), oldLogPath: inp.oldLogFile ? join(dir, inp.oldLogFile) : undefined, engine, extra: inp.extra ? JSON.parse(inp.extra) : undefined, now: NOW, homedir: '/Users/zhangsan' };
  reports.push({ ...inp, report: swap(D.buildReport(input)), summary: swap(D.buildSummary(input)) });
}
const tails = ['main.log', 'main.old.log', 'empty.log', 'missing.log'].map((f) => { const t = D.tailFile(join(dir, f), 3); return { file: f, ok: t.ok, total: t.total, lines: t.lines, error: t.error ?? null }; });
writeFileSync(join(here, 'diagnostics.json'), JSON.stringify({ generator: 'gen_diagnostics.mjs', tz: process.env.TZ || '', now: NOW, logTailLines: D.LOG_TAIL_LINES, files, app, reports, tails, fileName: D.defaultFileName(NOW) }, null, 1) + '\n');
rmSync(dir, { recursive: true, force: true });
console.log('diagnostics.json written');
