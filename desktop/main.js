'use strict';
/**
 * Electron 主进程(设计文档 §10.1 / §10.2)。
 *
 * 安全基线在这里落地,不靠约定:
 *   * BrowserWindow 三件套 contextIsolation / nodeIntegration / sandbox;
 *   * renderer 只能通过 preload 白名单调用,方法名不在表里直接拒绝;
 *   * 每次 IPC 都校验发起方,防止任何被注入的 frame 借道下单;
 *   * 不加载任何远程页面,导航与开新窗口一律拦掉;
 *   * 生产构建关掉 DevTools。
 */
const { app, BrowserWindow, Menu, Notification, ipcMain, dialog, shell, session, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { EngineClient } = require('./rpc-client');

const DEV = process.env.DAFRI_DEV === '1';
const PACKAGED = app.isPackaged;
// 打包后引擎源码在 resources/engine(见 package.json extraResources);开发时就是仓库根
const REPO_ROOT = PACKAGED
  ? path.join(process.resourcesPath, 'engine')
  : path.resolve(__dirname, '..');
// TS 引擎(重写版):有 dist 就优先用它——不需要 Python、不需要首启引导。
// DAFRI_ENGINE=python 可强制回退到 Python 引擎。
const TS_ENGINE_ROOT = PACKAGED
  ? path.join(process.resourcesPath, 'engine-ts')
  : path.resolve(__dirname, '..', 'engine-ts');
// TS 引擎在打包布局下找不到仓库根 prompts/ 的相对位置,用环境变量显式指过去
if (PACKAGED && !process.env.DAFRI_PROMPT_DIR) {
  process.env.DAFRI_PROMPT_DIR = path.join(process.resourcesPath, 'engine', 'prompts');
}
// 打包后配置放 userData(应用包只读);开发时沿用仓库里的 config/
const CONFIG_PATH =
  process.env.DAFRI_CONFIG ||
  (PACKAGED
    ? path.join(app.getPath('userData'), 'settings.json')
    : path.join(REPO_ROOT, 'config', 'settings.json'));
const RENDERER_INDEX = path.join(__dirname, 'renderer', 'index.html');

/** renderer 允许调用的引擎方法。不在表里的一律拒绝,新增方法必须显式登记。 */
const ALLOWED_RPC = new Set([
  'system.status',
  'system.selftest',
  'instruction.submit',
  'records.list',
  'records.get',
  'pending.list',
  'pending.poll',
  'breaker.state',
  'breaker.halt',
  'breaker.resume',
  'broker.catalog',
  'broker.select',
  'broker.connect',
  'broker.disconnect',
  'tws.scan',
  'tws.diagnose',
  'tws.launch',
  'futu.scan',
  'futu.diagnose',
  'futu.launch',
  'futu.unlock',
  'futu.set_password',
  'llm.catalog',
  'llm.patch',
  'llm.test',
  'settings.get',
  'settings.patch',
  'ideas.add',
  'ideas.list',
  'ideas.update',
  'ideas.analyze',
  'ideas.digest',
  'ideas.digests',
  'sectors.list',
  'sectors.add',
  'sectors.delete',
  'sectors.pick',
  'sectors.quotes',
  'sectors.add_stock',
  'sectors.remove_stock',
  'backtest.strategies',
  'backtest.run',
  'backtest.parse_rules',
  'book.snapshot',
  'options.wall',
  'alerts.list',
  'alerts.create',
  'alerts.delete',
  'alerts.refresh',
  'alerts.poll',
  'pa.timeframes',
  'pa.analyze',
  'pa.comment',
  'macro.board',
  'positions.list', 'review.candidates', 'review.analyze',
  'tracker.list',
  'tracker.add',
  'tracker.update',
  'tracker.delete',
  'tracker.poll',
  'tracker.close_now',
  'keychain.set',
  'data.export',
]);

/** 会真的动钱或动配置的通道,额外要求界面已经确认过一次。 */
const SENSITIVE_RPC = new Set([
  'instruction.submit',
  'settings.patch',
  'broker.connect',
  'keychain.set',
  'tws.launch', // 会拉起外部程序,同样要求界面确认过
  'llm.patch',
  'broker.select', // 换券商 = 换下单出口,必须是界面上的明确动作
  'futu.launch', // 同 tws.launch:会拉起外部程序
  'futu.unlock', // 解锁之后实盘单才发得出去
  'futu.set_password', // 写 Keychain
  'tracker.add', // 设的是"到价自动发单"的授权,不是一条备忘
  'tracker.update',
  'tracker.close_now', // 直接发平仓单
]);

let mainWindow = null;
let engine = null;

/**
 * Windows 标题栏叠加层的配色。必须跟着深浅色走:浅色主题下画白色的关闭按钮
 * 就是一片看不见的空白。
 */
function titleBarOverlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: dark ? '#1e1e20' : '#f2f2f4',
    symbolColor: dark ? '#ffffff' : '#1d1d1f',
    height: 52,            // 和 .topbar 的高度对齐,否则按钮不在栏的正中
  };
}

