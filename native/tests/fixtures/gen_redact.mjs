// 生成 redact.json:主进程的日志脱敏(desktop/redact.js)对一组输入现算的结果,C++ 的 shell/redactor 逐条对。
//   node native/tests/fixtures/gen_redact.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const R = createRequire(import.meta.url)(join(repo, 'desktop/redact.js'));

const config = {
  ...JSON.parse(readFileSync(join(repo, 'engine-ts/baseline/rpc/base_config.json'), 'utf8')),
  accounts: [
    { alias: '模拟', account_id: 'DU7654321', is_paper: true, connection: 'paper', default: true },
    { alias: '主账户', account_id: 'U1234567', is_paper: false, connection: 'live', note: '备注里也写了 U1234567 与 sk-abcdefghijk' },
    { alias: '富途', account_id: '28190044', is_paper: true, connection: 'paper' },
    { alias: '短', account_id: 'X12', is_paper: true },
    { alias: '前缀', account_id: '2819', is_paper: true },
    'not an object', null,
  ],
};
const accounts = R.accountsFromConfig(config);
const bot = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OQ', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789AB'].join('.');
const texts = [
  'order rejected for account U1234567: margin', 'DU7654321 与 U1234567', '富途账户 28190044 解锁失败', 'managedAccounts: U9988776,DU1122334,F5566778',
  'orderId 12345678 strike 7450 expiry 20260928 ref f1234567', 'U12345 U123456789 DU12 I12345 DF1234567 aU1234567 U1234567b _U1234567',
  'key sk-ant-api03-AbCdEf123456_xyz used', 'sk-short sk-12345678', `gateway auth failed with ${bot}`,
  'engine 0.5.1 at services/follow.spec.ts via gateway.discord.gg', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
  'bearer abc.def-ghi_jkl', '{"api_key": "abcdef123456"}', 'x-api-key: 9f8e7d6c5b4a', 'password=hunter2secret&next=1',
  'API-KEY=abcdef, Token: \'zzzzzzzz\'; secret="short" passwd = 1234567', 'apikey:abcdefg authorization=x',
  '"max_tokens": 8000, "keychain_service": "dafri-llm-api-key", "keychain_account": "anthropic"',
  'at foo (/Users/zhangsan/Library/Application Support/x.js:1:1) /Users/zhangsanfeng/x', '[通知] 成交回报 | 账户 模拟 | BUY AAPL 100 @ 230.0000',
  '[engine] ok\n[通知] 下单提醒 | warning | 限价偏离现价 3%\n[engine] next', '[通知]没有竖线的一行', '[通知]　全角空格 | 内容',
  '账号 2819 与 28190044 与 DU7654321X', '', 'aaaaaaaaaaaaaaaaaaaa.bbbb.cccccccccccccccccccc', 'x.y.z 1.2.3',
];
const cases = [];
for (const homedir of ['/Users/zhangsan', '', 'abc']) {
  const redact = R.createRedactor({ accounts, homedir });
  for (const t of texts) cases.push({ fn: 'redact', accounts, homedir, input: t, out: redact(t) });
}
for (const a of ['DU7654321', 'U1234567', '28190044', '12345', '123456', 'ab', '', 'xyZ1234567', '中文账号1234567']) cases.push({ fn: 'maskAccount', input: a, out: R.maskAccount(a) });
cases.push({ fn: 'accountsFromConfig', input: config, out: accounts });
const original = JSON.stringify(config);
cases.push({ fn: 'redactConfig', input: config, out: R.redactConfig(config), homedir: '' });
if (JSON.stringify(config) !== original) throw new Error('redactConfig 改了传进去的那一份');
cases.push({ fn: 'redactConfig', input: null, out: R.redactConfig(null) });
// GitHub 的推送保护按形状认 Discord 机器人令牌,假的也拦:写夹具时把令牌形状里的点写成 \u002e,解析出来的值不变
const hideTokens = (json) => json.replace(/[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g, (m) => m.replaceAll('.', '\\u002e'));
writeFileSync(join(here, 'redact.json'), hideTokens(JSON.stringify({ generator: 'gen_redact.mjs', cases }, null, 1)) + '\n');
console.log(`redact.json: ${cases.length} cases`);
