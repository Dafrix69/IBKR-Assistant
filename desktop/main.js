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
const {
  app, BrowserWindow, Menu, Notification, ipcMain, dialog, shell, session, nativeTheme, powerSaveBlocker, powerMonitor, screen, net,
  clipboard, nativeImage,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const log = require('electron-log/main');
const { EngineClient } = require('./rpc-client');
const { PopupManager } = require('./popup-window');
const { checkForUpdate } = require('./update-check');
const configGuard = require('./config-guard');
const storeGuard = require('./store-guard');
const consent = require('./consent');
const { GrantBook, PURPOSES, requiredGrants, loosenedLimits, normalizeBinding } = require('./confirm-grants');
const { createRedactor, accountsFromConfig } = require('./redact');
const { registerSupportIpc, handleStoreFatal } = require('./support-ipc');
const { PowerWatch } = require('./power-watch');

// 2026-09-17 产品改名 Dafri Trading → IBKR-Assistant。userData 目录是按产品名取的:不处理的话,老用户升级后
// 配置、交易库、日志全都"不见了"(其实还躺在旧目录里)。旧目录在、新目录还没建过,就继续用旧的。
if (app.isPackaged) {
  const legacyUserData = path.join(app.getPath('appData'), 'Dafri Trading');
  if (fs.existsSync(legacyUserData) && !fs.existsSync(path.join(app.getPath('userData'), 'settings.json'))) {
    app.setPath('userData', legacyUserData);
  }
}

// 日志落盘(electron-log)。Windows 上 Electron 是 GUI 子系统:没有控制台,stderr 也重定向不出来——
// 出了问题只能靠用户描述。现在主进程、引擎 stderr、渲染层报错、未捕获异常都写进一份滚动日志
// (userData/logs/main.log,单份 4 MB、留一份旧的),「关于」页显示路径,用户把它发过来就有现场。
// 交易数据不进日志:这里只记引擎自己打到 stderr 的运行信息与异常,记录本身在 append-only SQLite 里。
log.initialize();
log.transports.file.level = 'info';
log.transports.file.maxSize = 4 * 1024 * 1024;
log.transports.console.level = process.env.DAFRI_DEV === '1' && !app.isPackaged ? 'debug' : false;
log.errorHandler.startCatching({ showDialog: false });
Object.assign(console, log.functions); // 主进程里已有的 console.* 一并落盘

// 落盘之前先脱敏(redact.js):账号、API Key、家目录里的用户名。进日志的不只是引擎自己打的那些已经打过码的行,
// 还有券商回的错误原文、调用栈、渲染层的控制台报错——用户会把这份日志发给别人
let redact = createRedactor();
log.hooks.push((message) => {
  message.data = message.data.map((item) => {
    if (typeof item === 'string') return redact(item);
    if (item instanceof Error) return redact(item.stack || item.message);
    if (item && typeof item === 'object') {
      try {
        return redact(JSON.stringify(item));
      } catch {
        return '[写不进日志的对象]';
      }
    }
    return item;
  });
  return message;
});

const PACKAGED = app.isPackaged;
// 开发态只认源码运行:装好的应用带着 DAFRI_DEV=1 启动也不开 DevTools——那等于给本机任何进程留一扇
// 能直接调 window.dafri(下单桥)的门
const DEV = process.env.DAFRI_DEV === '1' && !PACKAGED;
// 打包后引擎源码在 resources/engine(见 package.json extraResources);开发时就是仓库根
const REPO_ROOT = PACKAGED
  ? path.join(process.resourcesPath, 'engine')
  : path.resolve(__dirname, '..');
// 交易引擎:engine-ts 编译出的 dist(开发时 tools/ensure_engine_ts.js 保证它新鲜;打包版在 resources/engine-ts)
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
// 界面:renderer-react/dist(Vite 构建产物;npm start 的 prestart 会先构建)。
// Ant Design 用 CSS-in-JS 注入样式,构建期生成的 nonce 要拼进响应头的 CSP,与页面里的 meta 一致。
const REACT_DIST = path.join(__dirname, 'renderer-react', 'dist');
const RENDERER_INDEX = path.join(REACT_DIST, 'index.html');
// 每次发响应头时现读:开发时 ui:build / ui:watch 会重建出新的 nonce,启动时读死那一份的话,
// 重载之后页面里的 <style nonce=新> 满足 meta 却不满足响应头,整套 AntD 样式被静默拦掉,界面变成无样式骨架。
function styleNonce() {
  try {
    return fs.readFileSync(path.join(REACT_DIST, 'csp-nonce.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}
if (!fs.existsSync(RENDERER_INDEX)) {
  console.error('界面产物不存在:先运行 npm run ui:build(或直接 npm start,它会自动构建)。');
}
// 第三方许可声明:打包时生成(tools/gen_notices.js),随包放在 resources 里;从源码运行时在 build/ 下
const NOTICES_PATH = PACKAGED
  ? path.join(process.resourcesPath, 'THIRD-PARTY-NOTICES.txt')
  : path.join(__dirname, 'build', 'THIRD-PARTY-NOTICES.txt');

/** 引擎自己的版本号(engine-ts/package.json)。和应用版本是两个数:引擎可以单独改。 */
function engineVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(TS_ENGINE_ROOT, 'package.json'), 'utf8')).version || '');
  } catch {
    return '';
  }
}

/** 按配置里现在写着的账号重建脱敏器。配置读不出来就只剩"按样子抹"的那一道。 */
function refreshRedactor() {
  let accounts = [];
  try {
    accounts = accountsFromConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    /* 配置还没建、或者坏了 */
  }
  redact = createRedactor({ accounts });
}

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
  'ideas.search',
  'ideas.similar_trades',
  'sectors.list',
  'sectors.add',
  'sectors.delete',
  'sectors.pick',
  'sectors.quotes',
  'sectors.add_stock',
  'sectors.remove_stock',
  'sectors.set_tag',
  // 股票池开关:一只股身上的「盯价位 / 盯异动」。只增删本地监控清单的行,不动钱、不下单,
  // 所以和 quality.* 一样不进 SENSITIVE_RPC
  'pool.set_watch',
  'screener.rs',
  'screener.inflection',
  'screener.deviation',
  'screener.leaders',
  'backtest.strategies',
  'backtest.run',
  'backtest.sweep',
  'backtest.parse_rules',
  'book.snapshot',
  'options.wall',
  'options.fly_plan',
  'options.iv_recorder',
  'options.iv_recorder_set',
  'alerts.list',
  'alerts.create',
  'alerts.delete',
  'alerts.refresh',
  'alerts.poll',
  'alerts.set_touch_config',
  'pa.timeframes',
  'pa.analyze',
  'pa.comment',
  'macro.board',
  'positions.list', 'review.candidates', 'review.analyze', 'review.performance', 'review.signals',
  'tracker.list',
  'tracker.add',
  'tracker.update',
  'tracker.delete',
  'tracker.poll',
  // 券商托管对账:界面按秒驱动,动态停损价的秒级调整走这条路。漏了它,托管单永远挂不出去
  'tracker.reconcile',
  'tracker.close_now',
  // 标的目标价的只读试算:「同意价格后发单」那个价就是它算的。漏了它,界面上的试算
  // 永远报「不在白名单」,确认框里也就没有价可同意(2026-09-10 真机才暴露,mock 桥测不出来)
  'tracker.target_preview',
  // 优质股追踪:读行情 + 存本地清单与阈值,只提醒、不下单,所以都不进 SENSITIVE_RPC
  'quality.list',
  'quality.add',
  'quality.update',
  'quality.remove',
  'quality.set_config',
  'keychain.set',
  'data.export',
  // 交易库的备份:清单只读;出一份备份是往备份目录里多写一个文件,不动库、不动钱。
  // 恢复不在这里——那要停引擎、换库文件,是主进程自己的通道(support-ipc.js 的 backup-restore)
  'data.backups',
  'data.backup',
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

