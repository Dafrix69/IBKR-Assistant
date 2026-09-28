'use strict';
/**
 * 「支持与数据」这一组主进程通道:导出诊断包、打开日志 / 配置 / 备份所在位置、条款同意、从备份恢复交易库。
 * 都是"出了问题的时候"和"第一次用的时候"才走的路,和交易通道分开放,main.js 不至于长成一锅。
 *
 * 规矩和 main.js 的通道一样:每个通道先核对发起方;界面递不进任何路径——要写到哪、要打开哪个目录,
 * 都由这里定,或者由这里弹的系统对话框定。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildReport, buildSummary, defaultFileName } = require('./diagnostics');
const consent = require('./consent');
const storeGuard = require('./store-guard');
const accountsSetup = require('./accounts-setup');

/**
 * @param {object} ctx
 * @param {Electron.IpcMain} ctx.ipcMain
 * @param {Electron.Dialog} ctx.dialog
 * @param {Electron.Shell} ctx.shell
 * @param {Electron.Clipboard} ctx.clipboard
 * @param {Electron.App} ctx.app
 * @param {object} ctx.log                     electron-log
 * @param {string} ctx.configPath
 * @param {() => object | null} ctx.engine      当前的 EngineClient
 * @param {() => Electron.BrowserWindow | null} ctx.window
 * @param {(event: object) => boolean} ctx.isTrustedSender
 * @param {(options: object) => Promise<{ response: number }>} ctx.showBox
 * @param {(title: string, body: string) => boolean} ctx.notify
 * @param {(channel: string, payload: object) => void} ctx.send
 * @param {() => object} ctx.engineFacts         { restarts, lastUpdateCheck }
 * @param {() => void} ctx.markEngineStarted     重启引擎前调,主进程的重启计数据此清零
 * @param {string} [ctx.noticesPath]            随包的第三方许可声明
 */
