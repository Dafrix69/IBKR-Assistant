'use strict';
/**
 * 异动 / 价位提醒的置顶弹窗(设计:优质股追踪 §C2)。
 *
 * 为什么是一扇独立的小窗,而不是系统通知:
 *   * Windows 的系统通知几秒就收进操作中心,盘中一眼没看到就错过了;这扇窗不点掉就一直在;
 *   * 用户很可能正在 TWS 里敲数量——弹窗只用 showInactive(),Windows 上还设成不可获得焦点,
 *     点它的按钮也不会把键盘焦点从 TWS 抢走,否则按键会打进别处;
 *   * 同一时刻常常好几只股一起异动,一张列表比一串叠起来的通知好看、好关。
 *
 * 安全基线与主窗口一致:contextIsolation / sandbox / 无 node,只加载本地页面,导航与开新窗口一律拦。
 * 渲染层送来的内容逐字段清洗(sanitizePopupPayload);弹窗页发回的动作只认这扇窗自己的主 frame(isPopupSender)。
 *
 * 这个文件要能在纯 Node 里加载(引擎的测试直接 require 它):electron 只在真正用到的函数里取。
 */
const path = require('node:path');

const POPUP_WIDTH = 360;
const EDGE_MARGIN = 12;
const MIN_HEIGHT = 96;
// 再高就会盖住半个屏幕;条目多了让列表自己滚
const MAX_HEIGHT_RATIO = 0.7;
const MAX_ITEMS = 30;
// 一批最多收这么多条,和列表上限取齐:收不下的在 push 里如实报成 dropped,
// 由渲染层给剩下的补系统通知——悄悄截掉就等于把那几条提醒吞了
const MAX_INCOMING = MAX_ITEMS;
// 页面迟迟不报高度(卡住、崩了)时的兜底:提醒宁可高度不准,也不能不出来
const REVEAL_FALLBACK_MS = 1500;
// 本地页面正常几百毫秒就 ready;建窗这么久还没 ready 就当它坏了(加载失败 / 预加载出错)
const PAGE_READY_TIMEOUT_MS = 10000;
// 页面坏了改发系统通知时,一次最多堆这么多条,再多汇总成一条:
// 30 条 toast 糊满屏幕,用户一条也看不清,还得一条条点掉
const NOTIFY_FALLBACK_MAX = 5;

const POPUP_PAGE = path.join(__dirname, 'popup', 'popup.html');
const POPUP_PRELOAD = path.join(__dirname, 'popup-preload.js');
const POPUP_URL_SUFFIX = '/popup/popup.html';
// 与 popup.css 的 --bg-window 对齐:窗口先于页面画出来,底色不一致会闪一下
const BG_LIGHT = '#f2f2f4';
const BG_DARK = '#232325';

const KINDS = new Set(['anomaly', 'level']);
const TONES = new Set(['up', 'down', 'info']);
const PAGES = new Set(['quality', 'sectors']);
const UPDOWNS = new Set(['red-up', 'green-up']);

// C0 / C1 控制字符(含换行、制表)换成空格;零宽与双向控制字符直接去掉——
// 后者能把「下破」排成「破下」一类的视觉欺骗,弹窗里没有任何理由需要它们
// eslint-disable-next-line no-control-regex -- 这里就是要匹配控制字符
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
const INVISIBLE_CHARS = /[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** 按字符(码点)截断:按 UTF-16 截可能劈开一个 emoji,留下半个代理对。 */
function clip(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : text;
}

function cleanText(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value)
    .replace(INVISIBLE_CHARS, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(text, max);
}

function cleanId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[^\w:.\-|+]/g, '').slice(0, 100);
}