/**
 * 超时不等于没发生的调用。引擎的交易道是严格顺序的、不能取消:120 秒没回话时,这张单可能还排在后面、
 * 过一会儿照样发出去。对这几个方法,超时报的是「结果未知」而不是「失败」,引擎迟到的回执到了再补一条通知
 * (rpc-client.js 的 late-reply)——以前界面显示「调用失败」,人顺手重发,第一张随后才到券商。
 */
const OUTCOME_UNKNOWN_RPC = new Set([
  'instruction.submit',
  'tracker.add',
  'tracker.update',
  'tracker.close_now',
]);
const OUTCOME_LABEL = {
  'instruction.submit': '发送指令',
  'tracker.add': '建立追踪',
  'tracker.update': '修改追踪',
  'tracker.close_now': '立即平仓',
};

/** 界面只许打开这几个站点的 https 链接(发布页、图表库署名)。别的一律不开:链接文本来自哪里都一样。 */
const EXTERNAL_HOSTS = new Set(['github.com', 'www.tradingview.com']);

function openExternalIfAllowed(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.hostname)) {
      shell.openExternal(u.toString());
      return true;
    }
  } catch {
    /* 不是 URL */
  }
  log.warn('[shell] 拒绝打开外部链接', String(url).slice(0, 200));
  return false;
}

let mainWindow = null;
let engine = null;
// 正在退出应用:这时引擎退出是我们让它退的,不拉起;macOS 上也靠它区分"关窗 = 藏起来"与"真退出"
let quitting = false;
// macOS 关窗后提示一次"还在后台跑"。每次启动只提示一次,不然每按一次 ⌘W 都弹一条通知
let hiddenHintShown = false;
// 引擎意外退出后的自动拉起:退避 3 s → 6 s → … 封顶 60 s;稳定跑过 5 分钟就清零
let engineRestarts = 0;
let engineStartedAt = 0;
// 最近一次成功的新版本检查(见 update-check 通道)
let updateCache = null;
// 主窗口渲染进程最近几次崩溃的时刻:一分钟内崩到第四次就不再自动重载,免得死循环
let rendererCrashes = [];
// 「导出全部交易数据」刚在保存对话框里选的路径。data.export 只许写到它,用一次就作废(见 rpc 通道)
let pickedExportPath = null;
// 确认凭据:会发单 / 授权发单 / 打开闸门的调用,要有主进程原生确认框发出的一次性凭据才放行(confirm-grants.js)
const grants = new GrantBook();
// 异动 / 价位提醒的置顶弹窗。懒创建:第一条提醒来了才开窗,平时不占一个渲染进程
const popup = new PopupManager({
  dev: DEV,
  getMainWindow: () => mainWindow,
  sendToMain: (channel, payload) => send(channel, payload),
});

/**
 * Windows 标题栏叠加层的配色。必须跟着深浅色走:浅色主题下画白色的关闭按钮
 * 就是一片看不见的空白。
 */
function titleBarOverlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: '#00000000',    // 透明:顶栏是透明的拖拽区,系统按钮直接落在窗口底(环境色)上
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
nativeTheme.on('updated', () => {
  syncTitleBarOverlay();
  popup.syncTheme();
});

function ensureConfigExists() {
  if (fs.existsSync(CONFIG_PATH)) return { created: false };
  const example = PACKAGED
    ? path.join(REPO_ROOT, 'settings.example.json')
    : path.join(REPO_ROOT, 'config', 'settings.example.json');
  if (!fs.existsSync(example)) return { created: false, missing: true };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.copyFileSync(example, CONFIG_PATH);
  if (PACKAGED && process.platform === 'win32') {
    // 示例里的库路径是 macOS 的样子(~/Library/Application Support/…),照搬到 Windows 上,交易库会落在
    // C:\Users\<人>\Library\… 这种没人想得到去找的地方。只在**新建配置的这一刻**改:已有的配置不动,
    // 库在哪儿还在哪儿
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      config.storage = { ...(config.storage || {}), db_path: path.join(app.getPath('userData'), 'data', 'trades.db') };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch (err) {
      log.warn('[boot] 没能把交易库的位置改到应用数据目录,沿用示例里的', err);
    }
  }
  return { created: true };
}

// 窗口的位置与大小:下次打开回到上次的地方(Mac 应用的惯例,Windows 上一样受用)。
// 显示器可能拔掉了、分辨率可能变了:记下的位置已经不在任何一块屏上,就退回默认居中——不然窗口开在屏幕外面找不回来。
function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    const { x, y, width, height } = saved || {};
    if (![x, y, width, height].every(Number.isFinite)) return {};
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
      x < a.x + a.width - 80 && x + width > a.x + 80 && y >= a.y - 20 && y < a.y + a.height - 60);
    if (!onScreen) return {};
    return { x, y, width, height, maximized: saved.maximized === true };
  } catch {
    return {}; // 第一次打开,或文件坏了
  }
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // getNormalBounds:最大化、全屏时拿到的也是还原后的那一个框
    const bounds = mainWindow.getNormalBounds();
    fs.writeFileSync(windowStatePath(), JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() }));
  } catch {
    /* 写不进去就下次居中打开,不值得为它打断关窗 */
  }
}

/** 焦点与全屏状态转给渲染层。失焦时侧栏选中项退灰(AppKit 源列表的标准表现);全屏时没有红绿灯,工具栏不用给它留位。 */
function sendWindowState(patch = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  send('window', { focused: mainWindow.isFocused(), fullscreen: mainWindow.isFullScreen(), ...patch });
}

