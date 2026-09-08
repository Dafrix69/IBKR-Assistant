'use strict';
// 自动刷新与启动

// ======================================================================
// 自动刷新:只刷当前页,行情类页面要求 TWS 已连接,上一轮未完成绝不叠加
// ======================================================================
const auto = { last: {}, running: new Set() };

const AUTO_TASKS = {
  board: { every: 15_000, fn: async () => { await loadPending(); await loadRecords(); } },
  records: { every: 15_000, fn: loadRecords },
  ideas: { every: 60_000, fn: loadIdeas },
  sectors: { every: 30_000, fn: refreshSectorQuotes, needBroker: true },
  book: { every: 20_000, fn: refreshAllBooks, needBroker: true },
  pa: { every: 20_000, fn: () => fetchPa(false), needBroker: true },
  // 持仓的现价与盈亏要跟着行情走:在追踪页时每 5 秒重读一次持仓(引擎侧是低优先级请求)
  tracker: { every: 5_000, fn: () => loadTracker(true), needBroker: true },
};

function startAutoRefresh() {
  setInterval(async () => {
    // 合并页里侧栏项和子页按钮同时是 active,自动刷新按子页(叶子)算
    const tab = document.querySelector('.tab.active:not([data-default])')?.dataset.tab;
    const task = AUTO_TASKS[tab];
    if (!task || auto.running.has(tab)) return;
    if (task.needBroker && !state.connected) return;
    if (Date.now() - (auto.last[tab] || 0) < task.every) return;
    auto.running.add(tab);
    try {
      await task.fn();
    } catch (err) {
      console.warn('自动刷新失败', tab, err);
    } finally {
      auto.last[tab] = Date.now();
      auto.running.delete(tab);
    }
  }, 5_000);
}

async function boot() {
  // macOS 之外没有 vibrancy 底材,半透明面板背后是空的 —— 换成实底
  document.documentElement.dataset.vibrancy =
    window.dafri.platform === 'darwin' ? 'on' : 'off';
  // 窗口按钮在哪一侧、系统字体是哪一套,都由它决定
  document.documentElement.dataset.platform = window.dafri.platform;
  syncPlatformLabels();
  bind();
  bindPrimers();
  applyTheme(localStorage.getItem('dafri-theme') || 'system');
  await refreshStatus();
  await Promise.all([
    loadSettings(), loadRecords(), loadPending(), scanTws(), loadLlm(), loadIdeas(), loadSectors(false),
  ]);

  // 开机即可打字。主输入框是这个软件的入口,不该让人先找一下鼠标。
  $('instruction').focus();

  setInterval(refreshStatus, 5000);
  startAutoRefresh();
  loadAlerts();
  // 这两个轮询**不看当前在哪一页**:切走了还得盯。
  // 警告切走了不报就没用了;持仓追踪更甚——止损是用来保命的。
  setInterval(pollAlerts, 10_000);
  loadTracker(false);
  // 1 秒一轮:0DTE 蝶的价格几秒就能走完一个档位,8 秒的判断间隔会让"回撤 30% 就平"
  // 变成"回撤到 45% 才发现"。单轮不重绘持仓表单、有 busy 防重入、没有追踪时直接跳过,
  // 所以频率提上来不会把 RPC(单线程)压垮。
  setInterval(pollTrackers, 1_000);
  setInterval(reconcileHosted, 1_000);
  loadMacroBoard();
  startMacroRefresh();   // 连了 TWS 走 2 秒,没连回落 60 秒
  // 方式 B 盯盘:连接着且有排队订单时才轮询,避免空转
  setInterval(async () => {
    if (!state.connected || !state.status || !state.status.pending_count) return;
    try {
      await window.dafri.pollPending();
    } catch {
      /* 单次轮询失败不打断界面 */
    }
  }, 10000);
}

boot();