function registerSupportIpc(ctx) {
  const { ipcMain, dialog, shell, clipboard, app, log } = ctx;
  const userData = () => app.getPath('userData');
  const logFile = () => log.transports.file.getFile().path;
  const guard = (event) => {
    if (!ctx.isTrustedSender(event)) throw new Error('调用来源不受信任');
  };

  /** 问引擎要一样东西;引擎不在、不回话都不该让诊断包导不出来——那正是最需要它的时候。 */
  async function ask(method, errors) {
    const engine = ctx.engine();
    if (!engine || !engine.child) return null;
    try {
      return await engine.call(method, {}, { timeoutMs: 5000 });
    } catch (err) {
      errors.push(`${method}:${String(err && err.message ? err.message : err)}`);
      return null;
    }
  }

  async function collect() {
    const errors = [];
    const engine = ctx.engine();
    const [status, selftest, backups] = await Promise.all([
      ask('system.status', errors), ask('system.selftest', errors), ask('data.backups', errors),
    ]);
    const facts = ctx.engineFacts();
    return {
      app: {
        name: app.getName(),
        version: app.getVersion(),
        packaged: app.isPackaged,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        os: `${os.type()} ${os.release()}`,
        locale: app.getLocale(),
        memory_mb: Math.round(os.totalmem() / 1024 / 1024),
        user_data: userData(),
      },
      configPath: ctx.configPath,
      logPath: logFile(),
      oldLogPath: logFile().replace(/\.log$/, '.old.log'),
      engine: { running: Boolean(engine && engine.child), restarts: facts.restarts, status, selftest, backups, errors },
      extra: { consent: consent.consentState(userData()), last_update_check: facts.lastUpdateCheck || null },
    };
  }

  // ---- 诊断 ------------------------------------------------------------
  ipcMain.handle('diagnostics-export', async (event) => {
    guard(event);
    const win = ctx.window();
    const options = {
      title: '导出诊断信息',
      defaultPath: path.join(app.getPath('downloads'), defaultFileName()),
      filters: [{ name: '文本', extensions: ['txt'] }],
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, buildReport(await collect()), 'utf8');
    log.info('[support] 已导出诊断信息');
    shell.showItemInFolder(result.filePath);
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle('diagnostics-copy', async (event) => {
    guard(event);
    clipboard.writeText(buildSummary(await collect()));
    return { ok: true };
  });

  // ---- 打开所在位置:只认这几个固定的地方 ---------------------------------
  ipcMain.handle('reveal', async (event, kind) => {
    guard(event);
    if (kind === 'logs') {
      shell.showItemInFolder(logFile());
      return { ok: true };
    }
    if (kind === 'config') {
      shell.showItemInFolder(ctx.configPath);
      return { ok: true };
    }
    if (kind === 'notices') {
      if (!ctx.noticesPath || !fs.existsSync(ctx.noticesPath)) {
        throw new Error('这一份是打包时生成的:从源码运行时请先执行 npm run notices(在 desktop 目录下)');
      }
      const failed = await shell.openPath(ctx.noticesPath);
      if (failed) throw new Error(failed);
      return { ok: true };
    }
    if (kind === 'backups') {
      const info = await ask('data.backups', []);
      if (!info) throw new Error('交易引擎没有在运行,读不到备份目录');
      fs.mkdirSync(info.dir, { recursive: true });
      const failed = await shell.openPath(info.dir);
      if (failed) throw new Error(failed);
      return { ok: true };
    }
    throw new Error(`未知的位置:${String(kind)}`);
  });

  // ---- 条款同意 ---------------------------------------------------------
  ipcMain.handle('consent-get', (event) => {
    guard(event);
    return consent.consentState(userData());
  });

  ipcMain.handle('consent-accept', (event, version) => {
    guard(event);
    const state = consent.acceptConsent(userData(), String(version || ''), { appVersion: app.getVersion() });
    log.info(`[consent] 已同意条款 ${state.version}`);
    return state;
  });

  // ---- 账户设置(为什么走这条路、口径见 accounts-setup.js)--------------------
  ipcMain.handle('accounts-info', (event) => {
    guard(event);
    let config = null;
    try {
      config = JSON.parse(fs.readFileSync(ctx.configPath, 'utf8'));
    } catch {
      /* 配置读不出来:两样都给空的 */
    }
    return { placeholders: accountsSetup.placeholderAliases(config), connections: accountsSetup.connectionChoices(config) };
  });

  ipcMain.handle('accounts-change', async (event, change) => {
    guard(event);
    const engine = ctx.engine();
    const plan = accountsSetup.planChange(ctx.configPath, change); // 校验不过在这里就抛,话是给人看的
    const { response } = await ctx.showBox({
      type: 'warning',
      buttons: ['取消', plan.headline === '删除账户' ? '删除' : '保存'],
      defaultId: 0,
      cancelId: 0,
      title: plan.headline,
      message: plan.headline,
      detail: plan.lines.join('\n'),
      noLink: true,
    });
    if (response !== 1) return { ok: false, canceled: true };
    accountsSetup.commitChange(ctx.configPath, plan);
    log.warn(`[accounts] ${plan.headline}:${String(change && change.alias)}`);
    // 配置是引擎启动时读的:重启它,由它把整份配置再验一遍(验不过会走"配置文件有问题"那个对话框,可以恢复)
    if (engine) {
      ctx.markEngineStarted();
      engine.restart().catch(() => {});
    }
    return { ok: true };
  });

  ipcMain.handle('quit-app', (event) => {
    guard(event);
    app.quit(); // before-quit 里会等引擎停稳
  });

  // ---- 从备份恢复交易库 ---------------------------------------------------
  ipcMain.handle('backup-restore', async (event, name) => {
    guard(event);
    const engine = ctx.engine();
    const info = await ask('data.backups', []);
    if (!engine || !info) throw new Error('交易引擎没有在运行,现在不能恢复。请先到「关于」里重启引擎。');
    const target = storeGuard.listBackups(info.db_path).find((b) => b.name === String(name));
    if (!target) throw new Error('找不到这份备份,请刷新备份列表后再试');
    const { response } = await ctx.showBox({
      type: 'warning',
      buttons: ['取消', '恢复这一份'],
      defaultId: 0,
      cancelId: 0,
      title: '从备份恢复交易库',
      message: '用这份备份换掉现在的交易库?',
      detail:
        `备份:${storeGuard.describeBackup(target)}\n\n` +
        '这份备份之后产生的交易记录、成交、追踪设置、想法,在恢复后的库里都没有。\n' +
        '恢复前会先给现在的库再留一份备份,原文件也会改名留在旁边,不会删。\n' +
        '恢复期间交易引擎会重启:持仓追踪停几秒,券商连接会重连。已经挂在券商那边的单不受影响。',
      noLink: true,
    });
    if (response !== 1) return { ok: false, canceled: true };
    // 先给现在的库留一份(能留就留:库已经坏了的话这一步会失败,不挡恢复)
    try {
      await engine.call('data.backup', {}, { timeoutMs: 30_000 });
    } catch (err) {
      log.warn('[backup] 恢复前的备份没有成功', err);
    }
    await engine.stop();
    try {
      const done = storeGuard.restoreBackup(info.db_path, target.name);
      log.warn('[backup] 已从备份恢复交易库', done);
      ctx.notify('交易库已恢复', `已恢复到 ${storeGuard.describeBackup(target)}。原来的库留在旁边,没有删。`);
      return { ok: true, restored: done.restored };
    } finally {
      ctx.markEngineStarted();
      engine.start({ force: true }).catch(() => {});
    }
  });
}

/**
 * 交易库打不开时的那个对话框(引擎用 EXIT_STORE 退出之后)。
 * @returns {Promise<'retry' | 'quit'>}
 */
async function handleStoreFatal(ctx, fatal) {
  const { dialog, shell, log } = ctx;
  const RESTORE = '用最近的备份恢复';
  const REVEAL = '打开数据所在位置';
  const RETRY = '重试';
  const QUIT = '退出';
  const why = {
    newer: '交易库是更新版本的软件写的',
    corrupt: '交易库文件损坏了',
    locked: '交易库被另一个程序占着',
    unwritable: '交易库所在的位置写不进去',
  }[fatal.kind] || '交易库打不开';
  for (;;) {
    const backups = fatal.dbPath ? storeGuard.listBackups(fatal.dbPath) : [];
    // 只有库本身坏了才谈得上恢复:被占着、写不进去、版本太新,换一份库解决不了
    const canRestore = fatal.kind === 'corrupt' && backups.length > 0;
    const buttons = [...(canRestore ? [RESTORE] : []), ...(fatal.dbPath ? [REVEAL] : []), RETRY, QUIT];
    const note = canRestore
      ? `\n\n最近的备份:${storeGuard.describeBackup(backups[0])}(共 ${backups.length} 份)。` +
        '恢复后,这份备份之后的记录不在库里;坏掉的那份会改名留在旁边,不会删。'
      : fatal.kind === 'corrupt'
        ? '\n\n没有找到可以恢复的备份。'
        : '';
    const { response } = await ctx.showBox({
      type: 'error',
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      title: '交易库打不开',
      message: `${why},交易引擎没有启动`,
      detail: `${fatal.message}\n\n${fatal.dbPath ? `文件:${fatal.dbPath}\n` : ''}引擎没有启动期间,持仓追踪的止盈止损不在盯盘。${note}`,
      noLink: true,
    });
    const choice = buttons[response];
    if (choice === REVEAL) {
      shell.showItemInFolder(fatal.dbPath);
      continue;
    }
    if (choice === RESTORE) {
      try {
        const done = storeGuard.restoreBackup(fatal.dbPath, backups[0].name, { aside: 'corrupt' });
        log.warn('[backup] 已从备份恢复交易库(原库打不开)', done);
        ctx.notify('交易库已恢复', `已恢复到 ${storeGuard.describeBackup(backups[0])}。`);
      } catch (err) {
        log.error('[backup] 恢复交易库失败', err);
        dialog.showErrorBox('恢复失败', String(err && err.message ? err.message : err));
        continue;
      }
      return 'retry';
    }
    if (choice === RETRY) return 'retry';
    return 'quit';
  }
}

module.exports = { registerSupportIpc, handleStoreFatal };