/** 把主窗口叫回前台:Dock、菜单、第二个实例都走这里。窗口已销毁(只会在退出途中)时返回 false。 */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  return true;
}

/** 菜单里的跳页:先把窗口叫出来,再走和弹窗「查看」同一条 menu 通道(界面只认侧栏里真有的页)。 */
function navigateFromMenu(page) {
  showMainWindow();
  send('menu', { action: 'navigate', page });
}

/**
 * macOS:关窗(红灯 / ⌘W)只把窗口藏起来,应用留在 Dock 里。这是 Mac 的惯例,在这里更是保护:
 * 盯盘与托管单的秒级节拍在引擎里,但价位提醒、异动弹窗的轮询还跑在这个渲染进程里,窗口一销毁它们就停了;
 * 以前关窗还会经 window-all-closed 把引擎一起停掉,人以为挂着的止损其实没人盯,再点 Dock 回来也不会自动恢复。
 */
function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 全屏的窗口直接 hide,它那块全屏空间会留下一整屏黑:先退出全屏,动画走完再藏
  if (mainWindow.isFullScreen()) {
    mainWindow.once('leave-full-screen', () => hideMainWindow());
    mainWindow.setFullScreen(false);
    return;
  }
  mainWindow.hide();
  if (!hiddenHintShown) {
    hiddenHintShown = true;
    notifySystem('IBKR-Assistant 仍在运行', '追踪、提醒与自动执行照常在后台工作。点 Dock 图标打开窗口,⌘Q 退出。');
  }
}

/** 系统通知。截断:内容来自行情与用户填的标的,不该由它决定通知多大。 */
function notifySystem(title, body) {
  if (!Notification.isSupported()) return false;
  new Notification({ title: title.slice(0, 120), body: body.slice(0, 300) }).show();
  return true;
}

/** 睡下、醒来、换电源各记一行日志;用电池又有追踪在本机盯着时提醒一次(判断在 power-watch.js)。
 *  合盖睡着之后盯盘停了多久、哪些追踪没人盯,由引擎醒来后自己说(engine/wakeGuard.ts)。 */
const powerWatch = new PowerWatch();

function applyPower(action) {
  if (action.log) log.info(action.log);
  if (!action.notify) return;
  notifySystem(action.notify.title, action.notify.body);
  send('engine-event', { event: 'notification', data: { title: action.notify.title, subtitle: 'power', body: action.notify.body } });
}

function watchPower() {
  try {
    applyPower(powerWatch.observe({ onBattery: powerMonitor.isOnBatteryPower() }));
    // on-battery 只有 macOS 发;Windows 换到电池靠心跳每 10 秒读一次 isOnBatteryPower(observePower)
    powerMonitor.on('on-battery', () => applyPower(powerWatch.observe({ onBattery: true })));
    powerMonitor.on('on-ac', () => applyPower(powerWatch.observe({ onBattery: false })));
    powerMonitor.on('suspend', () => applyPower(powerWatch.suspend(Date.now())));
    powerMonitor.on('resume', () => applyPower(powerWatch.resume(Date.now())));
  } catch (err) {
    log.warn('[power] 监听电源事件失败', err);
  }
}

/** 心跳每一问之后:在盯的追踪条数(没连券商时本来就没在盯,按 0)与此刻是不是电池。 */
function observePower(status) {
  const loop = status && status.broker_connected ? status.tracker_loop : null;
  try {
    applyPower(powerWatch.observe({ onBattery: powerMonitor.isOnBatteryPower(), live: loop ? Number(loop.live_tracks) || 0 : 0 }));
  } catch {
    /* 读不到电源状态不影响心跳 */
  }
}

function createWindow() {
  const saved = loadWindowBounds();
  mainWindow = new BrowserWindow({
    width: saved.width ?? 1360,
    height: saved.height ?? 900,
    ...(saved.x !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 900,             // 1000 以下侧栏收成图标栏,内容区仍有 840 以上
    minHeight: 700,
    title: 'IBKR-Assistant',
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
      // 价位提醒 / 异动弹窗的轮询跑在 renderer:窗口最小化时不能被节流(盯盘节拍在引擎里,不受这一项影响)
      backgroundThrottling: false,
      devTools: DEV,
    },
  });

  if (saved.maximized) mainWindow.maximize();
  mainWindow.loadFile(RENDERER_INDEX);

  // UI 全部是本地资源,任何导航或新窗口都是异常,一律拦掉并交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  // 渲染层的报错落盘(开发时整条 console 都转出来,省得为看一条报错去开 DevTools)
  mainWindow.webContents.on('console-message', (event) => {
    const level = event.level ?? 'log';
    const text = `[renderer:${level}] ${event.message} (${event.sourceId}:${event.lineNumber})`;
    if (level === 'error' || level === 'warning') log.warn(text);
    else if (DEV) log.debug(text);
  });

  // 界面崩了(内存、GPU、渲染进程被系统杀掉):以前窗口就一直白着,价位提醒与异动弹窗的轮询跟着停,没人知道。
  // 持仓追踪的节拍在引擎里,不受影响。这里记日志、发系统通知、自动重新载入;一分钟内崩到第四次就停手
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error('[renderer] 主窗口渲染进程退出', details);
    if (quitting || details.reason === 'clean-exit') return;
    const now = Date.now();
    rendererCrashes = rendererCrashes.filter((t) => now - t < 60_000);
    rendererCrashes.push(now);
    if (rendererCrashes.length > 3) {
      notifySystem('界面反复崩溃,已停止自动重新载入', '持仓追踪在交易引擎里照常运行;价位提醒已停。请重启应用,日志在「帮助 → 在访达中显示日志」。');
      return;
    }
    notifySystem('界面意外退出,正在重新载入', '持仓追踪在交易引擎里照常运行;价位提醒在界面恢复后继续。');
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
    }, 800);
  });
  mainWindow.on('unresponsive', () => log.warn('[renderer] 主窗口无响应'));
  mainWindow.on('responsive', () => log.info('[renderer] 主窗口恢复响应'));

  mainWindow.on('focus', () => {
    // 弹窗出来时主窗口不在前台会闪任务栏;人回来了就别再闪
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false);
    sendWindowState({ focused: true });
  });
  mainWindow.on('blur', () => sendWindowState({ focused: false }));
  mainWindow.on('enter-full-screen', () => sendWindowState({ fullscreen: true }));
  mainWindow.on('leave-full-screen', () => sendWindowState({ fullscreen: false }));
  // 页面(重)载完补发一次:全屏里重启界面,或 ui:watch 重建后重载,渲染层不会自己知道
  mainWindow.webContents.on('did-finish-load', () => sendWindowState());

  // 真退出(⌘Q、Dock 的「退出」、关机)时 before-quit 先把 quitting 置上,这里放行;
  // 其余情况在 macOS 上都只是藏起来(为什么见 hideMainWindow)
  mainWindow.on('close', (event) => {
    saveWindowBounds();
    if (process.platform !== 'darwin' || quitting) return;
    event.preventDefault();
    hideMainWindow();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // 弹窗是独立的顶层窗口,隐藏着也算一扇窗:不跟着关,window-all-closed 永远等不来,
    // Windows 上应用就吊在后台退不掉
    popup.destroy();
  });
}

