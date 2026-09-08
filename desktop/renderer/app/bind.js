'use strict';
// 事件绑定

// ======================================================================
// 事件绑定
// ======================================================================
function bind() {
  $('banner').addEventListener('click', hideBanner);
  $('btn-parse').addEventListener('click', () => submit(false));
  $('btn-execute').addEventListener('click', () => submit(true));
  $('btn-clear-result').addEventListener('click', () => empty($('result'), '还没有解析结果。'));
  $('btn-refresh').addEventListener('click', () => {
    refreshStatus();
    loadRecords();
    loadPending();
  });

  $('instruction').addEventListener('keydown', (e) => {
    // Ctrl+Enter 解析;Ctrl+Shift+Enter 解析并发送(走同一个确认框)
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(e.shiftKey);
    if (e.key === 'Escape' && closeRecordDetail()) e.preventDefault();
  });

  // 期权速记:点一下把片段插到光标处。片段与提示词的既定偏好同源,
  // 界面绝不发明解析器不认识的写法——这里只是把已经生效的默认值摆到眼前。
  document.querySelectorAll('#shorthand-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const box = $('instruction');
      const snippet = chip.dataset.snippet || '';
      const start = box.selectionStart != null ? box.selectionStart : box.value.length;
      const end = box.selectionEnd != null ? box.selectionEnd : box.value.length;
      // 追加到句尾时,整句片段前补换行;逗号开头的补充片段原样接上
      const atTail = start === box.value.length;
      const sep = atTail && box.value && !box.value.endsWith('\n') && !snippet.startsWith(',') ? '\n' : '';
      box.setRangeText(sep + snippet, start, end, 'end');
      box.focus();
    });
  });
  // 说明默认收起(片段本身常驻一行,不用展开也能点);手动打开过就记住
  const shorthand = document.getElementById('shorthand-panel');
  if (shorthand) {
    try {
      if (localStorage.getItem('dafri.shorthand.closed') === '0') shorthand.open = true;
    } catch { /* localStorage 不可用就保持默认展开 */ }
    shorthand.addEventListener('toggle', () => {
      try { localStorage.setItem('dafri.shorthand.closed', shorthand.open ? '0' : '1'); } catch { /* 同上 */ }
    });
  }

  $('btn-halt').addEventListener('click', async () => {
    try {
      if (state.breakerEngaged) {
        await window.dafri.resume();
        pushNotification('已解除熔断');
      } else {
        const result = await window.dafri.halt('用户在界面上按下暂停');
        pushNotification('已熔断', `撤销未成交单 ${result.cancelled ?? 0} 笔`);
      }
      await refreshStatus();
    } catch (err) {
      showBanner(`操作失败:${err.message}`, false);
    }
  });

  $('btn-connect').addEventListener('click', async () => {
    const btn = $('btn-connect');
    btn.disabled = true;
    try {
      if (state.connected) {
        await window.dafri.disconnectBroker();
        pushNotification(`已断开 ${gatewayName()} 连接`);
      } else {
        const result = await window.dafri.connectBroker();
        const failed = Object.entries(result.failed || {});
        if (result.connected.length) pushNotification('已连接', result.connected.join('、'));
        if (failed.length) showBanner(`部分连接失败:${failed.map(([k, v]) => `${k}(${v})`).join(';')}`, false);
      }
      await refreshStatus();
    } catch (err) {
      showBanner(`连接失败:${err.message}`, false);
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-llm-test').addEventListener('click', testLlm);
  $('btn-llm-save').addEventListener('click', saveLlm);
  $('btn-llm-save-key').addEventListener('click', saveLlmKey);

  $('btn-tws-scan').addEventListener('click', scanTws);
  $('btn-tws-diagnose').addEventListener('click', diagnoseTws);
  $('btn-tws-connect').addEventListener('click', () => $('btn-connect').click());

  $('btn-tracker-refresh').addEventListener('click', () => loadTracker(true));
  $('btn-futu-scan').addEventListener('click', loadFutu);
  $('btn-futu-diagnose').addEventListener('click', diagnoseFutu);
  $('btn-futu-connect').addEventListener('click', () => $('btn-connect').click());
  $('btn-futu-save-password').addEventListener('click', saveFutuPassword);
  $('btn-futu-unlock').addEventListener('click', unlockFutu);

  $('record-filter').addEventListener('input', renderRecords);
  document.getElementById('record-density').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-density]');
    if (!btn) return;
    state.recordDensity = btn.dataset.density;
    localStorage.setItem('dafri-record-density', state.recordDensity);
    renderRecords();
  });
  $('btn-save-settings').addEventListener('click', saveSettings);

  $('btn-idea-add').addEventListener('click', addIdea);
  $('idea-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addIdea();
  });
  $('btn-ideas-active').addEventListener('click', () => {
    state.ideaFilter = 'active';
    syncIdeaFilterButtons();
    loadIdeas();
  });
  $('btn-ideas-all').addEventListener('click', () => {
    state.ideaFilter = 'all';
    syncIdeaFilterButtons();
    loadIdeas();
  });
  $('btn-ideas-digest').addEventListener('click', digestIdeas);

  document.querySelectorAll('#theme-picker [data-theme-mode]').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeMode));
  });
  applyUpDown(localStorage.getItem('dafri-updown') || 'green-up');
  document.querySelectorAll('#updown-picker [data-updown]').forEach((btn) => {
    btn.addEventListener('click', () => applyUpDown(btn.dataset.updown));
  });

  $('bt-strategy').addEventListener('change', renderBacktestParams);
  $('btn-bt-run').addEventListener('click', runBacktest);
  $('btn-book-load').addEventListener('click', addBookSymbol);
  $('book-symbol').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addBookSymbol();
  });
  $('btn-book-refresh-all').addEventListener('click', refreshAllBooks);

  $('btn-alert-add').addEventListener('click', addAlertWatch);
  $('alert-sound').checked = sound.enabled;
  $('alert-sound').addEventListener('change', () => {
    sound.enabled = $('alert-sound').checked;
    localStorage.setItem('dafri-alert-sound', sound.enabled ? '1' : '0');
    if (sound.enabled) playAlertTone('up');   // 打开时响一声,确认真的能出声
  });
  $('btn-alert-test').addEventListener('click', () => {
    playAlertTone('down');
    setTimeout(() => playAlertTone('up'), 500);
  });
  $('alert-symbol').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addAlertWatch();
  });

  $('btn-pa-run').addEventListener('click', submitPa);
  $('btn-review-run').addEventListener('click', () => runReview());
  $('btn-review-refresh').addEventListener('click', () => loadReviewCandidates());
  $('review-include-local').addEventListener('change', () => loadReviewCandidates());
  $('review-record').addEventListener('change', () => {
    review.selected = $('review-record').value;
    localStorage.setItem('dafri-review-record', review.selected);
  });
  $('pa-symbol').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPa();
  });
  $('pa-timeframe').addEventListener('change', submitPa);
  $('pa-rth').addEventListener('change', submitPa);
  $('bt-inst-type').addEventListener('change', () => {
    $('bt-inst-params').classList.toggle('hidden', $('bt-inst-type').value === 'stock');
    renderStrategyFlow();
  });
  for (const id of ['bt-inst-dte', 'bt-inst-offset', 'bt-inst-width', 'bt-inst-risk']) {
    $(id).addEventListener('input', renderStrategyFlow);
  }

  $('btn-sector-add').addEventListener('click', addSector);
  bindScreener();
  $('sector-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addSector();
  });
  $('btn-sectors-refresh').addEventListener('click', refreshSectorQuotes);

  $('btn-export').addEventListener('click', async () => {
    try {
      const target = await window.dafri.pickExportPath();
      if (!target) return;
      const result = await window.dafri.exportData(target);
      showBanner(`已导出 ${result.records} 条记录到 ${result.path}`, true);
    } catch (err) {
      showBanner(`导出失败:${err.message}`, false);
    }
  });

  $('btn-restart-engine').addEventListener('click', async () => {
    await window.dafri.restartEngine();
    setTimeout(() => {
      refreshStatus();
      loadAbout();
    }, 1200);
  });

  // 方向键在侧栏里走动:tablist 的标准交互,不这样做键盘用户只能一路 Tab 穿过去
  document.querySelector('.sidebar').addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const tabs = [...document.querySelectorAll('.sidebar .tab')];
    const here = tabs.indexOf(document.activeElement);
    const next = step === 'first' ? 0
      : step === 'last' ? tabs.length - 1
      : (here + step + tabs.length) % tabs.length;
    tabs[next].focus();
    tabs[next].click();
  });

  /**
   * 切页。两层导航:侧栏 12 项里「行情」「接入」是合并页(data-default 指向默认子页),
   * 子页在页头的分段控件里切;子页按钮和侧栏项都是 .tab[data-tab],所以
   * `querySelector('.tab[data-tab="tws"]').click()` 这种跳转在合并之后照样能用。
   */
  function activateTab(name) {
    const tab = document.querySelector(`.tab[data-tab="${name}"]`);
    if (!tab) return;
    if (tab.dataset.default) {
      // 合并页:回到上次看的那个子页
      let sub = null;
      try { sub = localStorage.getItem(`dafri-subtab-${name}`); } catch { /* 不可用就用默认 */ }
      activateTab(sub && document.querySelector(`.tab[data-tab="${sub}"]`) ? sub : tab.dataset.default);
      return;
    }
    const panel = $(`tab-${name}`);
    if (panel.classList.contains('page-section')) {
      // 页内的一节(价位提醒住在板块页里):切到那一页,再滚到这一节
      activateTab(panel.closest('.tab-panel').id.slice(4));
      panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const container = panel.classList.contains('sub-panel') ? panel.closest('.tab-panel') : null;
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
      t.tabIndex = -1;                 // 只让当前项进 Tab 序列,这是 tablist 的规矩
    });
    document.querySelectorAll('.tab-panel, .sub-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    tab.tabIndex = 0;
    panel.classList.add('active');
    let sideTab = tab;
    if (container) {
      container.classList.add('active');
      const parent = container.id.slice(4);
      sideTab = document.querySelector(`.sidebar .tab[data-tab="${parent}"]`);
      if (sideTab) { sideTab.classList.add('active'); sideTab.setAttribute('aria-selected', 'true'); sideTab.tabIndex = 0; }
      try { localStorage.setItem(`dafri-subtab-${parent}`, name); } catch { /* 同上 */ }
    }
    // 目标在折叠着的组里(快捷键 / 就绪清单跳过来):把组展开,不然选中项看不见
    const group = sideTab && sideTab.closest('.sidebar-items');
    if (group && group.hasAttribute('data-collapsed')) setSidebarGroup(group.dataset.group, true);

    auto.last[name] = Date.now();  // 切页时已手动加载,自动刷新从现在起算
    if (name === 'about') loadAbout();
    if (name === 'settings') loadSettings();
    // 切回主页面时把光标放回输入框:这是整个软件唯一的主动作,
    // 每次都要用鼠标点一下才能打字是白白多出来的一步
    if (name === 'trade') $('instruction').focus();
    if (name === 'tws') { scanTws(); loadBrokerSwitch(); }
    if (name === 'futu') loadFutu();
    if (name === 'llm') loadLlm();
    if (name === 'board') { loadPending(); loadRecords(); }
    if (name === 'ideas') loadIdeas();
    if (name === 'review') loadReviewCandidates();
    if (name === 'sectors') { loadSectors(true); loadAlerts(); }
    if (name === 'rs' || name === 'inflection' || name === 'deviation') loadScreenerSectors(name);
    if (name === 'backtest' && !bt.strategies.length) loadBacktestStrategies();
    if (name === 'book') renderBookGrid();
    if (name === 'tracker') loadTracker(true);
    if (name === 'pa') { loadPaTimeframes(); renderPa(); }
    if (name === 'alerts') loadAlerts();
  }
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });
  // Ctrl/⌘ + 1…9:按侧栏顺序切页(Mail / Finder 都有);输入框里也生效,因为这组键没有别的含义
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const n = Number(e.key);
    if (!(n >= 1 && n <= 9)) return;
    const tabs = [...document.querySelectorAll('.sidebar .tab[data-tab]')];
    if (!tabs[n - 1]) return;
    e.preventDefault();
    activateTab(tabs[n - 1].dataset.tab);
  });
  // 窗口失焦时侧栏选中项退成灰(AppKit 的源列表就是这样);窄窗口只剩图标时给项加悬停名字
  window.dafri.on('window', ({ focused }) => document.documentElement.toggleAttribute('data-window-blur', !focused));
  const narrow = window.matchMedia('(max-width: 1000px)');
  const syncNarrow = () => document.querySelectorAll('.sidebar .nav-item').forEach((t) => {
    if (narrow.matches) t.title = t.textContent.trim().replace(/\s*\d+$/, ''); else t.removeAttribute('title');
  });
  narrow.addEventListener('change', syncNarrow);
  syncNarrow();
  // 页内分段控件里左右方向键切子页
  document.querySelectorAll('.subnav').forEach((nav) => {
    nav.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const tabs = [...nav.querySelectorAll('.tab')];
      const here = Math.max(0, tabs.indexOf(document.activeElement));
      const next = tabs[(here + step + tabs.length) % tabs.length];
      next.focus();
      next.click();
    });
  });

  // 侧栏分组可折叠:状态记在本地。折叠只是收起来,不影响任何跳转——目标在折叠组里时会自动展开
  function setSidebarGroup(key, open) {
    const head = document.querySelector(`.sidebar-group[data-group="${key}"]`);
    const items = document.querySelector(`.sidebar-items[data-group="${key}"]`);
    if (!head || !items) return;
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) items.removeAttribute('data-collapsed'); else items.setAttribute('data-collapsed', '');
    try { localStorage.setItem(`dafri-sidegroup-${key}`, open ? '1' : '0'); } catch { /* 同上 */ }
  }
  document.querySelectorAll('.sidebar-group[data-group]').forEach((head) => {
    const key = head.dataset.group;
    let saved = null;
    try { saved = localStorage.getItem(`dafri-sidegroup-${key}`); } catch { /* 同上 */ }
    if (saved === '0' && !document.querySelector(`.sidebar-items[data-group="${key}"] .tab.active`)) setSidebarGroup(key, false);
    head.addEventListener('click', () => setSidebarGroup(key, head.getAttribute('aria-expanded') !== 'true'));
  });

  window.dafri.on('engine-event', ({ event, data }) => {
    if (event === 'notification') {
      pushNotification(data.title, data.body);
    } else if (event === 'breaker') {
      refreshStatus();
    } else if (event === 'alerts') {
      alerts.feed = [...(data.events || []), ...alerts.feed].slice(0, 50);
      renderAlerts();
    } else if (event === 'pending') {
      loadPending();
      loadRecords();
    } else if (event === 'settings') {
      loadSettings();
    } else if (event === 'llm') {
      loadLlm();
    } else if (event === 'ready') {
      setEngineDot(true);
      refreshStatus();
    } else if (event === 'error') {
      showBanner(data.message, false);
    }
  });

  window.dafri.on('engine-log', ({ line }) => {
    const log = $('engine-log');
    log.textContent = (log.textContent + '\n' + line).split('\n').slice(-200).join('\n');
  });

  window.dafri.on('engine-exit', ({ detail }) => {
    setEngineDot(false);
    showBanner(`交易引擎已退出:${detail}。可在「关于」里重启。`, false);
  });

  window.dafri.on('menu', ({ action }) => {
    if (action === 'refresh') {
      refreshStatus();
      loadRecords();
      loadPending();
    }
  });
}