function cleanSymbol(value) {
  if (typeof value !== 'string') return '';
  return value.toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 16);
}

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = cleanId(raw.id);
  if (!id) return null; // 没有 id 就没法逐条关,整条不要
  const symbol = cleanSymbol(raw.symbol);
  return {
    id,
    kind: KINDS.has(raw.kind) ? raw.kind : 'anomaly',
    symbol,
    title: cleanText(raw.title, 80) || symbol,
    body: cleanText(raw.body, 240),
    tone: TONES.has(raw.tone) ? raw.tone : 'info',
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : Date.now(),
    page: PAGES.has(raw.page) ? raw.page : null,
  };
}

/**
 * 渲染层送来的弹窗内容 → 只剩白名单字段、长度有上限的纯数据。
 * 内容来自行情和用户填的标的,不该由它决定弹窗有多大、显示什么控制字符。
 * 幂等:清洗过的再洗一遍结果不变(PopupManager.push 自己也会洗;dropped 每次按当次入参重算)。
 *
 * dropped = 超过一批上限、被截在门外的条数。谁也别假装它们显示过:push 会把它报回渲染层。
 */
function sanitizePopupPayload(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const all = Array.isArray(src.items) ? src.items : [];
  const rawItems = all.slice(0, MAX_INCOMING);
  const items = [];
  for (const raw of rawItems) {
    const item = sanitizeItem(raw);
    if (item) items.push(item);
  }
  return { items, updown: UPDOWNS.has(src.updown) ? src.updown : 'green-up', dropped: all.length - rawItems.length };
}

/** 两块工作区是不是同一块:显示器插拔、改分辨率之后靠它认出"存的那块屏没了"。 */
function sameArea(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
}

/** 工作区右上角,边距 12;高度夹在 [96, 工作区高 × 0.7]。setBounds 只收整数。 */
function popupBounds(workArea, contentHeight) {
  const maxHeight = Math.max(MIN_HEIGHT, Math.floor(workArea.height * MAX_HEIGHT_RATIO));
  const wanted = Number.isFinite(contentHeight) ? Math.ceil(contentHeight) : MIN_HEIGHT;
  return {
    x: Math.round(workArea.x + workArea.width - POPUP_WIDTH - EDGE_MARGIN),
    y: Math.round(workArea.y + EDGE_MARGIN),
    width: POPUP_WIDTH,
    height: Math.min(Math.max(wanted, MIN_HEIGHT), maxHeight),
  };
}

function themeBackground(nativeTheme) {
  return nativeTheme && nativeTheme.shouldUseDarkColors ? BG_DARK : BG_LIGHT;
}