/**
 * macOS 的菜单栏。Electron 的 role 自带标签是写死的英文(About / Hide / Edit / Undo…),
 * 夹在「交易」「窗口」中间就是中英混排,所以每一项都显式写中文;用的词照 macOS 简体中文系统自己的叫法
 * (拷贝、隐藏其他、前置全部窗口)。Windows 的菜单栏被隐藏标题栏收掉了,只用得到快捷键,那边保持原样。
 */
function macMenuTemplate(tradeMenu) {
  const name = app.name;
  return [
    {
      label: name,
      submenu: [
        { label: `关于 ${name}`, click: () => navigateFromMenu('about') },
        { type: 'separator' },
        { label: '设置…', accelerator: 'Command+,', click: () => navigateFromMenu('settings') },
        { type: 'separator' },
        { label: '服务', role: 'services' },
        { type: 'separator' },
        { label: `隐藏 ${name}`, role: 'hide' },
        { label: '隐藏其他', role: 'hideOthers' },
        { label: '全部显示', role: 'unhide' },
        { type: 'separator' },
        { label: `退出 ${name}`, role: 'quit' },
      ],
    },
    tradeMenu,
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '拷贝', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '粘贴并匹配样式', role: 'pasteAndMatchStyle' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      // role: 'window' 让系统接管这个菜单:窗口列表、以及 macOS 自己加的「移动与调整大小」都挂在这里
      label: '窗口',
      role: 'window',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '缩放', role: 'zoom' },
        { label: '切换全屏幕', role: 'togglefullscreen' },
        { type: 'separator' },
        // ⌘W 只把窗口藏起来,后台照跑(见 hideMainWindow);⌘0 叫回来,和「信息」「音乐」的「窗口」菜单一样
        { label: '关闭窗口', role: 'close' },
        { label: '主窗口', accelerator: 'Command+0', click: () => showMainWindow() },
        { type: 'separator' },
        { label: '前置全部窗口', role: 'front' },
        ...(DEV ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: '帮助',
      role: 'help',
      submenu: [
        // 出了问题时的两样东西:一份能直接发给支持的诊断信息,和日志本身
        { label: '导出诊断信息…', click: () => supportFromMenu('export-diagnostics') },
        { label: '在访达中显示日志', click: () => shell.showItemInFolder(log.transports.file.getFile().path) },
      ],
    },
  ];
}

/** 菜单里的支持项:窗口叫出来,动作交给界面去发起(和界面上的按钮走同一条通道、同一个保存对话框)。 */
function supportFromMenu(action) {
  showMainWindow();
  send('menu', { action });
}

/**
 * Dock 图标的右键菜单。窗口藏着的时候这是离熔断最近的地方——不用先把窗口叫出来再找按钮。
 */
function buildDockMenu() {
  if (process.platform !== 'darwin' || !app.dock) return;
  app.dock.setMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '暂停全部自动执行(熔断)', click: () => haltFromMenu('Dock 菜单触发熔断') },
  ]));
}