/** 主题变了要重画一次叠加层,不然按钮颜色会留在上一个主题里。 */
function syncTitleBarOverlay() {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setTitleBarOverlay(titleBarOverlay());
  } catch {
    /* 老版本 Windows 不支持叠加层,忽略即可——顶栏照常显示 */
  }
}

// 跟随系统外观时,是系统在变而不是用户在点,所以也得挂上这个事件
nativeTheme.on('updated', syncTitleBarOverlay);

function ensureConfigExists() {
  if (fs.existsSync(CONFIG_PATH)) return { created: false };
  const example = PACKAGED
    ? path.join(REPO_ROOT, 'settings.example.json')
    : path.join(REPO_ROOT, 'config', 'settings.example.json');
  if (!fs.existsSync(example)) return { created: false, missing: true };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.copyFileSync(example, CONFIG_PATH);
  return { created: true };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,             // 1000 以下侧栏收成图标栏,内容区仍有 840 以上
    minHeight: 700,
    title: 'Dafri Trading',
    // 透明底 + 材质:让 macOS 的模糊背景透出来(不透明背景会把 vibrancy 盖掉)
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#f5f5f7',
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: 'active',
    // macOS 用 hiddenInset(红绿灯浮在内容上);Windows 用 hidden + 叠加层,
    // 把系统的最小化/最大化/关闭按钮直接画在我们自己的顶栏右侧——现代 Windows
    // 应用(VS Code、Teams、Edge)都是这么做的,省下一整条原生标题栏的高度,
    // 也不会出现"应用有两条栏"的割裂感。
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'win32' ? { titleBarOverlay: titleBarOverlay() } : {}),
    trafficLightPosition: { x: 14, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      // 托管单的秒级调整循环跑在 renderer:窗口最小化时不能被节流
      backgroundThrottling: false,
      devTools: DEV,
    },
  });

  mainWindow.loadFile(RENDERER_INDEX);

  // UI 全部是本地资源,任何导航或新窗口都是异常,一律拦掉并交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (DEV) {
    // 开发时把渲染进程的 console 转到终端,省得为看一条报错去开 DevTools
    mainWindow.webContents.on('console-message', (event) => {
      const level = event.level ?? 'log';
      console.log(`[renderer:${level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
  }

  // 焦点状态转给渲染层:窗口失焦时侧栏选中项退灰,这是 AppKit 源列表的标准表现
  mainWindow.on('focus', () => send('window', { focused: true }));
  mainWindow.on('blur', () => send('window', { focused: false }));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' }]
      : []),
    {
      label: '交易',
      submenu: [
        {
          label: '暂停全部自动执行(熔断)',
          accelerator: 'CommandOrControl+Shift+H',
          click: () => haltFromMenu(),
        },
        { type: 'separator' },
        {
          label: '刷新状态',
          accelerator: 'CommandOrControl+R',
          click: () => send('menu', { action: 'refresh' }),
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(DEV ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function haltFromMenu() {
  try {
    const result = await engine.call('breaker.halt', { reason: '菜单/快捷键触发熔断' });
    send('engine-event', { event: 'breaker', data: result });
  } catch (err) {
    send('engine-event', { event: 'error', data: { message: err.message } });
  }
}

function send(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try {
    mainWindow.webContents.send(channel, payload);
  } catch {
    // 退出过程中 frame 可能已经销毁,引擎的收尾事件到得比窗口关闭晚
  }
}

/** 只接受来自我们自己主窗口主 frame 的调用。 */
function isTrustedSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (event.sender !== mainWindow.webContents) return false;
  const frame = event.senderFrame;
  if (frame && frame.parent) return false; // 子 frame 不许下单
  const url = event.sender.getURL();
  return url.startsWith('file://') && url.includes('renderer/index.html');
}

function wireEngine() {
  engine = new EngineClient({
    repoRoot: REPO_ROOT,
    configPath: CONFIG_PATH,
    userDataDir: app.getPath('userData'),
    packaged: PACKAGED,
    appVersion: app.getVersion(),
    tsEngineRoot: TS_ENGINE_ROOT,
  });
  engine.on('engine-event', (payload) => send('engine-event', payload));
  engine.on('log', (line) => send('engine-log', { line }));
  engine.on('exit', (info) => send('engine-exit', info));
  engine.on('bootstrap', (info) => send('bootstrap', { message: info.message }));
  // 首次启动可能要建 venv 装依赖,失败会以 engine-exit 事件呈现在界面上
  engine.start().catch(() => {});
}

function registerIpc() {
  ipcMain.handle('rpc', async (event, { method, params }) => {
    if (!isTrustedSender(event)) {
      throw new Error('调用来源不受信任,已拒绝');
    }
    if (typeof method !== 'string' || !ALLOWED_RPC.has(method)) {
      throw new Error(`方法不在白名单中:${method}`);
    }
    if (SENSITIVE_RPC.has(method) && (!params || params.__confirmed !== true)) {
      throw new Error('敏感操作缺少界面确认标记,已拒绝');
    }
    const clean = { ...(params || {}) };
    delete clean.__confirmed;
    return engine.call(method, clean);
  });

  // 外观:走 nativeTheme,渲染层的 prefers-color-scheme 与窗口底色一起切换
  ipcMain.handle('set-theme', (event, mode) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    if (!['system', 'light', 'dark'].includes(mode)) throw new Error(`未知外观模式:${mode}`);
    nativeTheme.themeSource = mode;
    syncTitleBarOverlay();
    return { mode, dark: nativeTheme.shouldUseDarkColors };
  });

  ipcMain.handle('app-info', async (event) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      configPath: CONFIG_PATH,
      repoRoot: REPO_ROOT,
      dev: DEV,
      engineRunning: Boolean(engine && engine.child),
    };
  });

  ipcMain.handle('engine-restart', async (event) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    engine.stop();
    engine.start().catch(() => {});
    return { ok: true };
  });

  // 装富途 SDK。名字由主进程写死,渲染进程只能触发、不能指定装什么——
  // 否则就等于给了界面一个"pip install 任意包"的通道。
  ipcMain.handle('engine-install-futu', async (event) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    const result = await engine.installExtra('futu');
    // import 在进程启动时解析,装完必须重启引擎才认得这个包
    engine.stop();
    engine.start().catch(() => {});
    return result;
  });

  ipcMain.handle('pick-export-path', async (event) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出全部交易数据',
      defaultPath: path.join(app.getPath('downloads'), 'dafri-trades.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    return result.canceled ? null : result.filePath;
  });

  // 系统通知。引擎侧的 notify.py 只在 macOS 上真的弹通知(其余平台只打印到
  // stderr),而价位警告在 Windows 上必须能弹出来——所以由主进程补这一条。
  ipcMain.handle('notify', (event, payload) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    const { title, body } = payload || {};
    if (typeof title !== 'string' || typeof body !== 'string') {
      throw new Error('通知内容不合法');
    }
    if (!Notification.isSupported()) return { shown: false };
    // 截断:通知内容来自行情与用户填的标的,不该由它决定弹窗多大
    new Notification({ title: title.slice(0, 120), body: body.slice(0, 300) }).show();
    return { shown: true };
  });

  ipcMain.handle('confirm', async (event, { title, message, detail, confirmLabel }) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['取消', confirmLabel || '确认'],
      defaultId: 0,
      cancelId: 0,
      title: String(title || '确认'),
      message: String(message || ''),
      detail: detail ? String(detail) : undefined,
      noLink: true,
    });
    return response === 1;
  });
}


/**
 * macOS:直接从挂载的 DMG 里双击运行时,提出把应用复制到 /Applications。
 * 这一步就是我们的"安装器":复制→打开新副本→退出 DMG 里这份。
 * 已存在旧版则先删旧版(此时旧版必然没在运行,否则单实例锁早把本进程挡下了)。
 */
async function offerMoveToApplications() {
  if (process.platform !== 'darwin' || !PACKAGED) return false;
  if (process.env.DAFRI_SKIP_MOVE === '1') return false;
  const bundle = path.resolve(process.execPath, '..', '..', '..'); // .../Dafri Trading.app
  // 判断"从 DMG 运行"不能只看 /Volumes/ 前缀(挂载点可以是任意路径)。
  // 可靠信号:应用包所在卷不可写(UDZO 镜像只读)或被 Gatekeeper 挪进了随机路径。
  const translocated = bundle.includes('/AppTranslocation/');
  let readonly = false;
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
  } catch {
    readonly = true;
  }
  if (!readonly && !translocated) return false;

  const target = path.join('/Applications', path.basename(bundle));
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['移动到「应用程序」并打开', '暂不,直接运行'],
    defaultId: 0,
    cancelId: 1,
    message: '要把 Dafri Trading 移到「应用程序」文件夹吗?',
    detail: fs.existsSync(target)
      ? '检测到「应用程序」里已有一个版本,将用当前版本替换它。'
      : '从磁盘映像直接运行无法保存更新,建议移动后再使用。',
    noLink: true,
  });
  if (response !== 0) return false;

  const { spawnSync } = require('node:child_process');
  if (fs.existsSync(target)) {
    const rm = spawnSync('rm', ['-rf', target]);
    if (rm.status !== 0) {
      dialog.showErrorBox(
        '无法替换旧版本',
        '删除旧版失败:' + String(rm.stderr || '') +
          '\n若旧版正在运行请先退出;或手动把旧版拖到废纸篓后重试。'
      );
      return false;
    }
  }
  const cp = spawnSync('cp', ['-R', bundle, target]);
  if (cp.status !== 0) {
    dialog.showErrorBox('复制失败', String(cp.stderr || 'cp 退出码 ' + cp.status));
    return false;
  }
  // 去掉隔离属性,免得新副本又被 Gatekeeper 拦一次(仅限用户已确认打开的这份)
  spawnSync('xattr', ['-dr', 'com.apple.quarantine', target]);
  const { spawn } = require('node:child_process');
  spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
  return true;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // 另一个副本尝试启动却被本实例的锁挡下。若它来自不同路径,几乎必是
    // 用户在装新版本——静默吞掉会让用户以为"新版装不上/打不开"。
    const incoming = (argv || []).find((a) => a && !a.startsWith('-')) || '';
    const self = process.execPath;
    if (PACKAGED && incoming && path.resolve(incoming) !== path.resolve(self)) {
      dialog
        .showMessageBox(mainWindow, {
          type: 'info',
          buttons: ['退出此版本', '取消'],
          defaultId: 0,
          cancelId: 1,
          message: '检测到另一个 Dafri Trading 正在尝试启动',
          detail:
            '可能你正在安装/打开新版本。同一时间只能运行一个实例——' +
            '点「退出此版本」后再打开新版本即可完成替换。',
          noLink: true,
        })
        .then(({ response }) => {
          if (response === 0) app.quit();
        });
      send('engine-event', {
        event: 'notification',
        data: { title: '检测到另一个副本尝试启动', subtitle: 'install', body: '如在升级,请先退出本版本' },
      });
    }
  });

  app.whenReady().then(async () => {
    if (await offerMoveToApplications()) return; // 已复制并打开新副本,本进程退出
    // 严格 CSP:不允许任何远程资源、不允许 eval
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'",
          ],
        },
      });
    });
    // 界面不需要任何系统权限
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    const bootstrap = ensureConfigExists();
    registerIpc();
    wireEngine();
    createWindow();
    buildMenu();
    if (bootstrap.created) {
      send('bootstrap', { message: '已从示例创建 config/settings.json,请先在设置里核对账户与限额。' });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (engine) engine.stop();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (engine) engine.stop();
  });
}
