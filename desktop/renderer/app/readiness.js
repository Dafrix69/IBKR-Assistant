'use strict';
// 就绪检查表

// ======================================================================
// 就绪检查表:三个前置条件,缺哪个说哪个,并给出去哪修
// ======================================================================
function readinessSteps() {
  const st = state.status || {};
  const keyed = state.llmKeyConfigured;      // loadLlm 里刷新
  return [
    {
      done: keyed !== false,                 // 还没查过就先不报红,别吓人
      title: '配置大模型 API Key',
      todo: '没有 Key 无法解析指令。Key 存于系统凭据库,不落配置文件。',
      ok: '已配置',
      tab: 'llm',
      action: '去配置',
    },
    {
      done: Boolean(st.broker_connected),
      title: `连接${gatewayName()}`,
      todo: '没有券商连接只能解析,不能下单,也拿不到行情。',
      ok: '已连接',
      tab: st.broker_provider === 'futu' ? 'futu' : 'tws',
      action: '去连接',
    },
    {
      done: Boolean(st.auto_execute),
      title: '打开自动执行',
      todo: '当前「仅解析」,校验通过也不发单。确认要下单再打开。',
      ok: '已打开',
      tab: 'settings',
      action: '去设置',
      optional: true,                        // 关着不算"没准备好",是一种合理选择
    },
  ];
}