function buildMenu() {
  const tradeMenu = {
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
  };
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate(macMenuTemplate(tradeMenu)));
    buildDockMenu();
    return;
  }
  const template = [
    tradeMenu,
    { role: 'editMenu' },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(DEV ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '导出诊断信息…', click: () => supportFromMenu('export-diagnostics') },
        { label: '打开日志所在位置', click: () => shell.showItemInFolder(log.transports.file.getFile().path) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function haltFromMenu(reason = '菜单/快捷键触发熔断') {
  // 从 Dock 菜单、或窗口藏着时按快捷键熔断,界面上那条回执没人看得见:结果另发一条系统通知
  const unseen = !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible();
  try {
    const result = await engine.call('breaker.halt', { reason });
    send('engine-event', { event: 'breaker', data: result });
    if (unseen) notifySystem('已暂停全部自动执行', '熔断已生效。恢复要回到应用里操作。');
  } catch (err) {
    send('engine-event', { event: 'error', data: { message: err.message } });
    if (unseen) notifySystem('熔断没有生效', String(err.message || err));
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
  return url.startsWith('file://') && url.includes('renderer-react/dist/index.html');
}

function wireEngine() {
  engine = new EngineClient({
    configPath: CONFIG_PATH,
    userDataDir: app.getPath('userData'),
    packaged: PACKAGED,
    appVersion: app.getVersion(),
    tsEngineRoot: TS_ENGINE_ROOT,
  });
  engine.on('engine-event', (payload) => {
    // 引擎每次起来(含改了配置之后手动重启)都按现在的配置重建脱敏器:账号只能手改配置文件
    if (payload && payload.event === 'ready') refreshRedactor();
    send('engine-event', payload);
  });
  engine.on('log', (line) => {
    send('engine-log', { line: redact(line) }); // 「关于」页那块日志会被截图发出去,同样先脱敏
    log.info('[engine]', line); // 引擎 stderr 也落盘:界面只留最近 200 行,崩溃前那几行往往在更早
  });
  engine.on('exit', (info) => {
    log.error('[engine] 已退出', info);
    // 配置读不进来(引擎用专门的退出码说的):重启一万次也是同一个错。停下自动重启,问用户怎么办
    if (info?.code === configGuard.EXIT_CONFIG && !quitting) {
      const fatal = configGuard.fatalLine(info.detail) || { kind: 'invalid', message: '配置文件读不进来' };
      send('engine-exit', { ...info, fatal: 'config', detail: fatal.message });
      engine.holdUntil(Number.MAX_SAFE_INTEGER, '交易引擎没有启动:配置文件有问题,请按弹出的提示处理');
      void handleConfigFatal(fatal);
      return;
    }
    // 交易库打不开:同样不是重启能解决的
    if (info?.code === storeGuard.EXIT_STORE && !quitting) {
      const fatal = storeGuard.fatalLine(info.detail) || { kind: 'corrupt', message: '交易库打不开', dbPath: null };
      send('engine-exit', { ...info, fatal: 'store', detail: fatal.message });
      engine.holdUntil(Number.MAX_SAFE_INTEGER, '交易引擎没有启动:交易库打不开,请按弹出的提示处理');
      void onStoreFatal(fatal);
      return;
    }
    send('engine-exit', info);
    // 引擎一停,追踪止盈止损就没人盯了——而崩的时候往往没人在场。以前只提示「可在关于里重启」,
    // 要等界面下一次轮询才被顺手拉起。这里直接拉起;引擎起来后按 broker.auto_connect 自己连回券商。
    // 我们自己停的(退出应用 / 手动重启发的 SIGTERM)不拉。
    if (quitting || info?.signal === 'SIGTERM') return;
    if (Date.now() - engineStartedAt > 5 * 60 * 1000) engineRestarts = 0;
    const delay = Math.min(60_000, 3000 * 2 ** engineRestarts);
    engineRestarts += 1;
    log.warn(`[engine] ${delay / 1000} 秒后自动重启(第 ${engineRestarts} 次)`);
    // 退避期间界面的轮询不许顺手把引擎拉起来(rpc-client.js 的 holdUntil),否则这个退避形同虚设
    engine.holdUntil(Date.now() + delay);
    setTimeout(() => {
      if (quitting || !engine || engine.child) return;
      engineStartedAt = Date.now();
      engine.start({ force: true }).catch(() => {});
    }, delay);
  });
  // 发单类调用超时之后,引擎才回话:把结果补报出来(系统通知 + 通知流 + 日志),并让界面重读记录
  engine.on('late-reply', (late) => {
    if (!OUTCOME_UNKNOWN_RPC.has(late.method)) return;
    const what = OUTCOME_LABEL[late.method] || late.method;
    const seconds = Math.round(late.waitedMs / 1000);
    const body = late.ok
      ? `引擎在 ${seconds} 秒后回话了:这次操作已经执行。请到「订单看板」核对,不要重复提交。`
      : `引擎在 ${seconds} 秒后回话了:这次操作没有成功(${String(late.error || '').slice(0, 160)})。`;
    log.warn(`[engine] 迟到的回执 ${late.method}(${seconds}s):${late.ok ? '已执行' : late.error}`);
    notifySystem(`「${what}」有结果了`, body);
    send('engine-event', { event: 'notification', data: { title: `「${what}」超时后有结果了`, subtitle: 'late', body } });
    send('engine-event', { event: 'pending', data: {} });
  });
  engineStartedAt = Date.now();
  // 启动失败会以 engine-exit 事件呈现在界面上
  engine.start().catch(() => {});
  startEngineWatchdog();
}

/** 主窗口在就挂在它上面(模态),不在就是一个独立的对话框。 */
function showBox(options) {
  return mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

let configDialogOpen = false;
let storeDialogOpen = false;

/** 交易库打不开时的对话框(support-ipc.js 的 handleStoreFatal),以及它之后的事:重试或退出。 */
async function onStoreFatal(fatal) {
  if (storeDialogOpen || quitting) return;
  storeDialogOpen = true;
  try {
    const next = await handleStoreFatal({ dialog, shell, log, showBox, notify: notifySystem }, fatal);
    if (next === 'quit') {
      app.quit();
      return;
    }
    engineStartedAt = Date.now();
    engine.start({ force: true }).catch(() => {});
  } finally {
    storeDialogOpen = false;
  }
}

/**
 * 配置文件读不进来时的那个对话框(为什么、口径见 config-guard.js)。
 * 四条路:恢复上一份可用的配置(有备份、且和现在这份不一样时才有)/ 打开文件所在位置自己改 / 重试 / 退出。
 */
async function handleConfigFatal(fatal) {
  if (configDialogOpen || quitting) return;
  configDialogOpen = true;
  const RESTORE = '恢复上一份可用的配置';
  const REVEAL = '打开配置文件所在位置';
  const RETRY = '我改好了,重试';
  const QUIT = '退出';
  const why = { missing: '配置文件不见了', syntax: '配置文件的格式坏了', invalid: '配置文件里有一项不合规' }[fatal.kind] || '配置文件读不进来';
  try {
    for (;;) {
      const state = configGuard.inspectConfig(CONFIG_PATH);
      const canRestore = state.backup.usable && !state.backup.sameAsCurrent;
      const buttons = [...(canRestore ? [RESTORE] : []), REVEAL, RETRY, QUIT];
      const backupNote = canRestore
        ? `\n\n上一份可用的配置备份于 ${new Date(state.backup.at).toLocaleString('zh-CN', { hour12: false })}。` +
          '恢复后「允许自动执行」「允许实盘账户下单」会是关闭的,需要时请到「设置」里重新打开;现在这份会改名留在旁边,不会删。'
        : '\n\n没有可以恢复的备份(还没有从界面改过设置)。请打开配置文件修正,或对照 settings.example.json 重写。';
      const { response } = await showBox({
        type: 'warning',
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        title: '配置文件有问题',
        message: `${why},交易引擎没有启动`,
        detail: `${fatal.message}\n\n文件:${CONFIG_PATH}\n引擎没有启动期间,持仓追踪的止盈止损不在盯盘。${backupNote}`,
        noLink: true,
      });
      const choice = buttons[response];
      if (choice === REVEAL) {
        shell.showItemInFolder(CONFIG_PATH);
        continue; // 对话框再出来一次:改完了好点「重试」
      }
      if (choice === RESTORE) {
        try {
          const done = configGuard.restoreBackup(CONFIG_PATH);
          log.warn('[config] 已从备份恢复配置', done);
          notifySystem(
            '已恢复上一份可用的配置',
            done.closedGates.length ? `已关闭:${done.closedGates.join('、')}。需要时请到「设置」里重新打开。` : '执行闸门保持关闭。',
          );
        } catch (err) {
          log.error('[config] 恢复配置失败', err);
          dialog.showErrorBox('恢复失败', String(err && err.message ? err.message : err));
          continue;
        }
      }
      if (choice === QUIT || choice === undefined) {
        app.quit();
        return;
      }
      engineStartedAt = Date.now();
      engine.start({ force: true }).catch(() => {});
      return;
    }
  } finally {
    configDialogOpen = false;
  }
}

/**
 * 引擎心跳。进程还在、却不回话(事件循环被同步代码占住、钥匙串弹窗挡住了同步读……)时,
 * 盯盘节拍跟着停了,而进程没退出,上面"退出就自动拉起"的那条路不会走到。
 * 每 10 秒问一次 system.status(本地道,正常是即答);连续 30 秒不回发系统通知,
 * 连续 3 分钟不回强制结束并重启——不急着杀:钥匙串弹窗可能正等着人点,杀了它下一次还会再弹。
 */
const WATCHDOG_EVERY_MS = 10_000;
const WATCHDOG_WARN_MS = 30_000;
const WATCHDOG_KILL_MS = 180_000;

/**
 * 排队中的条件单(方式 B)要有人按时去问一声才会触发、过期、回写成交:引擎那头 `pending.poll` 是唯一的入口。
 * 这一声原来只有界面在喊(store/pending.ts,10 秒一次)——界面崩了、正在重载、卡住了,条件单就没人盯。
 * 主进程跟着心跳再喊一遍:两边都喊不会出事(引擎的交易道是顺序的,第二声什么也不会多做),
 * 只有界面那一声没了的时候,这一声才是唯一的。
 */
let pendingBusy = false;

function drivePending(status) {
  if (pendingBusy || quitting || !status || !status.broker_connected) return;
  // 富途没有成交回报的事件流:已提交订单的状态只在这一轮里同步回来,没有排队的条件单也得问
  if (!status.pending_count && status.broker_provider !== 'futu') return;
  pendingBusy = true;
  engine
    .call('pending.poll', {}, { timeoutMs: 60_000 })
    .catch((err) => log.warn('[pending] 这一轮没问成', err && err.message ? err.message : err))
    .finally(() => {
      pendingBusy = false;
    });
}

function startEngineWatchdog() {
  let silentSince = 0;
  let warned = false;
  let inFlight = false;
  setInterval(async () => {
    if (quitting || !engine || !engine.child || inFlight) return;
    inFlight = true;
    const sentAt = Date.now();
    try {
      const status = await engine.call('system.status', {}, { timeoutMs: 8000 });
      if (warned) {
        log.info('[watchdog] 引擎恢复响应');
        notifySystem('交易引擎已恢复响应', '持仓追踪照常运行。');
      }
      silentSince = 0;
      warned = false;
      drivePending(status);
      observePower(status);
    } catch {
      // 这一问期间引擎退出了:自动拉起那条路会处理,不算"不回话"
      if (!engine.child) {
        silentSince = 0;
        return;
      }
      if (!silentSince) silentSince = sentAt;
      const silent = Date.now() - silentSince;
      if (silent >= WATCHDOG_KILL_MS) {
        log.error(`[watchdog] 引擎 ${Math.round(silent / 1000)} 秒没有回应,强制重启`);
        notifySystem('交易引擎无响应,已强制重启', '重启后会按设置自动连回券商、恢复持仓追踪。请核对追踪与挂单状态。');
        silentSince = 0;
        warned = false;
        engineStartedAt = Date.now();
        // 它已经不回话了,等它"答完在途请求"没有意义:不排空,直接结束
        engine.restart({ drainMs: 0 }).catch(() => {});
      } else if (silent >= WATCHDOG_WARN_MS && !warned) {
        warned = true;
        log.warn(`[watchdog] 引擎 ${Math.round(silent / 1000)} 秒没有回应`);
        notifySystem(
          '交易引擎没有回应',
          '持仓追踪的止盈止损暂时停了。屏幕上若有钥匙串 / 凭据弹窗,请先处理;3 分钟仍无回应会自动重启引擎。',
        );
      }
    } finally {
      inFlight = false;
    }
  }, WATCHDOG_EVERY_MS).unref();
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
    // 没同意现行条款之前,钱路径一律不放行(consent.js)
    const blocked = consent.blockedWithoutConsent(method, clean);
    if (blocked && !consent.consentState(app.getPath('userData')).accepted) throw new Error(blocked);
    // 会发单 / 授权发单 / 打开闸门的:要有原生确认框发出的凭据,而且绑的就是这一次的内容(confirm-grants.js)
    const current = method === 'settings.patch' ? await engine.call('settings.get', {}, { timeoutMs: 8000 }) : null;
    const needs = requiredGrants(method, clean, current);
    if (needs.length) {
      const missing = grants.consumeAll(needs);
      if (missing.length) {
        log.warn(`[rpc] ${method} 缺少确认凭据:${missing.join('、')}`);
        throw new Error(`这一步要先在确认框里点确认(${missing.join('、')})。没有确认、确认已过期、或内容在确认之后变了,都不会放行。`);
      }
    }
    if (method === 'data.export') {
      // 引擎会把整本交易记录写到给它的路径上。路径只认用户刚在保存对话框里选的那一个,用一次作废——
      // 否则一段被注入的界面脚本就能拿它覆盖任意文件(配置、交易库)(2026-09-27 审计)
      if (!pickedExportPath || clean.path !== pickedExportPath) {
        throw new Error('导出路径必须是刚在保存对话框里选的那一个,请重新点「导出」');
      }
      pickedExportPath = null;
    }
    if (!OUTCOME_UNKNOWN_RPC.has(method)) return engine.call(method, clean);
    try {
      return await engine.call(method, clean, { lateReply: true });
    } catch (err) {
      if (err && err.code === 'ENGINE_TIMEOUT') {
        throw new Error(
          '结果未知:引擎 2 分钟内没有回话,这次操作可能已经执行(订单可能已经发出)。' +
            '请先到「订单看板」和券商端核对,不要直接重发;引擎回话后这里会再通知一次。',
          { cause: err }
        );
      }
      throw err;
    }
  });

  // 外观:走 nativeTheme,渲染层的 prefers-color-scheme 与窗口底色一起切换
  ipcMain.handle('set-theme', (event, mode) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    if (!['system', 'light', 'dark'].includes(mode)) throw new Error(`未知外观模式:${mode}`);
    nativeTheme.themeSource = mode;
    syncTitleBarOverlay();
    popup.syncTheme();
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
      logPath: log.transports.file.getFile().path,
      engineVersion: engineVersion(),
      dev: DEV,
      engineRunning: Boolean(engine && engine.child),
    };
  });

  // 新版本检查(update-check.js):只读 GitHub 的公开发布信息,不下载不安装。
  // 结果缓存 10 分钟——GitHub 对未登录的查询一小时只给 60 次,界面上连点「检查更新」不该把额度点光
  ipcMain.handle('update-check', async (event, opts) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    const force = Boolean(opts && opts.force);
    if (!force && updateCache && Date.now() - updateCache.checkedAt < 10 * 60 * 1000) return updateCache;
    updateCache = await checkForUpdate({
      current: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      fetchImpl: (url, init) => net.fetch(url, init),
    });
    return updateCache;
  });

  ipcMain.handle('engine-restart', async (event) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    // 先等旧引擎真的退出再拉新的(rpc-client.js 的 stop / restart):两个引擎同时活着会抢同一个 TWS client id、
    // 同时写库、同时跑盯盘节拍——界面只看得见其中一个
    engineStartedAt = Date.now();
    engine.restart().catch(() => {});
    return { ok: true };
  });


  ipcMain.handle('pick-export-path', async (event) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出全部交易数据',
      defaultPath: path.join(app.getPath('downloads'), 'dafri-trades.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    pickedExportPath = result.canceled || !result.filePath ? null : result.filePath;
    return pickedExportPath;
  });

  // 绩效体检的分享卡片:渲染层画好的 PNG → 拷进剪贴板 / 另存。渲染层没有剪贴板权限(权限请求一律拒),也拿不到文件系统。
  // 只收 data:image/png、限 12 MB;另存的路径由这里的对话框定,渲染层递不进路径——它能决定的只有画了什么
  ipcMain.handle('image-export', async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    const { action, dataUrl, name } = payload || {};
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 12 * 1024 * 1024) {
      throw new Error('图片不合法');
    }
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) throw new Error('图片不合法');
    if (action === 'copy') {
      clipboard.writeImage(image);
      return { ok: true };
    }
    if (action === 'save') {
      // 文件名里不认的字符(路径分隔符、Windows 保留字符、控制字符)一律换成下划线
      const safe = Array.from(String(name || '交易体检'))
        .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
        .join('').slice(0, 60) || '交易体检';
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '保存分享卡片',
        defaultPath: path.join(app.getPath('downloads'), `${safe}.png`),
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(result.filePath, image.toPNG());
      return { ok: true, path: result.filePath };
    }
    throw new Error('未知操作');
  });

  // 系统通知。引擎侧的 notify.py 只在 macOS 上真的弹通知(其余平台只打印到
  // stderr),而价位警告在 Windows 上必须能弹出来——所以由主进程补这一条。
  ipcMain.handle('notify', (event, payload) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    const { title, body } = payload || {};
    if (typeof title !== 'string' || typeof body !== 'string') {
      throw new Error('通知内容不合法');
    }
    return { shown: notifySystem(title, body) };
  });

  // 异动 / 价位提醒的置顶弹窗(不抢焦点)。内容来自行情与用户填的标的,
  // 由 popup-window.js 逐字段清洗后才交给弹窗页;调用方只能是主窗口
  ipcMain.handle('popup-show', (event, payload) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    return popup.push(payload);
  });

  // 弹窗页的按钮(关一条 / 全部关 / 查看)与高度上报:只认弹窗自己的主 frame。
  // 「查看」会把主窗口叫到前台并跳页,来源不核对的话任何 frame 都能借道操纵主窗口
  ipcMain.on('popup-action', (event, msg) => {
    if (!popup.isPopupSender(event)) return;
    popup.handleAction(msg);
  });

  // 确认框。带 purpose 的是"要凭据的那种"(confirm-grants.js):最显眼的那一行由这里按用途写,界面改不了;
  // 用户点了确认才发凭据,凭据绑着 binding——之后那一次调用的内容对不上就不放行
  ipcMain.handle('confirm', async (event, options) => {
    if (!isTrustedSender(event)) throw new Error('调用来源不受信任');
    const { title, message, detail, confirmLabel, purpose, binding } = options || {};
    const bound = purpose !== undefined && purpose !== null;
    if (bound && !Object.hasOwn(PURPOSES, purpose)) throw new Error(`未知的确认用途:${String(purpose)}`);
    const box = bound
      ? await boundConfirmText(purpose, normalizeBinding(purpose, binding), { message, detail })
      : { title: String(title || '确认'), message: String(message || ''), detail: detail ? String(detail) : undefined };
    // 没有可确认的内容(比如要放宽的限额其实一项都没放宽):不弹框、不发凭据
    if (box === null) return true;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['取消', String(confirmLabel || '确认').slice(0, 40)],
      defaultId: 0,
      cancelId: 0,
      title: box.title,
      message: box.message,
      detail: box.detail,
      noLink: true,
    });
    const ok = response === 1;
    // 凭据绑的是**摆给人看的那一份**内容(box.binding),不是界面递过来的原样
    if (ok && bound) grants.issue(purpose, box.binding);
    return ok;
  });

  registerSupportIpc({
    ipcMain, dialog, shell, clipboard, app, log,
    configPath: CONFIG_PATH,
    noticesPath: NOTICES_PATH,
    engine: () => engine,
    window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    isTrustedSender,
    showBox,
    notify: notifySystem,
    send,
    engineFacts: () => ({ restarts: engineRestarts, lastUpdateCheck: updateCache }),
    markEngineStarted: () => {
      engineStartedAt = Date.now();
    },
  });
}

