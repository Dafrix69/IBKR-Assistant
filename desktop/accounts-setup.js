'use strict';
/**
 * 账户设置(主进程用):从界面加、改、删账户别名。
 *
 * 在这之前,账户只能手改 settings.json(引擎的 settings.patch 明确拒绝 accounts / connections 两段)。
 * 那条规矩防的是"界面里跑进一段别人的脚本,悄悄把实盘账号标成纸面、或者把别名指到另一个账号上"。
 * 防的东西没有变,但让每个买了软件的人去手改一份 JSON、少一个逗号引擎就起不来,不是卖得出去的样子。
 *
 * 所以这条路不经过引擎的 RPC,由主进程自己走,而且:
 *  · 写之前一定弹原生确认框,框里的每一个字都是主进程对着"将要写进去的内容"写的——账号完整显示、
 *    纸面还是实盘写明、哪一个是默认账户写明。界面递过来的只是表单里的几个值;
 *  · 走 IBKR 的账户,账号不是模拟账号的样子(模拟账号以 D 开头)就不许标成纸面——那是最危险的一种填错:
 *    实盘闸门对它失效。引擎加载配置时还有同样的一道(config.ts 的 livePaperMismatches);
 *  · 连接(host / 端口 / client id)仍然不能从界面改:账户只能挂到配置里已有的连接上;
 *  · 写法和引擎一样:原子写,写之前把改动前那一份留成 .bak。写完重启引擎,由它把整份配置再验一遍。
 *
 * 这里是纯逻辑(好测):校验、算出新配置、拼确认框上的话。弹框、写盘之后重启引擎在 support-ipc.js。
 */
const fs = require('node:fs');

const ALIAS_MAX = 24;
/** 账号的样子:最多三个字母开头,后面 4 到 12 位数字(IBKR 的 U1234567 / DU1234567,富途的纯数字)。 */
const ACCOUNT_ID = /^[A-Za-z]{0,3}\d{4,12}$/;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 配置里**自己有**的那条连接。不用方括号直接取:"__proto__" 这样的名字会从原型上取到东西。 */
function connectionOf(config, name) {
  const conns = isObject(config.connections) ? config.connections : {};
  return Object.hasOwn(conns, name) && isObject(conns[name]) ? conns[name] : null;
}

function brokerOf(config, connection) {
  const conn = connectionOf(config, connection);
  return conn && typeof conn.broker === 'string' ? conn.broker : 'ibkr';
}

const kindOf = (account) => (account.is_paper === true ? '纸面' : '实盘');

/**
 * 校验一次改动,算出改完之后的配置。不碰磁盘。
 *
 * @param {object} config  settings.json 的内容
 * @param {object} change  { action: 'upsert', alias, account_id, is_paper, connection, make_default? }
 *                         | { action: 'remove', alias }
 * @returns {{ config: object, headline: string, lines: string[] }} lines 是确认框上的话
 */