class PopupManager {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.dev]  开发模式才开 DevTools、转发弹窗页的 console
   * @param {() => any} [opts.getMainWindow]  当前主窗口(可能为 null)
   * @param {(channel: string, payload: any) => void} [opts.sendToMain]  发给主窗口渲染层
   * @param {any} [opts.electron]  测试替身;缺省在第一次用到时 require('electron')
   */
  constructor({ dev = false, getMainWindow = () => null, sendToMain = () => {}, electron = null } = {}) {
    this.dev = Boolean(dev);
    this.getMainWindow = getMainWindow;
    this.sendToMain = sendToMain;
    this.electronOverride = electron;
    this.items = []; // 新的在前
    this.updown = 'green-up';
    this.win = null;
    this.ready = false; // 页面订阅好 popup-items 之后才发内容;之前的就留在 items 里排队
    this.height = MIN_HEIGHT; // 页面上报的内容高度
    // 显示那一刻选定的工作区:之后来新条目只改高度,不跟着光标跳到另一块屏
    this.anchor = null;
    // 有新内容、还没按页面上报的高度摆好:等 size 到了再露面,免得先闪一个高度不对的窗
    this.pendingReveal = false;
    this.revealTimer = null;
    this.createdAt = 0;
    // 看门狗:建窗就开始走,到点还没 ready 就判这扇窗坏了,排队的提醒改发系统通知
    this.readyTimer = null;
    // 任务栏/Dock 已经在闪了:macOS 上每调一次 flashFrame(true) 都是一次新的
    // requestUserAttention(critical),只有最后一个 id 会被取消,重复调 Dock 就一直跳
    this.flashing = false;
    this.flashWin = null; // 当前挂了 focus 监听的主窗口(主窗口会被重建)
    this.unwatchFocus = null;
    this.unwatchDisplays = null;
  }

  #electron() {
    return this.electronOverride || require('electron');
  }

  #alive() {
    return Boolean(this.win && !this.win.isDestroyed());
  }

  #visible() {
    return this.#alive() && this.win.isVisible();
  }

  /**
   * 渲染层要弹的提醒。返回 { shown: 收下准备显示的条数, dropped: 没收下的条数 }。
   *
   * 这个数必须诚实:渲染层按它决定要不要给剩下的补系统通知。收下 ≠ 已经画出来了——
   * 页面还没 ready 的时候条目在队列里等,所以主进程这头还有一道看门狗(#armReadyWatchdog):
   * 页面迟迟不 ready、或者加载失败 / 预加载出错,排队的那些就由主进程自己发系统通知(#notifyFallback)。
   * 两头加起来才有那句话:提醒可以样子难看,但不能没了。
   */
  push(payload) {
    const clean = sanitizePopupPayload(payload);
    this.updown = clean.updown;
    // 超出一批上限被截掉的:一条都别算进 shown
    const dropped = clean.dropped;
    if (clean.items.length === 0) return { shown: 0, dropped };
    if (this.#alive() && !this.ready && Date.now() - this.createdAt > PAGE_READY_TIMEOUT_MS) {
      // 看门狗没跑成(定时器被挂起、系统睡过去)时的补刀:排队的交给系统通知,窗口扔掉等下一条重建。
      // 这一批干脆不进队列,如实报 0 让渲染层去补——否则主进程和渲染层会给同一条各发一遍
      this.#pageBroken('建窗后一直没有就绪');
      return { shown: 0, dropped: dropped + clean.items.length };
    }
    this.#merge(clean.items);
    // 还没露面时先按条数估个高度:页面万一不报高度,兜底显示也不至于只露半条
    if (!this.#visible()) this.height = Math.max(this.height, 48 + 88 * Math.min(this.items.length, 4));
    this.#ensureWindow();
    this.pendingReveal = true;
    this.#sendItems();
    return { shown: clean.items.length, dropped };
  }

  /** 按 id 去重替换,按时间新的在前,最多 30 条(更早的挤掉)。 */
  #merge(incoming) {
    const batch = new Map();
    for (const item of incoming) {
      batch.delete(item.id);
      batch.set(item.id, item);
    }
    const merged = [...batch.values(), ...this.items.filter((it) => !batch.has(it.id))];
    // sort 是稳定的:同一秒的几条保持"这一批在前、批内原顺序"
    merged.sort((a, b) => b.at - a.at);
    this.items = merged.slice(0, MAX_ITEMS);
  }

  dismiss(id) {
    const key = cleanId(id);
    const before = this.items.length;
    this.items = this.items.filter((it) => it.id !== key);
    if (this.items.length === before) return false;
    // 关光了就收窗;两种情况都要把列表发下去,页面的 DOM 才跟状态对得上
    // (隐藏着的窗还留着上一批卡片,下次露面前那一帧就可能是旧的)
    if (this.items.length === 0) this.#hide();
    this.#sendItems(); // 页面重排后会报新高度,窗口跟着缩
    return true;
  }

  clear() {
    this.items = [];
    this.#hide();
    this.#sendItems(); // 同上:窗口藏起来了,页面里也别留着一列已经关掉的卡片
  }

  /** 「查看」:把主窗口叫到前台、跳到对应页,再关掉这一条。 */
  open(id) {
    const key = cleanId(id);
    const item = this.items.find((it) => it.id === key);
    if (!item) return false;
    this.#focusMain();
    this.sendToMain('menu', { action: 'navigate', page: item.page || 'quality', symbol: item.symbol });
    this.dismiss(key);
    return true;
  }

  /** 弹窗页发回的动作。调用方(main.js)先用 isPopupSender 核对来源。 */
  handleAction(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.#clearReadyTimer(); // 页面活着,看门狗撤了
        this.#sendItems();
        break;
      case 'size':
        this.#onSize(msg.height);
        break;
      case 'dismiss':
        this.dismiss(msg.id);
        break;
      case 'clear':
        this.clear();
        break;
      case 'open':
        this.open(msg.id);
        break;
      default:
        break;
    }
  }

  /** 只认这扇弹窗自己的主 frame,且页面就是 popup/popup.html。 */
  isPopupSender(event) {
    if (!this.#alive() || !event) return false;
    if (event.sender !== this.win.webContents) return false;
    const frame = event.senderFrame;
    if (frame && frame.parent) return false; // 子 frame 一律不认
    let url = '';
    try {
      url = (frame && frame.url) || event.sender.getURL();
    } catch {
      return false;
    }
    return typeof url === 'string' && url.startsWith('file://') && url.endsWith(POPUP_URL_SUFFIX);
  }

  /** 深浅色变了:窗口底色跟着换(页面自己靠 prefers-color-scheme)。 */
  syncTheme() {
    if (!this.#alive()) return;
    try {
      this.win.setBackgroundColor(themeBackground(this.#electron().nativeTheme));
    } catch {
      /* 窗口正在销毁 */
    }
  }

  /** 应用退出 / 主窗口关闭时调用:弹窗哪怕隐藏着也算一扇窗,不关掉它应用就退不干净。 */
  destroy() {
    this.#clearRevealTimer();
    this.#clearReadyTimer();
    this.#unwatchDisplays();
    this.#unwatchMainFocus();
    this.pendingReveal = false;
    this.anchor = null;
    this.flashing = false;
    const win = this.win;
    this.win = null;
    this.ready = false;
    if (win && !win.isDestroyed()) win.destroy();
  }

  /**
   * 弹窗页指望不上了(加载失败 / 预加载出错 / 建窗后迟迟不 ready)。
   * 排队的提醒一条都不能咽下去:窗口扔掉,队列里的改由主进程发系统通知。
   * 窗口不在这里重建——下一条提醒来时 push 自己会建,新窗口带自己的看门狗。
   */
  #pageBroken(reason) {
    if (this.ready) return; // 已经 ready 过:页面是好的,别为一个迟到的失败事件把窗拆了
    console.error(`[popup] 弹窗页${reason},这一批改发系统通知`);
    const queued = this.items;
    this.items = []; // 已经改走系统通知,别等窗口恢复了再显示一遍
    this.destroy();
    this.#notifyFallback(queued);
  }

  /**
   * 最后一道:把提醒改成系统通知发出去。样子差一截(几秒就收进操作中心),
   * 但总好过一条也不出来——弹窗页在打包版里缺文件、预加载出错,用户是看不见任何报错的。
   */
  #notifyFallback(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    let Notification = null;
    try {
      ({ Notification } = this.#electron());
    } catch {
      Notification = null;
    }
    const ok = Notification && typeof Notification.isSupported === 'function' && Notification.isSupported();
    if (!ok) {
      console.error(`[popup] 系统通知也用不了,${items.length} 条提醒没能送达:${items.map((it) => it.title).join(' / ')}`);
      return;
    }
    const head = items.slice(0, NOTIFY_FALLBACK_MAX);
    const rest = items.length - head.length;
    // items 是新的在前;通知是一条条堆上去的,倒过来发,最新的才落在最上面
    for (const item of [...head].reverse()) {
      try {
        new Notification({ title: item.title || item.symbol || '异动提醒', body: item.body }).show();
      } catch (err) {
        console.error(`[popup] 系统通知发送失败:${err && err.message}`);
      }
    }
    if (rest > 0) {
      try {
        new Notification({ title: '异动提醒', body: `另有 ${rest} 条提醒没能显示(弹窗页出了问题)` }).show();
      } catch {
        /* 同上 */
      }
    }
  }

  #ensureWindow() {
    if (this.#alive()) return this.win;
    const { BrowserWindow, nativeTheme } = this.#electron();
    const mac = process.platform === 'darwin';
    const win = new BrowserWindow({
      width: POPUP_WIDTH,
      height: this.height,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Windows:不可获得焦点(WS_EX_NOACTIVATE)——点「×」「查看」也不会把键盘焦点从 TWS 抢走。
      // macOS 不这么设:不可聚焦的窗口第一下点击会被吞掉;那边用 panel(不激活应用的面板)达到同样效果,
      // 顺带能浮在别的应用的全屏空间之上。acceptFirstMouse:应用不在前台时一下就能点中「×」
      focusable: process.platform !== 'win32',
      ...(mac ? { type: 'panel', acceptFirstMouse: true } : {}),
      title: '异动提醒',
      backgroundColor: themeBackground(nativeTheme),
      webPreferences: {
        preload: POPUP_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        // 窗口隐藏着的时候页面也要能即时排版、上报高度
        backgroundThrottling: false,
        devTools: this.dev,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    if (mac) {
      // skipTransformProcessType:不加的话 Electron 会把整个应用转成 UIElement——Dock 图标和菜单栏跟着没了,
      // 「交易」菜单里的熔断快捷键也就没了。主窗口是交易台,不能为一扇弹窗付这个代价;浮在全屏之上交给 panel
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }

    const wc = win.webContents;
    // 弹窗页全是本地资源、没有任何链接:导航、开新窗口、webview 都是异常
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, url) => {
      if (url !== wc.getURL()) event.preventDefault();
    });
    wc.on('will-attach-webview', (event) => event.preventDefault());
    // 这两种失败页面都不会 ready,而且当场就知道了:不必等看门狗那 10 秒,直接判坏改发系统通知
    wc.on('did-fail-load', (_event, code, desc, _url, isMainFrame) => {
      console.error(`[popup] 弹窗页加载失败:${code} ${desc}`);
      if (isMainFrame === false) return; // 子 frame 的失败不算(弹窗页本来也没有子 frame)
      if (code === -3) return; // ERR_ABORTED:被下一次加载顶掉,不是坏
      if (this.win === win) this.#pageBroken('加载失败');
    });
    wc.on('preload-error', (_event, file, error) => {
      console.error(`[popup] 弹窗预加载出错:${file} ${error && error.message}`);
      // 预加载挂了 = 页面拿不到 dafriPopup,永远不会 ready
      if (this.win === win) this.#pageBroken('预加载出错');
    });
    // 页面进程崩了:扔掉这扇窗,条目留着,下一条提醒来时重建窗口一起显示
    wc.on('render-process-gone', (_event, details) => {
      console.error(`[popup] 弹窗页进程退出:${(details && details.reason) || 'unknown'}`);
      if (this.win === win) this.destroy();
      else if (!win.isDestroyed()) win.destroy();
    });
    if (this.dev) {
      wc.on('console-message', (event) => {
        console.log(`[popup:${event.level ?? 'log'}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
      });
    }
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null;
      this.ready = false;
      this.anchor = null;
      this.pendingReveal = false;
      this.#clearRevealTimer();
      this.#clearReadyTimer();
      this.#unwatchDisplays();
    });

    this.win = win;
    this.ready = false;
    this.createdAt = Date.now();
    this.#armReadyWatchdog(win);
    this.#watchDisplays();
    Promise.resolve(win.loadFile(POPUP_PAGE)).catch((err) => {
      console.error(`[popup] 弹窗页加载失败:${err && err.message}`);
      if (this.win === win) this.#pageBroken('加载失败');
    });
    return win;
  }

  /** 建窗就开始计时:到点还没 ready,这扇窗就是坏的(缺文件、预加载挂了、渲染进程起不来)。 */
  #armReadyWatchdog(win) {
    this.#clearReadyTimer();
    const timer = setTimeout(() => {
      this.readyTimer = null;
      if (this.win !== win || this.ready) return;
      this.#pageBroken('建窗后一直没有就绪');
    }, PAGE_READY_TIMEOUT_MS);
    // 这只是兜底,不该把主进程的事件循环吊着(Electron 里无所谓,纯 Node 跑测试时有所谓)
    if (timer && typeof timer.unref === 'function') timer.unref();
    this.readyTimer = timer;
  }

  #clearReadyTimer() {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  #sendItems() {
    if (!this.#alive() || !this.ready) return; // 页面还没 ready:items 留着,ready 时整份发
    try {
      this.win.webContents.send('popup-items', { items: this.items, updown: this.updown });
    } catch {
      return;
    }
    if (this.pendingReveal) this.#armRevealFallback();
  }

  #onSize(height) {
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return;
    this.height = Math.min(Math.ceil(height), 10000);
    if (this.pendingReveal) this.#reveal();
    else if (this.#visible()) this.#place();
  }

  #armRevealFallback() {
    this.#clearRevealTimer();
    this.revealTimer = setTimeout(() => {
      this.revealTimer = null;
      if (this.pendingReveal) this.#reveal();
    }, REVEAL_FALLBACK_MS);
  }

  #clearRevealTimer() {
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.revealTimer = null;
  }

  #reveal() {
    this.#clearRevealTimer();
    this.pendingReveal = false;
    if (!this.#alive()) return;
    if (this.items.length === 0) {
      this.#hide();
      return;
    }
    const win = this.win;
    if (!win.isVisible()) {
      this.anchor = null; // 每次从头露面都重挑一块屏(#place 会挑光标所在的那块)
      this.#place();
      win.showInactive(); // 绝不 show() / focus():焦点被抢走,正在 TWS 里敲的数量就打进别处了
    } else {
      this.#place();
      // 别的置顶窗口可能压在它上面;moveTop 只调层级,不激活窗口
      try {
        win.moveTop();
      } catch {
        /* 老系统不支持就算了 */
      }
    }
    this.#flashMain(true);
  }

  #place() {
    if (!this.#alive()) return;
    try {
      // 存的那块屏可能已经被拔了 / 改了分辨率:再按它摆就摆到屏幕外面去了,
      // 而 push 那头还一路报 shown——提醒"发出去了"却没人看得见。对不上就重新挑一块
      if (this.anchor && !this.#anchorStillThere()) this.anchor = null;
      if (!this.anchor) this.anchor = this.#pickWorkArea();
      this.win.setBounds(popupBounds(this.anchor, this.height));
    } catch {
      /* 窗口正在销毁、或 screen 取不到:这一下不摆,下一条提醒来时还会再摆一次 */
    }
  }

  /** 存的工作区还对得上某块在用的屏吗?取不到显示器列表就当它还在(别为了保险乱挪窗)。 */
  #anchorStillThere() {
    let displays = null;
    try {
      const { screen } = this.#electron();
      if (typeof screen.getAllDisplays !== 'function') return true;
      displays = screen.getAllDisplays();
    } catch {
      return true;
    }
    if (!Array.isArray(displays) || displays.length === 0) return true;
    return displays.some((d) => sameArea(d && d.workArea, this.anchor));
  }

  /** 插拔显示器、改分辨率、任务栏换边:显示着就当场重摆一次。 */
  #watchDisplays() {
    if (this.unwatchDisplays) return;
    const events = ['display-added', 'display-removed', 'display-metrics-changed'];
    const onChange = () => {
      if (this.#visible()) this.#place();
    };
    let screen = null;
    try {
      ({ screen } = this.#electron());
      if (typeof screen.on !== 'function') return;
      for (const ev of events) screen.on(ev, onChange);
    } catch {
      return;
    }
    this.unwatchDisplays = () => {
      try {
        for (const ev of events) screen.removeListener(ev, onChange);
      } catch {
        /* 退出过程中 screen 可能已经拆了 */
      }
    };
  }

  #unwatchDisplays() {
    if (this.unwatchDisplays) this.unwatchDisplays();
    this.unwatchDisplays = null;
  }

  /** 光标所在的那块屏:用户正看着的地方,多屏时比主屏更可能被看见。 */
  #pickWorkArea() {
    const { screen } = this.#electron();
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    } catch {
      return screen.getPrimaryDisplay().workArea;
    }
  }

  #hide() {
    this.#clearRevealTimer();
    this.pendingReveal = false;
    this.anchor = null;
    if (this.#visible()) this.win.hide();
    this.#flashMain(false); // 提醒都关掉了,任务栏也别再闪
  }

  /**
   * 任务栏 / Dock 闪一下。只在"没闪 → 闪"这一次调 flashFrame(true):
   * macOS 上每调一次都是一次新的 requestUserAttention(critical),而 flashFrame(false)
   * 只取消得掉最后那一个 id——一批批地调,Dock 就会一直跳个不停。
   */
  #flashMain(on) {
    const main = this.getMainWindow();
    if (!main || main.isDestroyed()) {
      this.#unwatchMainFocus();
      this.flashing = false;
      return;
    }
    this.#watchMainFocus(main);
    try {
      if (!on) {
        if (this.flashing) main.flashFrame(false);
        this.flashing = false;
      } else if (main.isFocused()) {
        this.flashing = false; // 人就在主窗口前,不用叫他
      } else if (!this.flashing) {
        main.flashFrame(true);
        this.flashing = true;
      }
    } catch {
      /* 窗口正在销毁 */
    }
  }

  /**
   * 主窗口被点到前台时,系统自己会把闪烁停掉——不跟着把标记清零,
   * 用户再切走之后来的提醒就再也不闪了。主窗口可能被重建,所以按窗口对象换监听。
   */
  #watchMainFocus(main) {
    if (this.flashWin === main) return;
    this.#unwatchMainFocus();
    if (typeof main.on !== 'function') return;
    const onFocus = () => {
      this.flashing = false;
    };
    try {
      main.on('focus', onFocus);
    } catch {
      return;
    }
    this.flashWin = main;
    this.unwatchFocus = () => {
      try {
        if (typeof main.removeListener === 'function') main.removeListener('focus', onFocus);
      } catch {
        /* 窗口正在销毁 */
      }
    };
  }

  #unwatchMainFocus() {
    if (this.unwatchFocus) this.unwatchFocus();
    this.unwatchFocus = null;
    this.flashWin = null;
  }

  #focusMain() {
    const main = this.getMainWindow();
    if (!main || main.isDestroyed()) return;
    try {
      if (main.isMinimized()) main.restore();
      if (!main.isVisible()) main.show();
      // macOS 上弹窗是不激活应用的面板:点「查看」时应用多半不在前台,单靠 focus() 提不上来
      if (process.platform === 'darwin') this.#electron().app.focus({ steal: true });
      main.focus();
    } catch {
      /* 退出过程中窗口可能正在销毁 */
    }
  }
}

module.exports = {
  sanitizePopupPayload,
  popupBounds,
  PopupManager,
  POPUP_LIMITS: {
    width: POPUP_WIDTH,
    margin: EDGE_MARGIN,
    minHeight: MIN_HEIGHT,
    maxHeightRatio: MAX_HEIGHT_RATIO,
    maxIncoming: MAX_INCOMING,
    maxItems: MAX_ITEMS,
    revealFallbackMs: REVEAL_FALLBACK_MS,
    pageReadyTimeoutMs: PAGE_READY_TIMEOUT_MS,
    notifyFallbackMax: NOTIFY_FALLBACK_MAX,
  },
};