function renderReadiness() {
  const box = document.getElementById('readiness');
  if (!box) return;
  const steps = readinessSteps();
  const blocking = steps.filter((s) => !s.done && !s.optional);
  // 必要条件都满足就收起来:它是状态提示,不是常驻装饰
  if (!blocking.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  clear(box);
  box.appendChild(el('div', 'readiness-head', `还差 ${blocking.length} 步才能开始`));
  box.appendChild(el('div', 'readiness-sub',
    '未完成项会挡住解析或下单,点右侧按钮前往。'));

  for (const step of steps) {
    const row = el('div', `readiness-step ${step.done ? 'done' : 'todo'}`);
    row.appendChild(el('span', 'readiness-mark', step.done ? '✓' : '!'));
    const text = el('div', 'readiness-text');
    text.appendChild(el('b', null, step.title));
    text.appendChild(el('span', null, step.done ? step.ok : step.todo));
    row.appendChild(text);
    if (!step.done) {
      const go = el('button', 'btn tiny', step.action);
      go.addEventListener('click', () => document.querySelector(`.tab[data-tab="${step.tab}"]`).click());
      row.appendChild(go);
    }
    box.appendChild(row);
  }
}

/**
 * 参考资料的默认展开状态:**需要它的时候才展开**。
 *
 * 手动点过一次就记住用户的选择,不再自动改——自动化可以帮忙猜第一次,
 * 但不该反复推翻用户的手动操作。
 */
function syncPrimer(id, shouldOpen) {
  const box = document.getElementById(id);
  if (!box) return;
  if (localStorage.getItem(`dafri-primer-${id}`) !== null) return;   // 用户表过态了
  box.open = shouldOpen;
}

function bindPrimers() {
  document.querySelectorAll('.primer').forEach((box) => {
    box.addEventListener('toggle', () => {
      localStorage.setItem(`dafri-primer-${box.id}`, box.open ? '1' : '0');
    });
    const saved = localStorage.getItem(`dafri-primer-${box.id}`);
    if (saved !== null) box.open = saved === '1';
  });
}

function gatewayName() {
  return state.status && state.status.broker_provider === 'futu' ? 'OpenD' : 'TWS';
}

function brokerPanel() {
  return state.status && state.status.broker_provider === 'futu' ? '「富途 OpenD」' : '「TWS 连接」';
}

/** 把「发送」按钮不能点的原因写进 tooltip。禁用而不说明原因是最招人烦的一种交互。 */
function syncExecuteHint(status) {
  const btn = $('btn-execute');
  if (!btn) return;
  const blockers = [];
  if (!status.auto_execute) blockers.push('自动执行未打开');
  if (!status.broker_connected) blockers.push(`未连接 ${gatewayName()}`);
  if (status.breaker && status.breaker.engaged) blockers.push('已熔断');
  btn.title = blockers.length ? `不能发送:${blockers.join('、')}` : '解析通过后直接发送给券商';
}

function renderStatus(status) {
  // 时间和市场时段合成一格:时间之所以要看,正是因为它决定了现在是盘前还是盘中。
  // 只留时分——秒在这里没有任何决策价值,却让这一格每秒都在跳。
  const market = $('chip-market');
  const hhmm = String(status.now_et || '').slice(11, 16);
  market.textContent = `${status.market_status} ${hhmm} 美东`;
  market.className = 'chip ' + (status.market_status === '盘中' ? 'ok' : 'warn');
  market.title = `美东时间 ${status.now_et}`;

  // 模型是配置不是状态:去掉前缀、收窄,完整名进 tooltip
  const model = $('chip-model');
  model.textContent = String(status.model || '—').replace(/^claude-/, '');
  model.title = `解析用的模型:${status.model}`;

  const broker = $('chip-broker');
  // 网关名跟着生效的券商走:两家都连本机端口,顶栏只写「已连接」的话,
  // 切过券商之后根本看不出单子会从哪条通道出去
  const gateway = gatewayName();
  // 三态,不是两态:socket 连着但网关没有上游时,行情请求会石沉大海,
  // 显示成「已连接」会让人一直等一个永远不来的结果
  const upstreamDown = status.broker_connected && status.broker_upstream_ok === false;
  broker.textContent = upstreamDown
    ? `${gateway} 上游中断`
    : status.broker_connected ? `${gateway} 已连接` : `${gateway} 未连接`;
  broker.className = 'chip ' + (upstreamDown ? 'warn' : status.broker_connected ? 'ok' : '');
  broker.title = upstreamDown
    ? `${gateway} 与券商服务器断连:本机连得上 ${gateway},但行情无回应。等待自动重连或检查网络。`
    : '';
  $('btn-connect').textContent = status.broker_connected ? `断开 ${gateway}` : `连接 ${gateway}`;
  syncPlatformLabels();
  renderReadiness();
  // 连上了就把指引收起来;没连上说明正需要它
  syncPrimer('tws-primer', !status.broker_connected);
  syncPrimer('futu-primer', !status.broker_connected);
  syncExecuteHint(status);
  renderAccountPicker();

  const mode = $('chip-mode');
  if (status.breaker.engaged) {
    mode.textContent = '已熔断';
    mode.className = 'chip bad';
  } else if (status.auto_execute) {
    mode.textContent = status.allow_live_trading ? '自动执行(含实盘)' : '自动执行(仅纸面)';
    mode.className = 'chip warn';
  } else {
    mode.textContent = '仅解析';
    mode.className = 'chip';
  }

  $('limits-hint').textContent =
    `单笔 ≤ ${fmtMoney(status.limits.max_order_notional)} USD · 期权 ≤ ${status.limits.max_option_contracts} 张`;

  $('btn-halt').textContent = status.breaker.engaged ? '解除熔断' : '暂停自动执行';
  $('btn-halt').classList.toggle('engaged', !!status.breaker.engaged);
  $('btn-execute').disabled = !status.auto_execute || !status.broker_connected || status.breaker.engaged;
  $('count-pending').textContent = String(status.pending_count);
  updateSidebarBadge(status.pending_count);

  if (status.breaker.engaged) {
    showBanner(`已熔断:${status.breaker.reason || '自动执行已停止'}`, false);
  } else {
    hideBanner();
  }
}


function updateSidebarBadge(count) {
  const badge = $('sidebar-pending');
  if (!badge) return;
  badge.textContent = String(count);
  badge.classList.toggle('hidden', !count);
}

function setEngineDot(ok) {
  $('engine-dot').className = 'dot ' + (ok ? 'ok' : 'bad');
}

let bannerTimer = null;

/**
 * 把一个按钮切到"正在跑"。返回一个复位函数,放进 finally 里调用。
 *
 * 比散在各处的 `btn.disabled = true` 好在两点:转圈让人知道还活着,
 * 而且复位是一个函数,不会漏掉某个分支。
 */
function busy(button) {
  if (!button) return () => {};
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.classList.add('loading');
  return () => {
    button.classList.remove('loading');
    button.disabled = wasDisabled;
  };
}

/** 行内的"正在做某事",和按钮上的转圈是同一种语言。 */
function working(node, message) {
  clear(node);
  node.appendChild(el('span', 'working', message));
}

function showBanner(message, isInfo) {
  const banner = $('banner');
  banner.textContent = message;
  banner.className = 'banner' + (isInfo ? ' info' : '');
  banner.title = '点一下关掉';
  clearTimeout(bannerTimer);
  // 提示类自己走,错误类留着等人看——但两者都点得掉。
  // 永远挂在那里的横幅,过几分钟就没人再看它一眼了。
  if (isInfo) bannerTimer = setTimeout(hideBanner, 6000);
}

function hideBanner() {
  clearTimeout(bannerTimer);
  $('banner').className = 'banner hidden';
}