function applyChange(config, change) {
  if (!isObject(config)) throw new Error('配置文件读不出来,先修好它再改账户');
  if (!isObject(change)) throw new Error('没有收到要改的内容');
  const accounts = Array.isArray(config.accounts) ? config.accounts.filter(isObject).map((a) => ({ ...a })) : [];
  const alias = String(change.alias ?? '').trim();
  if (!alias) throw new Error('别名不能空着');
  if ([...alias].length > ALIAS_MAX) throw new Error(`别名太长了(最多 ${ALIAS_MAX} 个字)`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f"\\]/.test(alias)) throw new Error('别名里不能有引号、反斜杠与控制字符');
  if (alias.toUpperCase() === 'DEFAULT') throw new Error('DEFAULT 是保留字(指默认账户),换一个别名');
  const index = accounts.findIndex((a) => String(a.alias) === alias);

  if (change.action === 'remove') {
    if (index < 0) throw new Error(`没有叫「${alias}」的账户`);
    const [removed] = accounts.splice(index, 1);
    const lines = [`删除账户「${alias}」(${String(removed.account_id)},${kindOf(removed)})`];
    if (removed.default === true && accounts.length) {
      accounts[0].default = true;
      lines.push(`它原来是默认账户:默认账户改成「${String(accounts[0].alias)}」`);
    }
    if (!accounts.length) lines.push('删掉之后配置里一个账户都没有了:解析得了指令,但发不了单');
    lines.push('', '只改本机的配置,不影响券商那边的账户与持仓。用这个别名建的追踪会失效。');
    return { config: { ...config, accounts }, headline: '删除账户', lines };
  }

  if (change.action !== 'upsert') throw new Error(`不认识的操作:${String(change.action)}`);
  const accountId = String(change.account_id ?? '').trim();
  if (!ACCOUNT_ID.test(accountId)) {
    throw new Error('账号的格式不对:IBKR 是 U 或 DU 开头加数字(在 TWS 右上角、账户窗口里看得到),富途是纯数字');
  }
  if (typeof change.is_paper !== 'boolean') throw new Error('要选清楚这是纸面账户还是实盘账户');
  const connection = String(change.connection ?? '').trim();
  const conn = connectionOf(config, connection);
  if (conn === null) throw new Error(`配置里没有叫「${connection}」的连接`);
  const broker = brokerOf(config, connection);
  if (broker === 'ibkr' && change.is_paper && !/^D/i.test(accountId)) {
    throw new Error('这个账号不是 IBKR 模拟账号的样子(模拟账号以 D 开头,如 DU1234567),不能标成纸面——标错了,实盘闸门对它就不起作用');
  }
  const clash = accounts.find((a, i) => i !== index && String(a.account_id) === accountId);
  if (clash) throw new Error(`这个账号已经配给了别名「${String(clash.alias)}」`);

  const before = index >= 0 ? accounts[index] : null;
  const makeDefault = change.make_default === true || (before ? before.default === true : accounts.length === 0);
  const next = { alias, account_id: accountId, is_paper: change.is_paper, connection, ...(makeDefault ? { default: true } : {}) };
  if (makeDefault) for (const a of accounts) delete a.default;
  if (index >= 0) accounts[index] = next;
  else accounts.push(next);

  const lines = [
    `别名:${alias}`,
    `账号:${accountId}`,
    `类别:${kindOf(next)}账户${next.is_paper ? '' : '(发到它的订单会用真钱成交,要过「允许实盘账户下单」这道闸)'}`,
    `连接:${connection}(${broker === 'futu' ? '富途 OpenD' : 'IBKR'},端口 ${String(conn.port ?? '?')})`,
    `默认账户:${makeDefault ? '是' : '否'}`,
  ];
  if (before) {
    lines.push('', `原来是:${String(before.account_id)},${kindOf(before)},连接 ${String(before.connection ?? '')}`);
    if (before.is_paper !== true && next.is_paper) lines.push('注意:这个别名从实盘改成了纸面。');
  }
  lines.push('', '保存后交易引擎会重启(几秒钟),券商连接会重连。请核对账号与 TWS 里显示的一致。');
  return { config: { ...config, accounts }, headline: before ? '修改账户' : '添加账户', lines };
}

function writeAtomic(target, text) {
  const tmp = `${target}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.writeFileSync(target, text, 'utf8');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (!fs.existsSync(target)) throw err;
  }
}

/** 读配置 → 校验 → 算出新配置与确认框上的话。不写盘。 */
function planChange(configPath, change) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new Error(`配置文件读不了:${err.message}`, { cause: err });
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (err) {
    throw new Error(`配置文件不是合法的 JSON,先修好它再改账户:${err.message}`, { cause: err });
  }
  return { before: text, ...applyChange(config, change) };
}

/** 把 planChange 算出来的新配置写下去:改动前那一份留成 .bak。 */
function commitChange(configPath, plan) {
  try {
    writeAtomic(`${configPath}.bak`, plan.before);
  } catch {
    /* 备份写不进去不挡保存 */
  }
  writeAtomic(configPath, JSON.stringify(plan.config, null, 2));
}

/** 配置里还是示例占位的那些账户(账号是全零的)。首次启动的就绪清单据此提醒"还没配账户"。 */
function placeholderAliases(config) {
  const accounts = isObject(config) && Array.isArray(config.accounts) ? config.accounts.filter(isObject) : [];
  return accounts.filter((a) => /^[A-Za-z]*0+$/.test(String(a.account_id ?? ''))).map((a) => String(a.alias));
}

/** 配置里有哪些连接可选(名字、哪家券商、端口)。给表单的下拉框用;host 不给,它只会是本机。 */
function connectionChoices(config) {
  const conns = isObject(config) && isObject(config.connections) ? config.connections : {};
  return Object.entries(conns).filter(([, c]) => isObject(c)).map(([name, c]) => ({
    name, broker: typeof c.broker === 'string' ? c.broker : 'ibkr', port: Number(c.port) || null,
  }));
}

module.exports = { ALIAS_MAX, applyChange, planChange, commitChange, placeholderAliases, connectionChoices };