const GATE_TEXT = {
  'gate.auto_execute': '打开后,解析通过的订单会被直接发送到券商,没有人工确认环节。\n建议先在纸面账户跑够之后再打开。',
  'gate.allow_live_trading': '打开后,指向实盘账户的订单不再被拦截,会用真钱成交。',
};

/**
 * 带凭据的确认框上写什么。第一行(这是在确认什么)永远是主进程按用途写的;
 * 发单那一种连"发的是哪句话、发到哪些账户、是纸面还是实盘"也由这里写——绑进凭据的就是摆给人看的那一份。
 */
async function boundConfirmText(purpose, binding, { message, detail }) {
  const headline = PURPOSES[purpose];
  if (purpose.startsWith('gate.')) return { title: headline, message: headline, detail: GATE_TEXT[purpose], binding };
  if (purpose === 'limits.loosen') {
    // 从多少改到多少,由这里对着引擎现在的设置算:界面说"只是从 5,000 调到 6,000"不作数
    const current = await engine.call('settings.get', {}, { timeoutMs: 8000 });
    const loosened = loosenedLimits(binding.limits, current.limits);
    if (!loosened.length) return null;
    const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—');
    return {
      title: headline,
      message: headline,
      detail:
        loosened.map((l) => `${l.label}:${fmt(l.from)} → ${fmt(l.to)}`).join('\n') +
        '\n\n这些限额是每一笔订单都要过的闸:放宽之后,解析错了的指令能造成的损失也跟着变大。',
      // 只绑真的放宽了的那几项:放行时主进程也是这么算的(requiredGrants)
      binding: { limits: Object.fromEntries(loosened.map((l) => [l.key, l.to])) },
    };
  }
  const lines = [message, detail].filter((v) => typeof v === 'string' && v.trim()).map((v) => String(v).slice(0, 1200));
  if (purpose === 'instruction.submit') {
    // 账户是纸面还是实盘,问引擎,不听界面的
    let kinds = new Map();
    try {
      const status = await engine.call('system.status', {}, { timeoutMs: 5000 });
      kinds = new Map((status.accounts || []).map((a) => [String(a.alias), a.is_paper ? '纸面' : '实盘']));
    } catch {
      /* 引擎不答话:账户类别标「未知」,发不发得出去由引擎的闸门说了算 */
    }
    const targets = binding.accounts.map((alias) => `${alias}(${kinds.get(alias) || '类别未知'})`).join('、');
    const live = binding.accounts.some((alias) => kinds.get(alias) === '实盘');
    return {
      title: headline,
      message: live ? `${headline}(含实盘账户)` : headline,
      detail:
        `${String(message || '').slice(0, 600)}\n\n` +
        `指令:${binding.text.slice(0, 800)}\n` +
        `账户:${targets || '(没有勾选账户)'}${binding.accounts.length > 1 ? `\n每笔订单各发 ${binding.accounts.length} 份。` : ''}`,
      binding,
    };
  }
  return { title: headline, message: headline, detail: lines.join('\n\n') || undefined, binding };
}


/**
 * macOS:直接从挂载的 DMG 里双击运行时,提出把应用复制到 /Applications。
 * 这一步就是我们的"安装器":复制→打开新副本→退出 DMG 里这份。
 * 已存在旧版则先删旧版(此时旧版必然没在运行,否则单实例锁早把本进程挡下了)。
 */
async function offerMoveToApplications() {
  if (process.platform !== 'darwin' || !PACKAGED) return false;
  if (process.env.DAFRI_SKIP_MOVE === '1') return false;
  const bundle = path.resolve(process.execPath, '..', '..', '..'); // .../IBKR-Assistant.app
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
    message: '要把 IBKR-Assistant 移到「应用程序」文件夹吗?',
    detail: fs.existsSync(target)
      ? '检测到「应用程序」里已有一个版本,将用当前版本替换它。'
      : '从磁盘映像直接运行无法保存更新,建议移动后再使用。',
    noLink: true,
  });
  if (response !== 0) return false;

  const { spawnSync } = require('node:child_process');
  // 先把新的拷到旁边,拷成了再换掉旧的。以前是先删旧的再拷:拷到一半失败(磁盘满、权限),
  // 「应用程序」里就一个版本都没有了
  const incoming = `${target}.incoming`;
  spawnSync('rm', ['-rf', incoming]);
  // ditto 而不是 cp -R:拷应用包是它的本职,扩展属性、资源分支、框架里的符号链接都原样带过去,
  // 签名才对得上(Apple 自己的安装说明也用它)
  const cp = spawnSync('ditto', [bundle, incoming]);
  if (cp.status !== 0) {
    spawnSync('rm', ['-rf', incoming]);
    dialog.showErrorBox('复制失败', String(cp.stderr || 'ditto 退出码 ' + cp.status) + '\n「应用程序」里原有的版本没有动。');
    return false;
  }
  if (fs.existsSync(target)) {
    const rm = spawnSync('rm', ['-rf', target]);
    if (rm.status !== 0) {
      spawnSync('rm', ['-rf', incoming]);
      dialog.showErrorBox(
        '无法替换旧版本',
        '删除旧版失败:' + String(rm.stderr || '') +
          '\n若旧版正在运行请先退出;或手动把旧版拖到废纸篓后重试。'
      );
      return false;
    }
  }
  try {
    fs.renameSync(incoming, target);
  } catch (err) {
    dialog.showErrorBox('无法放进「应用程序」', String(err && err.message ? err.message : err) + `\n新版本在 ${incoming},可以手动改名。`);
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
    showMainWindow(); // macOS 上窗口可能是藏着的(关窗只是隐藏),单 focus() 叫不出来
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
          message: '检测到另一个 IBKR-Assistant 正在尝试启动',
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
    // 开发态(npm start)的 Dock 图标:不设就是 Electron 的默认图标。打包版的图标在应用包里,不走这里
    if (!PACKAGED && process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(path.join(__dirname, 'build', 'icon.png'));
      } catch {
        /* 图标文件不在也不影响启动 */
      }
    }
    // 严格 CSP:不允许任何远程资源、不允许 eval
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const nonce = styleNonce();
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            `default-src 'none'; script-src 'self'; style-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'`,
          ],
        },
      });
    });
    // 界面不需要任何系统权限
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    let bootstrap;
    try {
      bootstrap = ensureConfigExists();
    } catch (err) {
      // 数据目录写不进去(权限、磁盘满):以前是一个未捕获异常,窗口不开、也没有任何提示
      log.error('[boot] 创建配置文件失败', err);
      dialog.showErrorBox(
        'IBKR-Assistant 无法启动',
        `写不进配置文件:${CONFIG_PATH}\n${String(err && err.message ? err.message : err)}\n\n请检查这个文件夹的权限与磁盘剩余空间后重试。`,
      );
      app.quit();
      return;
    }
    refreshRedactor();
    registerIpc();
    wireEngine();
    // 应用开着就不让系统挂起:挂起期间引擎不跑,追踪止盈止损也就不盯了。只挡闲置睡眠,不挡关屏;
    // 用电池时合上盖子它挡不住,那种情形只能提醒(watchPower)
    try {
      powerSaveBlocker.start('prevent-app-suspension');
    } catch (err) {
      log.warn('[power] 阻止系统挂起失败', err);
    }
    watchPower();
    createWindow();
    buildMenu();
    if (bootstrap.created) {
      send('bootstrap', { message: '已从示例创建配置文件。请先到「接入 → 账户」填上你的账号,并在「设置」里核对限额。' });
    }

    // 点 Dock 图标:窗口藏着就叫回来。原来按"一扇窗都没有才新建"判断,可置顶弹窗也算一扇窗,
    // 藏着的主窗口更算——那样点 Dock 什么都不会发生
    app.on('activate', () => {
      if (!showMainWindow()) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    quitting = true;
    popup.destroy();
    // 引擎在 before-quit 里停(等它停稳才真的退出)。macOS 走不到这里:关窗只是藏起来
    if (process.platform !== 'darwin') app.quit();
    else if (engine) engine.stop({ final: true });
  });

  // 退出要等引擎停稳:引擎先答完在途请求(正在发的那张单落完库)再退;它不肯退,rpc-client 会在宽限期后强制结束。
  // 不等的话主进程先走了,SIGTERM / SIGKILL 的定时器跟着没了——卡住的引擎会变成孤儿,连着券商继续跑盯盘节拍
  let engineStopped = false;
  app.on('before-quit', (event) => {
    quitting = true;
    popup.destroy();
    if (!engine || engineStopped) return;
    event.preventDefault();
    engine
      .stop({ final: true })
      .catch(() => {})
      .finally(() => {
        engineStopped = true;
        app.quit();
      });
  });
}
