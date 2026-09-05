'use strict';
/**
 * 界面逻辑。刻意不用任何框架:CSP 只允许 'self',不加载任何远程脚本。
 *
 * 一条硬规则:**任何来自引擎/模型/用户的文本都只用 textContent 写进 DOM**,
 * 绝不拼 innerHTML。指令原文和模型输出都是不可信内容,界面不该成为它的执行面。
 */

const $ = (id) => document.getElementById(id);

/** 建元素的小工具,天然只走 textContent。 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function empty(node, message) {
  clear(node);
  node.appendChild(el('p', 'empty', message));
}

/** 定点小数,不带千分位——量表里要看清 0.0500 这种小数。 */
function fmtNum(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function fmtMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 列表里的紧凑时间:今天只显示时分,其余显示月-日 时分。年份在这里没有信息量。 */
function fmtTimeShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear()
    && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (sameDay) return hm;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN', { hour12: false });
}

const state = {
  status: null,
  settings: null,
  records: [],
  ideas: [],
  ideaFilter: 'active',
  sectors: [],
  sectorQuotes: {},
  connected: false,
  breakerEngaged: false,
  busy: false,
};

// ======================================================================
// 顶栏与状态
// ======================================================================
const statusPoll = { inFlight: false };

async function refreshStatus() {
  // 引擎 sidecar 串行处理:上一轮没回来就再发,只会在管道里排队。
  // 曾经因为这个攒出 159 个待处理的 system.status,引擎恢复后还要逐个吐完。
  if (statusPoll.inFlight) return;
  statusPoll.inFlight = true;
  try {
    const status = await window.dafri.status();
    state.status = status;
    state.connected = status.broker_connected;
    state.breakerEngaged = status.breaker.engaged;
    renderStatus(status);
    setEngineDot(true);
  } catch (err) {
    setEngineDot(false);
    showBanner(`引擎无响应:${err.message}`, false);
  } finally {
    statusPoll.inFlight = false;
  }
}

// 网关名与面板名跟着生效的券商走。写死"TWS"的文案在富途通道上是错的指引:
// 用户照着去点一个跟他无关的面板,点完还是连不上。
// 快捷键要显示这个平台上真实存在的键。macOS 是 ⌘,Windows / Linux 是 Ctrl——
// 在 Windows 上画一个 ⌘ 等于告诉用户去按一个键盘上没有的键。
const MOD_KEY = navigator.platform.toUpperCase().includes('MAC') ? '⌘' : 'Ctrl+';
const ENTER_KEY = MOD_KEY === '⌘' ? '↩' : 'Enter';

/** 当前券商在界面上的短名。按钮上写"发送到 IBKR"而实际发去富途,是会出事的。 */
function brokerShortName() {
  return state.status && state.status.broker_provider === 'futu' ? '富途' : 'IBKR';
}

/** 顶栏、按钮、提示里那些跟平台或券商绑定的文案,统一在这里刷新。 */
function syncPlatformLabels() {
  const parseKey = document.getElementById('hint-parse-key');
  if (parseKey) {
    parseKey.textContent = `${MOD_KEY}${ENTER_KEY} 解析 · ${MOD_KEY}${
      MOD_KEY === '⌘' ? '⇧' : 'Shift+'}${ENTER_KEY} 发送`;
  }
  const halt = document.getElementById('btn-halt');
  if (halt) halt.title = `${MOD_KEY}${MOD_KEY === '⌘' ? '⇧H' : 'Shift+H'}`;
  const execute = document.getElementById('btn-execute');
  if (execute) execute.textContent = `发送到${brokerShortName()}`;
  const gateway = document.getElementById('hint-gateway');
  if (gateway) gateway.textContent = `已连接 ${gatewayName()}`;
}

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

// ======================================================================
// 指令提交
// ======================================================================
async function submit(execute) {
  const text = $('instruction').value.trim();
  if (!text) return;
  if (state.busy) return;
  const accounts = selectedAccounts();
  if (!accounts.length) {
    showBanner('请至少勾选一个发单账户', false);
    return;
  }

  if (execute) {
    const fanout = accounts.length > 1 ? `同时发到 ${accounts.length} 个账户,每笔订单各一份:` : '目标账户:';
    const ok = await window.dafri.confirm({
      title: '发送真实订单',
      message: `这条指令解析后会直接发送到${brokerShortName()},没有二次确认环节。${fanout}${accounts.join('、')}。`,
      detail: text,
      confirmLabel: '我确认,发送',
    });
    if (!ok) return;
  }

  state.busy = true;
  const restore = busy(execute ? $('btn-execute') : $('btn-parse'));
  $('btn-parse').disabled = true;
  $('btn-execute').disabled = true;
  const result = $('result');
  working(result, execute ? '正在解析并发送…' : '正在解析…(最长约 1 分钟)');

  const t0 = performance.now();
  try {
    const payload = await window.dafri.submit(text, execute, accounts);
    payload.__elapsedMs = Math.round(performance.now() - t0);
    renderResult(payload);
    await Promise.all([refreshStatus(), loadRecords(), loadPending()]);
  } catch (err) {
    clear(result);
    result.appendChild(card('bad', '调用失败', err.message));
  } finally {
    restore();
    state.busy = false;
    $('btn-parse').disabled = false;
    $('btn-execute').disabled = !(state.status && state.status.auto_execute && state.connected && !state.breakerEngaged);
  }
}

// ======================================================================
// 发单账户勾选:勾一个发一个,勾两个每笔各发一份(引擎按账户扇出)
// 只列当前生效券商下的账户——把富途账户勾进 IBKR 的发单里,发出去只会换来券商错误。
// 勾选状态存本地;没存过时默认只勾默认账户,行为与没有这个控件时一致。
// ======================================================================
const ACCOUNT_PICK_KEY = 'dafri-submit-accounts';

function pickableAccounts() {
  const status = state.status;
  if (!status || !Array.isArray(status.accounts)) return [];
  const provider = status.broker_provider || 'ibkr';
  return status.accounts.filter((a) => (a.broker || 'ibkr') === provider);
}

function loadPickedAccounts() {
  try {
    const raw = JSON.parse(localStorage.getItem(ACCOUNT_PICK_KEY) || 'null');
    if (Array.isArray(raw)) return raw.map(String);
  } catch (err) { /* 存坏了就当没存 */ }
  return null;
}

function selectedAccounts() {
  const usable = pickableAccounts();
  if (!usable.length) return [];
  const saved = loadPickedAccounts();
  const aliases = usable.map((a) => a.alias);
  if (saved === null) {
    const def = usable.find((a) => a.default) || usable[0];
    return [def.alias];
  }
  return saved.filter((alias) => aliases.includes(alias));
}

function renderAccountPicker() {
  const picker = $('account-picker');
  const chips = $('account-chips');
  if (!picker || !chips) return;
  const usable = pickableAccounts();
  // 「发送」按钮只在真的会发到实盘账户时才橙字——常态是普通次要按钮,常橙会被读成"一直在警告"
  const pickedNow = new Set(selectedAccounts());
  const liveOn = usable.length < 2
    ? usable.some((a) => !a.is_paper)
    : usable.some((a) => !a.is_paper && pickedNow.has(a.alias));
  const exec = document.getElementById('btn-execute');
  if (exec) exec.classList.toggle('warn', liveOn);
  // 只有一个账户时没什么可选,控件隐藏,行为与以前完全一样
  if (usable.length < 2) {
    picker.hidden = true;
    return;
  }
  const picked = new Set(selectedAccounts());
  clear(chips);
  for (const account of usable) {
    const label = el('label', 'account-chip' + (account.is_paper ? '' : ' live') + (picked.has(account.alias) ? ' checked' : ''));
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = picked.has(account.alias);
    input.addEventListener('change', () => {
      const next = new Set(selectedAccounts());
      if (input.checked) next.add(account.alias); else next.delete(account.alias);
      localStorage.setItem(ACCOUNT_PICK_KEY, JSON.stringify(usable.map((a) => a.alias).filter((x) => next.has(x))));
      renderAccountPicker();
    });
    label.appendChild(input);
    label.appendChild(el('span', null, `${account.alias} · ${account.is_paper ? '纸面' : '实盘'}`));
    label.title = `${account.account_masked} · 连接 ${account.connection}`;
    chips.appendChild(label);
  }
  const hint = $('account-picker-hint');
  const n = picked.size;
  hint.textContent = n > 1
    ? `每笔订单各发 ${n} 份,各自独立校验与记录`
    : n === 1 ? '' : '未勾选账户,无法发单';
  picker.hidden = false;
}

function card(kind, title, body, meta) {
  const node = el('div', `card ${kind}`);
  node.appendChild(el('div', 'card-title', title));
  if (body) node.appendChild(el('div', null, body));
  if (meta && meta.length) {
    const metaNode = el('div', 'card-meta');
    meta.forEach((item) => metaNode.appendChild(el('span', null, item)));
    node.appendChild(metaNode);
  }
  return node;
}

function renderResult(payload, target) {
  const box = target || $('result');
  clear(box);

  const groups = [
    ['ok', '已提交', payload.submitted],
    ['info', '排队等待触发', payload.queued],
    ['warn', '已通过校验(未发送)', payload.validated_only],
  ];

  for (const [kind, label, items] of groups) {
    for (const item of items || []) {
      const meta = [`账户 ${item.account || '—'}`];
      if (item.notional !== undefined) meta.push(`敞口 ≈ ${fmtMoney(item.notional)} USD`);
      if (item.order_id) meta.push(`订单号 ${item.order_id}`);
      if (item.mode) meta.push(item.mode === 'software_watch' ? '软件盯盘(AUTO_MID)' : item.mode);
      box.appendChild(card(kind, `${label} · ${item.intent_summary || ''}`, null, meta));
    }
  }

  for (const rejection of payload.rejections || []) {
    const source = { llm: '模型拒绝', validator: '校验拒绝', broker: '券商错误' }[rejection.source] || '拒绝';
    const node = card('bad', `${source} · ${rejection.code}`, rejection.message);
    if (rejection.original_text || rejection.intent_summary) {
      node.appendChild(el('div', 'reason', rejection.original_text || rejection.intent_summary));
    }
    box.appendChild(node);
  }

  if (payload.warnings && payload.warnings.length) {
    const node = card('warn', '提示', null);
    const list = el('ul');
    payload.warnings.forEach((w) => list.appendChild(el('li', null, w)));
    node.appendChild(list);
    box.appendChild(node);
  }

  if (payload.llm) {
    // 本地速记命中时不显示 token 用量——根本没调大模型,显示 0 tokens 反而让人疑惑
    const local = payload.llm.model === 'local-shorthand';
    const elapsed = payload.__elapsedMs != null ? `全链路 ${payload.__elapsedMs} ms` : null;
    const meta = local
      ? [`语法 ${payload.llm.model}`, '毫秒级本地解析,规则与 AI 同一套校验']
      : [
        `模型 ${payload.llm.model}`,
        `提示词 ${payload.llm.prompt_version}`,
        `模型 ${payload.llm.latency_ms} ms`,
        `in ${payload.llm.usage?.input_tokens ?? '—'} / out ${payload.llm.usage?.output_tokens ?? '—'} tokens`,
      ];
    if (elapsed) meta.push(elapsed);
    box.appendChild(
      card('info', local ? '本次解析 · 本地秒解(未经大模型)' : '本次解析', null, meta)
    );
  }

  if (!box.children.length) empty(box, '没有解析出任何订单。');
}

// ======================================================================
// 订单看板
// ======================================================================
async function loadPending() {
  try {
    const { pending } = await window.dafri.listPending();
    const box = $('pending-list');
    $('count-pending').textContent = String(pending.length);
    updateSidebarBadge(pending.length);
    if (!pending.length) return empty(box, '没有等待触发的条件单。');
    clear(box);
    for (const item of pending) {
      box.appendChild(
        card('info', item.intent_summary, null, [
          `${item.symbol} ${item.operator} ${item.value}`,
          `账户 ${item.account}`,
          `入队 ${fmtTimeShort(item.created_at)}`,
        ])
      );
    }
  } catch (err) {
    empty($('pending-list'), `读取失败:${err.message}`);
  }
}

// 终态在库里是英文枚举(append-only 的既有词表,不动它),但直接摆给用户看
// 既不好读、又带着券商名:富途用户看到 ibkr_error 会以为软件连错了地方。
// 所以只在渲染这一层翻译。
const FINAL_STATUS_LABEL = {
  filled: '已成交',
  partially_filled: '部分成交',
  cancelled: '已撤单',
  expired_untriggered: '当日未触发',
  rejected_by_validator: '校验拒绝',
  rejected_by_llm: '模型拒绝',
  ibkr_error: '券商报错',
  halted_by_breaker: '熔断拦下',
};

// 在途状态来自券商,是英文枚举(Submitted / PreSubmitted / …)。终态翻了、
// 在途没翻的话,同一列里会中英夹杂——而这一列恰恰是最常扫的一列。
const LIVE_STATUS_LABEL = {
  PendingSubmit: '待发送',
  PreSubmitted: '已受理',
  Submitted: '已挂单',
  ApiPending: '发送中',
  PendingCancel: '撤单中',
  Filled: '已成交',
  Cancelled: '已撤单',
  ApiCancelled: '已撤单',
  Inactive: '券商报错',
  Unknown: '状态未知',
};

function statusLabel(record, fallback) {
  const final = record.final_status;
  if (final) return FINAL_STATUS_LABEL[final] || final;
  if (record.status) return LIVE_STATUS_LABEL[record.status] || record.status;
  return fallback;
}

function renderLive(records) {
  const box = $('live-list');
  const live = records.filter((r) => r.status && !r.rejection).slice(0, 8);
  $('count-live').textContent = String(live.length);
  if (!live.length) return empty(box, '今天还没有提交过订单。');
  clear(box);
  for (const record of live) {
    const kind = record.final_status === 'filled' ? 'ok' : record.final_status ? 'warn' : 'info';
    const meta = [
      `${record.action || ''} ${record.quantity ?? ''} ${record.symbol}`,
      `账户 ${record.account}`,
      statusLabel(record, '—'),
    ];
    if (record.avg_fill_price) meta.push(`均价 ${fmtMoney(record.avg_fill_price)}`);
    box.appendChild(card(kind, record.intent_summary || record.raw_instruction, null, meta));
  }
}

// ======================================================================
// 交易记录
// ======================================================================
async function loadRecords() {
  try {
    const { records } = await window.dafri.listRecords(60);
    state.records = records;
    renderRecords();
    renderLive(records);
  } catch (err) {
    empty($('records'), `读取失败:${err.message}`);
  }
}

// 状态筛选的分档。刻意不按 final_status 的枚举一一列出——用户想的是
// "成了 / 还挂着 / 没发出去",不是 rejected_by_validator 和 rejected_by_llm 的区别。
const RECORD_FILTERS = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'filled', label: '已成交', match: (r) => r.final_status === 'filled' || r.final_status === 'partially_filled' },
  { key: 'live', label: '进行中', match: (r) => !r.final_status },
  { key: 'rejected', label: '被拒', match: (r) => String(r.final_status || '').startsWith('rejected') },
  { key: 'failed', label: '出错', match: (r) => r.final_status === 'ibkr_error' || r.final_status === 'halted_by_breaker' },
];

function renderRecordFilters(counts) {
  const box = document.getElementById('record-tabs');
  if (!box) return;
  clear(box);
  for (const f of RECORD_FILTERS) {
    const n = counts[f.key] || 0;
    const btn = el('button', state.recordFilter === f.key ? 'on' : null, f.label);
    btn.appendChild(el('span', 'n', String(n)));
    btn.setAttribute('aria-pressed', state.recordFilter === f.key ? 'true' : 'false');
    // 一条都没有的档位点了也是空的,先拦住——省掉一次白点
    btn.disabled = n === 0 && f.key !== 'all';
    btn.addEventListener('click', () => {
      state.recordFilter = f.key;
      renderRecords();
    });
    box.appendChild(btn);
  }
}

/** 舒适 / 紧凑。选择记在本地,下次打开还是上次那个。 */
function applyRecordDensity() {
  const box = $('records');
  const mode = state.recordDensity || localStorage.getItem('dafri-record-density') || 'cozy';
  state.recordDensity = mode;
  box.classList.toggle('compact', mode === 'compact');
  document.querySelectorAll('#record-density button').forEach((b) => {
    const on = b.dataset.density === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function renderRecords() {
  const box = $('records');
  applyRecordDensity();
  const keyword = $('record-filter').value.trim().toLowerCase();
  state.recordFilter = state.recordFilter || 'all';

  // 每档的条数按**关键词过滤之后**的集合算,否则筛选条会承诺一些点不出来的结果
  const byKeyword = state.records.filter((r) => {
    if (!keyword) return true;
    return [r.symbol, r.reason, r.final_status, r.intent_summary, r.raw_instruction, r.account]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(keyword));
  });
  const counts = {};
  for (const f of RECORD_FILTERS) counts[f.key] = byKeyword.filter(f.match).length;
  renderRecordFilters(counts);

  const active = RECORD_FILTERS.find((f) => f.key === state.recordFilter) || RECORD_FILTERS[0];
  const rows = byKeyword.filter(active.match);

  if (!rows.length) {
    return empty(box, keyword || state.recordFilter !== 'all'
      ? '没有符合条件的记录。' : '暂无记录。');
  }
  clear(box);

  for (const record of rows) {
    const node = el('div', 'record');
    node.tabIndex = 0;

    const head = el('div', 'record-head');
    const sym = el('span', 'record-sym', record.symbol || '—');
    if (record.action) {
      sym.appendChild(el('span', `side ${record.action === 'BUY' ? 'buy' : 'sell'}`,
        ACTION_LABEL[record.action] || record.action));
    }
    head.appendChild(sym);

    const statusText = statusLabel(record, '进行中');
    const statusClass = record.final_status === 'filled'
      ? 'filled'
      : String(record.final_status || '').startsWith('rejected')
        ? 'rejected'
        : 'pending';
    head.appendChild(el('span', `status ${statusClass}`, statusText));
    node.appendChild(head);

    const intent = el('div', 'rec-intent', record.intent_summary || record.raw_instruction || '');
    intent.title = record.intent_summary || record.raw_instruction || '';
    node.appendChild(intent);
    if (record.reason) node.appendChild(el('div', 'reason', record.reason));

    const meta = el('div', 'card-meta');
    const when = el('span', null, fmtTimeShort(record.created_at));
    when.title = fmtTime(record.created_at);      // 完整时间放 tooltip,不占列宽
    meta.appendChild(when);
    if (record.account) {
      const tag = el('span', `tag ${record.is_paper ? 'paper' : 'live'}`,
        `${record.account} ${record.account_masked || ''}`);
      meta.appendChild(tag);
    }
    if (record.notional_estimate) meta.appendChild(el('span', null, `≈ ${fmtMoney(record.notional_estimate)} USD`));
    node.appendChild(meta);

    node.addEventListener('click', () => showRecordDetail(record.id));
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') showRecordDetail(record.id);
    });
    box.appendChild(node);
  }
}

async function showRecordDetail(id) {
  const detail = $('record-detail');
  detail.className = 'detail';
  clear(detail);
  detail.appendChild(el('p', 'muted', '加载中…'));
  try {
    const { record } = await window.dafri.getRecord(id);
    clear(detail);
    if (!record) {
      detail.appendChild(el('p', 'empty', '这条记录已经不在了'));
      return;
    }
    renderRecordDetail(detail, record);
    state.openDetail = detail;
    detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (err) {
    clear(detail);
    detail.appendChild(el('p', 'empty', `读取失败:${err.message}`));
  }
}

// 内部枚举 → 人话。查不到就原样显示:露一个英文,好过编一个错的中文。
const SEC_TYPE_LABEL = { STK: '股票', OPT: '期权', BAG: '组合(多腿)', IND: '指数' };
const ACTION_LABEL = { BUY: '买入', SELL: '卖出' };
const ORDER_TYPE_LABEL = {
  MKT: '市价单', LMT: '限价单', STP: '止损单',
  'STP LMT': '止损限价单', TRAIL: '跟踪止损单',
};
const PRICE_MODE_LABEL = { EXPLICIT: '指定价格', AUTO_MID: '盘口中间价(AUTO_MID)' };
const TIF_LABEL = { DAY: '当日有效', GTC: '撤销前有效' };
const COMBO_LABEL = { VERTICAL: '垂直价差', BUTTERFLY: '蝴蝶', IRON_CONDOR: '铁鹰' };

function say(map, value) {
  if (value === null || value === undefined || value === '') return null;
  return map[value] || value;
}

/** 'YYYYMMDD' → 'YYYY-MM-DD'。到期日在合约里是紧凑格式,直接摆出来很难读。 */
function fmtExpiry(v) {
  const t = String(v || '').trim();
  return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}` : (t || null);
}

/** 详情里的一个小节。空的小节直接不画——留一堆"—"只会让人以为坏了。 */
function detailSection(title, rows) {
  const live = rows.filter((r) => r[1] !== null && r[1] !== undefined && r[1] !== '');
  if (!live.length) return null;
  const box = el('div', 'detail-section');
  box.appendChild(el('h4', null, title));
  const grid = el('dl', 'detail-grid');
  for (const [k, v] of live) {
    grid.appendChild(el('dt', null, k));
    grid.appendChild(el('dd', null, String(v)));
  }
  box.appendChild(grid);
  return box;
}

function renderRecordDetail(box, record) {
  const head = el('div', 'detail-head');
  head.appendChild(el('strong', null,
    `${record.contract?.symbol || '—'} · ${record.order?.action || ''} ${record.order?.totalQuantity ?? ''}`));
  const status = record.final_status
    ? (FINAL_STATUS_LABEL[record.final_status] || record.final_status)
    : '进行中';
  head.appendChild(el('span', `status ${record.final_status === 'filled' ? 'filled'
    : String(record.final_status || '').startsWith('rejected') ? 'rejected' : 'pending'}`, status));
  const close = el('button', 'btn tiny ghost', '收起');
  close.addEventListener('click', () => closeRecordDetail());
  head.appendChild(close);
  box.appendChild(head);

  if (record.error_detail) box.appendChild(card('bad', '失败原因', record.error_detail));
  if ((record.contract || {}).combo_strategy === 'BUTTERFLY') {
    const go = el('button', 'btn tiny', '分析这笔交易');
    go.addEventListener('click', () => openReviewFor(record.id));
    head.insertBefore(go, close);
  }

  const c = record.contract || {};
  const o = record.order || {};
  const ib = record.ibkr || {};
  const sections = [
    detailSection('这笔单', [
      ['意图', (record.llm || {}).intent_summary],
      ['原指令', (record.input || {}).raw_instruction],
      ['理由', (record.input || {}).reason],
      ['账户', `${(record.account || {}).alias || ''} ${(record.account || {}).account_masked || ''}`.trim()],
      ['提交时间', fmtTime(record.created_at)],
    ]),
    detailSection('合约', [
      ['类型', say(SEC_TYPE_LABEL, c.secType)],
      ['标的', c.symbol],
      ['到期日', fmtExpiry(c.lastTradeDateOrContractMonth)],
      ['行权价', c.strike],
      ['方向', c.right === 'C' ? '看涨 Call' : c.right === 'P' ? '看跌 Put' : null],
      ['组合', say(COMBO_LABEL, c.combo_strategy)],
      ['腿数', c.legs ? c.legs.length : null],
    ]),
    detailSection('订单', [
      ['买卖', say(ACTION_LABEL, o.action)],
      ['类型', say(ORDER_TYPE_LABEL, o.orderType)],
      ['数量', o.totalQuantity],
      ['限价', o.lmtPrice],
      ['触发价', o.auxPrice],
      ['定价方式', say(PRICE_MODE_LABEL, o.price_mode)],
      ['有效期', say(TIF_LABEL, o.tif)],
      ['盘前盘后', o.outsideRth === undefined ? null : (o.outsideRth ? '允许' : '不允许')],
      ['券商单号', ib.order_id],
    ]),
    detailSection('成交', [
      ['均价', ib.avg_fill_price != null ? fmtMoney(ib.avg_fill_price) : null],
      ['手续费', ib.total_commission != null ? fmtMoney(ib.total_commission) : null],
      ['已实现盈亏', ib.realized_pnl != null ? fmtMoney(ib.realized_pnl) : null],
    ]),
    detailSection('模型', [
      ['模型', (record.llm || {}).model],
      ['提示词版本', (record.llm || {}).prompt_version],
      ['置信度', (record.llm || {}).confidence],
      ['token', (record.llm || {}).usage
        ? `入 ${(record.llm.usage.input_tokens ?? '?')} / 出 ${(record.llm.usage.output_tokens ?? '?')}`
        : null],
    ]),
  ].filter(Boolean);
  sections.forEach((sec) => box.appendChild(sec));

  // 状态时间线:这是"从提交到终态"那条链,竖着排比塞进键值对里清楚得多
  const timeline = ib.status_timeline || [];
  if (timeline.length) {
    const sec = el('div', 'detail-section');
    sec.appendChild(el('h4', null, '状态时间线'));
    const list = el('ol', 'timeline');
    for (const step of timeline) {
      const li = el('li');
      li.appendChild(el('b', null, LIVE_STATUS_LABEL[step.status] || step.status || '—'));
      li.appendChild(el('span', null, fmtTime(step.at)));
      list.appendChild(li);
    }
    sec.appendChild(list);
    box.appendChild(sec);
  }

  const fills = ib.fills || [];
  if (fills.length) {
    const sec = el('div', 'detail-section');
    sec.appendChild(el('h4', null, `成交明细(${fills.length} 笔)`));
    const table = el('table', 'detail-table');
    const head2 = el('tr');
    ['时间', '数量', '价格', '手续费'].forEach((h) => head2.appendChild(el('th', null, h)));
    table.appendChild(head2);
    for (const f of fills) {
      const tr = el('tr');
      tr.appendChild(el('td', null, fmtTimeShort(f.time)));
      tr.appendChild(el('td', null, String(f.qty ?? '—')));
      tr.appendChild(el('td', null, f.price != null ? fmtMoney(f.price) : '—'));
      tr.appendChild(el('td', null, f.commission != null ? fmtMoney(f.commission) : '—'));
      table.appendChild(tr);
    }
    sec.appendChild(table);
    box.appendChild(sec);
  }

  for (const w of record.post_warnings || []) {
    box.appendChild(card('warn', '提醒', w.message || ''));
  }

  // 原始 JSON 不删,只是收起来:这个项目在意可审计性,那份原文要留得住
  const raw = el('details', 'detail-raw');
  raw.appendChild(el('summary', null, '原始记录(JSON)'));
  raw.appendChild(el('pre', null, JSON.stringify(record, null, 2)));
  box.appendChild(raw);
}

function closeRecordDetail() {
  const detail = $('record-detail');
  if (!detail || detail.classList.contains('hidden')) return false;
  detail.classList.add('hidden');
  state.openDetail = null;
  return true;
}

// ======================================================================
// 想法备忘
// ======================================================================
async function loadIdeas() {
  try {
    const status = state.ideaFilter === 'all' ? undefined : state.ideaFilter;
    const { ideas } = await window.dafri.listIdeas(status);
    state.ideas = ideas;
    renderIdeas();
  } catch (err) {
    empty($('ideas-list'), `读取失败:${err.message}`);
  }
  loadIdeaDigests(); // 不阻塞想法列表;失败只记 console
}

const IDEA_STATUS_LABEL = { active: '进行中', done: '已完成', archived: '已归档' };

function renderIdeas() {
  const box = $('ideas-list');
  if (!state.ideas.length) {
    return empty(box, state.ideaFilter === 'active' ? '还没有进行中的想法。' : '还没有想法。');
  }
  clear(box);

  for (const idea of state.ideas) {
    const node = el('div', 'record');

    const head = el('div', 'record-head');
    head.appendChild(el('span', 'record-sym', (idea.symbols || []).join(' · ') || '想法'));
    head.appendChild(
      el(
        'span',
        `status ${idea.status === 'active' ? 'pending' : idea.status === 'done' ? 'filled' : 'rejected'}`,
        IDEA_STATUS_LABEL[idea.status] || idea.status
      )
    );
    node.appendChild(head);

    node.appendChild(el('div', null, idea.text));

    const meta = el('div', 'card-meta');
    const ideaWhen = el('span', null, fmtTimeShort(idea.created_at));
    ideaWhen.title = fmtTime(idea.created_at);
    meta.appendChild(ideaWhen);
    node.appendChild(meta);

    if (idea.analysis) node.appendChild(renderIdeaAnalysis(idea.analysis));

    const actions = el('div', 'row tight');
    if (idea.status === 'active') {
      const analyze = el('button', 'btn tiny primary', idea.analysis ? 'AI 重新分析' : 'AI 分析');
      analyze.addEventListener('click', () => analyzeIdea(idea, analyze));
      actions.appendChild(analyze);

      const send = el('button', 'btn tiny', '发到解析');
      send.addEventListener('click', () => {
        $('instruction').value = idea.text;
        document.querySelector('.tab[data-tab="trade"]').click();
        $('instruction').focus();
      });
      actions.appendChild(send);

      const done = el('button', 'btn tiny ghost', '完成');
      done.addEventListener('click', () => setIdeaStatus(idea.id, 'done'));
      actions.appendChild(done);

      const archive = el('button', 'btn tiny ghost', '归档');
      archive.addEventListener('click', () => setIdeaStatus(idea.id, 'archived'));
      actions.appendChild(archive);
    } else {
      const restore = el('button', 'btn tiny ghost', '恢复为进行中');
      restore.addEventListener('click', () => setIdeaStatus(idea.id, 'active'));
      actions.appendChild(restore);
    }
    node.appendChild(actions);
    box.appendChild(node);
  }
}

const BRIEF_LABELS = [
  ['last', '现价', ''],
  ['chg_1d_pct', '1日', '%'],
  ['chg_20d_pct', '20日', '%'],
  ['chg_60d_pct', '60日', '%'],
  ['rsi14', 'RSI14', ''],
  ['vs_sma50_pct', '对50日线', '%'],
  ['vs_sma200_pct', '对200日线', '%'],
  ['vol20_annual_pct', '年化波动', '%'],
  ['from_52w_high_pct', '距52周高', '%'],
];

function renderIdeaAnalysis(analysis) {
  const box = el('div', 'result');
  const node = card('info', `AI 分析 · ${analysis.summary || ''}`);

  // 行情事实(代码计算)与 AI 叙事分开标注,别混为一谈
  if (analysis.brief && !analysis.brief.error) {
    const facts = BRIEF_LABELS
      .filter(([key]) => analysis.brief[key] != null)
      .map(([key, label, unit]) => `${label} ${analysis.brief[key]}${unit}`)
      .join(' · ');
    if (facts) {
      node.appendChild(el('div', 'stock-sub', `${analysis.symbol || ''} 行情(代码计算):${facts}`));
    }
    const anchor = analysis.brief.anchor;
    if (anchor) {
      const chg = anchor.chg_from_anchor_pct;
      node.appendChild(
        el('div', 'stock-sub',
          `价格锚点:${anchor.label} = ${anchor.price}${chg != null ? ` · 现价较锚点 ${chg >= 0 ? '+' : ''}${chg}%` : ''}`)
      );
    }
  } else if (analysis.brief && analysis.brief.error) {
    node.appendChild(el('div', 'stock-sub', `行情获取失败:${analysis.brief.error}`));
  } else if (analysis.symbol) {
    node.appendChild(el('div', 'stock-sub', '分析时未连接券商网关,无行情情报'));
  }

  if (analysis.thesis) node.appendChild(el('div', null, `逻辑:${analysis.thesis}`));

  const addList = (title, items) => {
    if (!items || !items.length) return;
    node.appendChild(el('div', null, title));
    const list = el('ul');
    items.forEach((item) => list.appendChild(el('li', null, item)));
    node.appendChild(list);
  };
  addList('下单前先核实:', analysis.checks);
  addList('风险:', analysis.risks);
  if (analysis.suggestion) node.appendChild(el('div', 'reason', `建议:${analysis.suggestion}`));

  const meta = el('div', 'card-meta');
  if (analysis.model) meta.appendChild(el('span', null, `模型 ${analysis.model}`));
  if (analysis.analyzed_at) {
    const at = el('span', null, `分析于 ${fmtTimeShort(analysis.analyzed_at)}`);
    at.title = fmtTime(analysis.analyzed_at);
    meta.appendChild(at);
  }
  meta.appendChild(el('span', null, '仅供参考,不构成投资建议'));
  node.appendChild(meta);
  box.appendChild(node);
  return box;
}

async function analyzeIdea(idea, button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '分析中…';
  try {
    await window.dafri.analyzeIdea(idea.id);
    await loadIdeas();
  } catch (err) {
    showBanner(`AI 分析失败:${err.message}`, false);
    button.disabled = false;
    button.textContent = original;
  }
}

async function setIdeaStatus(id, status) {
  try {
    await window.dafri.updateIdea(id, status);
    await loadIdeas();
  } catch (err) {
    showBanner(`更新想法失败:${err.message}`, false);
  }
}

async function addIdea() {
  const input = $('idea-input');
  const text = input.value.trim();
  if (!text) return;
  try {
    await window.dafri.addIdea(text);
    input.value = '';
    state.ideaFilter = 'active';
    syncIdeaFilterButtons();
    await loadIdeas();
  } catch (err) {
    showBanner(`记录想法失败:${err.message}`, false);
  }
}

function syncIdeaFilterButtons() {
  $('btn-ideas-active').className = state.ideaFilter === 'active' ? 'btn tiny' : 'btn tiny ghost';
  $('btn-ideas-all').className = state.ideaFilter === 'all' ? 'btn tiny' : 'btn tiny ghost';
}

// ---- 想法知识总结:归档不是丢弃,攒起来的想法能一键提炼成知识,总结历史落库可回看
async function loadIdeaDigests() {
  try {
    const { digests } = await window.dafri.listIdeaDigests();
    state.ideaDigests = digests || [];
    renderIdeaDigests();
  } catch (err) {
    console.warn('读取知识总结失败', err);
  }
}

function renderIdeaDigests() {
  const box = $('idea-digest-box');
  clear(box);
  const digests = state.ideaDigests || [];
  if (!digests.length) return;

  const latest = digests[0];
  const d = latest.digest || {};
  const node = card('info', `知识总结 · ${d.summary || ''}`);

  const addList = (title, items) => {
    if (!items || !items.length) return;
    node.appendChild(el('div', null, title));
    const list = el('ul');
    items.forEach((item) => list.appendChild(el('li', null, item)));
    node.appendChild(list);
  };
  addList('反复出现的主题:', d.themes);
  addList('经验教训:', d.lessons);
  addList('想法质量的规律:', d.patterns);
  addList('下一步:', d.actions);

  const meta = el('div', 'card-meta');
  meta.appendChild(el('span', null, `基于 ${latest.idea_count} 条想法`));
  if (d.model) meta.appendChild(el('span', null, `模型 ${d.model}`));
  const at = el('span', null, `总结于 ${fmtTimeShort(latest.created_at)}`);
  at.title = fmtTime(latest.created_at);
  meta.appendChild(at);
  if (digests.length > 1) meta.appendChild(el('span', null, `共 ${digests.length} 次总结,新的在上`));
  meta.appendChild(el('span', null, '仅供复盘参考,不构成投资建议'));
  node.appendChild(meta);
  box.appendChild(node);
}

async function digestIdeas() {
  const button = $('btn-ideas-digest');
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '总结中…';
  try {
    await window.dafri.digestIdeas('all');   // 已归档 + 已完成一起看,规律才完整
    await loadIdeaDigests();
  } catch (err) {
    showBanner(`知识总结失败:${err.message}`, false);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// ======================================================================
// 自定义板块 + AI 选股
// ======================================================================
async function loadSectors(withQuotes) {
  try {
    const { sectors } = await window.dafri.listSectors();
    state.sectors = sectors;
    renderSectors();
    if (withQuotes) await refreshSectorQuotes();
  } catch (err) {
    empty($('sectors-list'), `读取失败:${err.message}`);
  }
}

async function refreshSectorQuotes() {
  try {
    const { connected, quotes } = await window.dafri.sectorQuotes();
    state.sectorQuotes = quotes || {};
    renderSectors();
    if (!connected && state.sectors.some((s) => s.stocks.length)) {
      showBanner(`行情需要先在${brokerPanel()}面板连接引擎`, true);
    }
  } catch (err) {
    showBanner(`刷新板块行情失败:${err.message}`, false);
  }
}

function renderSectors() {
  const box = $('sectors-list');
  if (!state.sectors.length) {
    return empty(box, '还没有板块。输入一个主题试试,比如「AI 算力」。');
  }
  clear(box);

  for (const sector of state.sectors) {
    const node = el('div', 'sector-card');

    const head = el('div', 'record-head');
    head.appendChild(el('span', 'record-sym', `${sector.name}(${sector.stocks.length})`));
    const actions = el('span', 'row tight');
    const pick = el('button', 'btn tiny', sector.stocks.length ? 'AI 重新选股' : 'AI 选股');
    pick.addEventListener('click', () => pickSector(sector.id, pick));
    actions.appendChild(pick);
    const del = el('button', 'btn tiny ghost', '删除');
    del.addEventListener('click', () => deleteSector(sector.id, sector.name));
    actions.appendChild(del);
    head.appendChild(actions);
    node.appendChild(head);

    if (!sector.stocks.length) {
      node.appendChild(el('p', 'muted', '还没有成分股:点「AI 选股」生成,或在下面手动添加。'));
    } else {
      // 卡片内滚动:股票多时不撑破卡片,滚动查看
      const stocksBox = el('div', 'sector-stocks');
      for (const stock of sector.stocks) {
        const row = el('div', 'stock-row');
        row.appendChild(el('span', 'stock-sym', stock.symbol));

        // 行内只放核心竞争点(简短);公司名进悬停提示,不占行宽
        const core = stock.reason !== '手动添加' ? stock.reason : '';
        const sub = el('span', 'stock-sub', core || stock.company || '');
        const tipParts = [stock.company, core].filter(Boolean);
        if (tipParts.length) sub.title = tipParts.join('\n');
        row.appendChild(sub);

        const quote = state.sectorQuotes[stock.symbol];
        if (quote && quote.last != null) {
          row.appendChild(el('span', 'stock-price', fmtMoney(quote.last)));
          if (quote.change_pct != null) {
            const up = quote.change_pct >= 0;
            row.appendChild(
              el('span', `status ${up ? 'filled' : 'rejected'}`,
                `${up ? '+' : ''}${quote.change_pct.toFixed(2)}%`)
            );
          }
        } else {
          row.appendChild(el('span', 'muted', '—'));
        }

        const remove = el('button', 'btn tiny ghost', '移除');
        remove.addEventListener('click', () => removeSectorStock(sector.id, stock.symbol));
        row.appendChild(remove);
        stocksBox.appendChild(row);
      }
      node.appendChild(stocksBox);
      const upd = el('div', 'card-meta', `更新于 ${fmtTimeShort(sector.updated_at)} · AI 结果仅供参考`);
      upd.title = fmtTime(sector.updated_at);
      node.appendChild(upd);
    }

    const addRow = el('div', 'row tight');
    const addInput = el('input');
    addInput.type = 'text';
    addInput.className = 'grow';
    addInput.placeholder = '手动添加,如 NVDA';
    addInput.maxLength = 12;
    const addBtn = el('button', 'btn tiny', '添加');
    const doAdd = () => addSectorStock(sector.id, addInput);
    addBtn.addEventListener('click', doAdd);
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doAdd();
    });
    addRow.appendChild(addInput);
    addRow.appendChild(addBtn);
    node.appendChild(addRow);

    box.appendChild(node);
  }
}

// ======================================================================
// 策略回测(纯计算展示;历史数据来自 TWS)
// ======================================================================
const bt = {
  strategies: [],
  // 自定义策略的条件(默认给一组 RSI 超卖示例,进页面就能看懂结构)
  rules: {
    entry: [{ left: { kind: 'indicator', name: 'rsi', period: 14 }, op: '<', right: { kind: 'const', value: 30 } }],
    exit: [{ left: { kind: 'indicator', name: 'rsi', period: 14 }, op: '>', right: { kind: 'const', value: 70 } }],
  },
};

const BT_INDICATORS = [
  ['close', '收盘价'], ['open', '开盘价'], ['high', '最高价'], ['low', '最低价'],
  ['sma', 'SMA均线'], ['ema', 'EMA均线'], ['rsi', 'RSI'],
  ['highest', '前N日最高'], ['lowest', '前N日最低'], ['change_pct', 'N日涨跌幅%'],
  ['const', '常数'],
];
const BT_NEEDS_PERIOD = new Set(['sma', 'ema', 'rsi', 'highest', 'lowest', 'change_pct']);
const BT_OPS = [['>', '>'], ['<', '<'], ['>=', '≥'], ['<=', '≤'], ['cross_up', '上穿'], ['cross_down', '下穿']];
const BT_INST_LABELS = {
  stock: '正股', call: '买入看涨期权', put: '买入看跌期权',
  call_spread: '看涨借方价差', put_spread: '看跌借方价差', butterfly: '买入蝴蝶',
};

async function loadBacktestStrategies() {
  try {
    const { strategies } = await window.dafri.backtestStrategies();
    bt.strategies = strategies;
    if (!$('bt-end').value) {
      const today = new Date();
      $('bt-end').value = today.toISOString().slice(0, 10);
      $('bt-start').value = new Date(today.getTime() - 365 * 86400e3).toISOString().slice(0, 10);
    }
    const select = $('bt-strategy');
    clear(select);
    for (const s of strategies) {
      const opt = el('option', null, s.label);
      opt.value = s.key;
      select.appendChild(opt);
    }
    renderBacktestParams();
  } catch (err) {
    showBanner(`读取策略目录失败:${err.message}`, false);
  }
}

function currentStrategy() {
  return bt.strategies.find((s) => s.key === $('bt-strategy').value) || null;
}

function renderBacktestParams() {
  const box = $('bt-params');
  clear(box);
  const strategy = currentStrategy();
  if (!strategy) return;
  $('bt-strategy-desc').textContent = strategy.desc || '';

  if (strategy.key === 'custom') {
    renderRuleBuilder(box);
    renderStrategyFlow();
    return;
  }
  const labels = strategy.param_labels || {};
  for (const [key, value] of Object.entries(strategy.params)) {
    const row = el('div', 'field-row');
    // 认得出就用中文名,认不出退回原名——总比显示 "参数 buy_below" 强
    const label = el('label', null, labels[key] || key);
    if (labels[key]) label.appendChild(el('span', 'sub', key));
    row.appendChild(label);
    const input = el('input');
    input.type = 'number';
    input.value = String(value);
    input.dataset.paramKey = key;
    row.appendChild(input);
    box.appendChild(row);
  }
  renderStrategyFlow();
}

// ---- 自定义策略:图形化条件搭建器 + 文字生成 ----------------------------
function renderRuleBuilder(box) {
  // 文字输入:自然语言 → 条件(由外接大模型转换,结构再过软件层校验)
  const aiRow = el('div', 'row tight');
  const aiInput = el('input');
  aiInput.type = 'text';
  aiInput.className = 'grow';
  aiInput.id = 'bt-rule-text';
  aiInput.placeholder = '用文字描述,如:RSI跌破30且收盘价高于200日均线时买入,RSI回到70卖出';
  aiInput.maxLength = 1000;
  const aiBtn = el('button', 'btn tiny primary', 'AI 生成条件');
  aiBtn.addEventListener('click', () => generateRulesFromText(aiBtn));
  aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') generateRulesFromText(aiBtn);
  });
  aiRow.appendChild(aiInput);
  aiRow.appendChild(aiBtn);
  box.appendChild(aiRow);

  box.appendChild(ruleSection('入场条件(全部满足才买入)', bt.rules.entry, 'entry'));
  box.appendChild(ruleSection('出场条件(全部满足才卖出;留空 = 持有到区间结束)', bt.rules.exit, 'exit'));
}

function ruleSection(title, conditions, kind) {
  const wrap = el('div', 'group');
  wrap.appendChild(el('div', 'muted', title));
  conditions.forEach((cond, index) => {
    const row = el('div', 'row tight');
    row.appendChild(operandEditor(cond.left));

    const opSelect = el('select');
    for (const [value, label] of BT_OPS) {
      const opt = el('option', null, label);
      opt.value = value;
      opSelect.appendChild(opt);
    }
    opSelect.value = cond.op;
    opSelect.addEventListener('change', () => {
      cond.op = opSelect.value;
      renderStrategyFlow();
    });
    const opWrap = el('span', 'select-wrap');
    opWrap.appendChild(opSelect);
    row.appendChild(opWrap);

    row.appendChild(operandEditor(cond.right));

    const remove = el('button', 'btn tiny ghost', '✕');
    remove.addEventListener('click', () => {
      bt.rules[kind].splice(index, 1);
      renderBacktestParams();
    });
    row.appendChild(remove);
    wrap.appendChild(row);
  });

  const add = el('button', 'btn tiny', '+ 添加条件');
  add.addEventListener('click', () => {
    bt.rules[kind].push({
      left: { kind: 'indicator', name: 'close' },
      op: '>',
      right: { kind: 'indicator', name: 'sma', period: 50 },
    });
    renderBacktestParams();
  });
  wrap.appendChild(add);
  return wrap;
}

function operandEditor(operand) {
  const span = el('span', 'row tight');

  const select = el('select');
  for (const [value, label] of BT_INDICATORS) {
    const opt = el('option', null, label);
    opt.value = value;
    select.appendChild(opt);
  }
  select.value = operand.kind === 'const' ? 'const' : operand.name || 'close';
  const selWrap = el('span', 'select-wrap');
  selWrap.appendChild(select);
  span.appendChild(selWrap);

  const num = el('input');
  num.type = 'number';
  num.style.width = '76px';

  const sync = () => {
    const choice = select.value;
    if (choice === 'const') {
      operand.kind = 'const';
      delete operand.name;
      delete operand.period;
      num.placeholder = '数值';
      num.value = operand.value != null ? String(operand.value) : '';
      num.style.display = '';
    } else {
      operand.kind = 'indicator';
      operand.name = choice;
      delete operand.value;
      if (BT_NEEDS_PERIOD.has(choice)) {
        num.placeholder = '周期';
        if (!operand.period) operand.period = 20;
        num.value = String(operand.period);
        num.style.display = '';
      } else {
        delete operand.period;
        num.style.display = 'none';
      }
    }
  };
  select.addEventListener('change', () => {
    sync();
    renderStrategyFlow();
  });
  num.addEventListener('input', () => {
    const value = Number(num.value);
    if (operand.kind === 'const') operand.value = value;
    else operand.period = value;
    renderStrategyFlow();
  });
  sync();
  span.appendChild(num);
  return span;
}

// ---- 策略流程图(moomoo 风格卡片流,随表单实时生成)----------------------
function fmtRuleOperand(o) {
  return o.kind === 'const'
    ? String(o.value)
    : `${(BT_INDICATORS.find(([k]) => k === o.name) || [o.name, o.name])[1]}${o.period ? `(${o.period})` : ''}`;
}

function fmtRuleCond(c) {
  return `${fmtRuleOperand(c.left)} ${(BT_OPS.find(([k]) => k === c.op) || [c.op, c.op])[1]} ${fmtRuleOperand(c.right)}`;
}

function flowCard(kind, title, body) {
  const node = el('div', `flow-card ${kind}`);
  node.appendChild(el('div', 'flow-title', title));
  if (body) node.appendChild(el('div', 'flow-body', body));
  return node;
}

function flowArrow(label) {
  return el('span', 'flow-arrow', label ? `—${label}→` : '→');
}

function renderStrategyFlow() {
  const box = $('bt-flow');
  if (!box) return;
  clear(box);
  const strategy = currentStrategy();
  if (!strategy) return;

  const instType = $('bt-inst-type').value;
  const isOption = instType !== 'stock';
  let entryText, exitText;
  if (strategy.key === 'custom') {
    entryText = bt.rules.entry.map(fmtRuleCond).join(' 且 ') || '(未设置)';
    exitText = bt.rules.exit.length ? bt.rules.exit.map(fmtRuleCond).join(' 且 ') : null;
  } else {
    entryText = strategy.desc;
    exitText = strategy.key === 'buy_hold' ? null : '策略离场信号触发';
  }

  const buyBody = isOption
    ? `${BT_INST_LABELS[instType]} · DTE ${$('bt-inst-dte').value} · 偏移 ${$('bt-inst-offset').value}% · 投入 ${$('bt-inst-risk').value}% 净值`
    : '全仓买入正股(收盘价成交)';

  const row1 = el('div', 'flow-row');
  row1.appendChild(flowCard('start', '开始', '每根日线收盘评估'));
  row1.appendChild(flowArrow());
  row1.appendChild(flowCard('cond', '持仓是否为空?', '持有数量 = 0?'));
  row1.appendChild(flowArrow('是'));
  row1.appendChild(flowCard('cond', '入场条件是否满足?', entryText));
  row1.appendChild(flowArrow('是'));
  row1.appendChild(flowCard('action', '开仓', buyBody));
  box.appendChild(row1);

  const row2 = el('div', 'flow-row');
  row2.appendChild(el('span', 'flow-arrow', '　　　　└—否→'));
  if (exitText) {
    row2.appendChild(flowCard('cond', '出场条件是否满足?', exitText));
    row2.appendChild(flowArrow('是'));
    row2.appendChild(flowCard('action', '平仓', isOption ? '按模型价卖出;到期按内在价值结算' : '全仓卖出(收盘价成交)'));
  } else {
    row2.appendChild(flowCard('action', '继续持有', isOption ? '持有至到期,按内在价值结算' : '持有到区间结束'));
  }
  box.appendChild(row2);
}

async function generateRulesFromText(button) {
  const text = $('bt-rule-text').value.trim();
  if (!text) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '生成中…';
  try {
    const { rules } = await window.dafri.parseBacktestRules(text);
    bt.rules = rules;
    renderBacktestParams();
    $('bt-rule-text').value = text;   // 重渲染后回填描述,方便微调重试
  } catch (err) {
    showBanner(`条件生成失败:${err.message}`, false);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function runBacktest() {
  const symbol = $('bt-symbol').value.trim().toUpperCase();
  const start = $('bt-start').value;
  const end = $('bt-end').value;
  const strategy = $('bt-strategy').value;
  if (!symbol || !start || !end) {
    showBanner('请填写标的与起止日期', true);
    return;
  }
  const params = {};
  document.querySelectorAll('#bt-params input[data-param-key]').forEach((input) => {
    if (input.value !== '') params[input.dataset.paramKey] = Number(input.value);
  });
  const spec = { symbol, start, end, strategy, params };
  if (strategy === 'custom') spec.rules = bt.rules;
  const instType = $('bt-inst-type').value;
  spec.instrument = instType === 'stock'
    ? { type: 'stock' }
    : {
        type: instType,
        dte: Number($('bt-inst-dte').value) || 30,
        offset_pct: Number($('bt-inst-offset').value) || 0,
        width_pct: Number($('bt-inst-width').value) || 2,
        risk_pct: Number($('bt-inst-risk').value) || 10,
      };

  const box = $('bt-result');
  clear(box);
  box.appendChild(el('p', 'muted', '正在拉取历史数据并回测…'));
  $('btn-bt-run').disabled = true;
  try {
    const result = await window.dafri.runBacktest(spec);
    renderBacktestResult(result);
  } catch (err) {
    clear(box);
    box.appendChild(card('bad', '回测失败', err.message));
  } finally {
    $('btn-bt-run').disabled = false;
  }
}

function renderBacktestResult(r) {
  const box = $('bt-result');
  clear(box);

  const beat = r.total_return_pct - r.buy_hold_return_pct;
  const instLabel = r.instrument && r.instrument.type !== 'stock'
    ? ` · ${BT_INST_LABELS[r.instrument.type] || r.instrument.type}(DTE ${r.instrument.dte},投入 ${r.instrument.risk_pct}%)`
    : '';
  const head = card(
    beat >= 0 ? 'ok' : 'warn',
    `${r.symbol} · ${currentStrategy()?.label || r.strategy}${instLabel} · ${r.start} ~ ${r.end}(${r.bars} 根日线)`,
    null,
    [
      `策略收益 ${r.total_return_pct}%`,
      `买入持有 ${r.buy_hold_return_pct}%`,
      `超额 ${beat >= 0 ? '+' : ''}${beat.toFixed(2)}%`,
      `年化 ${r.annualized_pct}%`,
      `最大回撤 ${r.max_drawdown_pct}%`,
      `交易 ${r.trades} 次`,
      r.win_rate_pct != null ? `胜率 ${r.win_rate_pct}%` : '',
      `持仓时间占比 ${r.exposure_pct}%`,
    ].filter(Boolean)
  );
  box.appendChild(head);

  if (r.rules) {
    const rulesCard = card('info', '本次使用的条件');
    const fmtOperand = (o) =>
      o.kind === 'const'
        ? String(o.value)
        : `${(BT_INDICATORS.find(([k]) => k === o.name) || [o.name, o.name])[1]}${o.period ? `(${o.period})` : ''}`;
    const fmtCond = (c) =>
      `${fmtOperand(c.left)} ${(BT_OPS.find(([k]) => k === c.op) || [c.op, c.op])[1]} ${fmtOperand(c.right)}`;
    rulesCard.appendChild(el('div', null, `入场:${r.rules.entry.map(fmtCond).join(' 且 ')}`));
    rulesCard.appendChild(
      el('div', null, r.rules.exit.length ? `出场:${r.rules.exit.map(fmtCond).join(' 且 ')}` : '出场:持有到区间结束')
    );
    box.appendChild(rulesCard);
  }

  box.appendChild(renderEquityCurve(r.curve));

  if (r.trade_list && r.trade_list.length && r.strategy !== 'buy_hold') {
    const tradesCard = card('info', `交易明细(${r.trade_list.length})`);
    const list = el('div', 'sector-stocks');
    for (const t of r.trade_list) {
      const row = el('div', 'stock-row');
      row.appendChild(el('span', 'stock-sub', `${t.entry_date} → ${t.exit_date || '持有中'}`));
      row.appendChild(el('span', 'stock-price', `${fmtMoney(t.entry_price)} → ${fmtMoney(t.exit_price)}`));
      const up = t.return_pct >= 0;
      row.appendChild(el('span', `status ${up ? 'filled' : 'rejected'}`, `${up ? '+' : ''}${t.return_pct}%`));
      list.appendChild(row);
    }
    tradesCard.appendChild(list);
    box.appendChild(tradesCard);
  }

  box.appendChild(
    card('warn', '注意', '收盘价成交、未计滑点与成本、单标的全仓。历史收益不代表未来;参数越漂亮越要怀疑过拟合。')
  );
}

function renderEquityCurve(curve) {
  const node = card('info', '净值曲线(蓝=策略,灰=买入持有,起点=1.0)');
  if (!curve || curve.length < 2) return node;

  const W = 640, H = 160, PAD = 6;
  const values = curve.flatMap((p) => [p.equity, p.bench]);
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i) => PAD + (i / (curve.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const points = (key) => curve.map((p, i) => `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.width = '100%';
  svg.style.height = '160px';

  const baseline = document.createElementNS(NS, 'line');
  baseline.setAttribute('x1', String(PAD));
  baseline.setAttribute('x2', String(W - PAD));
  baseline.setAttribute('y1', String(y(1)));
  baseline.setAttribute('y2', String(y(1)));
  baseline.setAttribute('stroke', 'currentColor');
  baseline.setAttribute('stroke-opacity', '0.2');
  baseline.setAttribute('stroke-dasharray', '3 3');
  svg.appendChild(baseline);

  const bench = document.createElementNS(NS, 'polyline');
  bench.setAttribute('points', points('bench'));
  bench.setAttribute('fill', 'none');
  bench.setAttribute('stroke', 'currentColor');
  bench.setAttribute('stroke-opacity', '0.35');
  bench.setAttribute('stroke-width', '1.2');
  svg.appendChild(bench);

  const eq = document.createElementNS(NS, 'polyline');
  eq.setAttribute('points', points('equity'));
  eq.setAttribute('fill', 'none');
  eq.setAttribute('stroke', THEME.blue);
  eq.setAttribute('stroke-width', '1.6');
  svg.appendChild(eq);

  node.appendChild(svg);
  const first = curve[0], last = curve[curve.length - 1];
  node.appendChild(el('div', 'card-meta', `${first.date} → ${last.date} · 期末净值 策略 ${last.equity} / 基准 ${last.bench}`));
  return node;
}

// ======================================================================
// 全局宏观行情带(公开数据,只读)
// ======================================================================
const macro = { inFlight: false, last: 0 };

async function loadMacroBoard(force) {
  // 引擎 sidecar 是串行的:上一轮没回来就再发,只会排队并把 PA 那边一起拖慢
  if (macro.inFlight) return;
  macro.inFlight = true;
  try {
    const board = await window.dafri.macroBoard(Boolean(force));
    renderMacroStrip(board);
  } catch (err) {
    console.warn('宏观行情读取失败', err);
  } finally {
    macro.inFlight = false;
    macro.last = Date.now();
  }
}

/**
 * 连了 TWS 才值得秒级:那时 6 格走常驻流式订阅,读一次几乎不花时间。
 * 没连时 8 格全走公开数据源,那个端点本身就不是秒级更新的,刷快了只是
 * 反复拿同一个值,还会把自己的 IP 打进限流。
 */
function startMacroRefresh() {
  setInterval(() => {
    const every = state.connected ? 2_000 : 60_000;
    if (Date.now() - macro.last >= every) loadMacroBoard();
  }, 1_000);
}

function fmtMacroValue(row) {
  if (row.last == null) return '—';
  if (row.fmt === 'pct') return `${row.last.toFixed(2)}%`;
  if (row.fmt === 'plain') return row.last.toFixed(2);
  return row.last.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function renderMacroStrip(board) {
  const strip = $('macro-strip');
  clear(strip);
  const rows = board.rows || [];
  // 一个数都没有(刚启动、公开源全部失败)时整条收起:一行 8 个「—」占着 27px,却没有任何信息
  strip.hidden = !rows.some((row) => row.last != null);
  for (const row of rows) {
    const item = el('div', 'macro-item');
    const live = row.source === 'tws';
    item.title = live
      ? `TWS 实时流式,实际读的是 ${row.instrument}(ETF,涨跌幅贴近但绝对价位与指数不同)`
      : '公开数据源,分钟级;VIX 与美债10Y 永远走这条(它们没有不失真的 ETF 替身)';
    item.appendChild(el('span', 'macro-label', row.label));
    // 读的不是指数本身就必须标出来:IBIT 几十美元、比特币几万美元,
    // 不标的话那个数字会让人以为行情崩了
    if (row.instrument) item.appendChild(el('span', 'macro-inst', row.instrument));
    item.appendChild(el('span', `macro-value${live ? ' live' : ''}`, fmtMacroValue(row)));
    if (row.change_pct != null) {
      const dir = row.change_pct > 0 ? 'up' : row.change_pct < 0 ? 'down' : 'flat';
      item.appendChild(
        el('span', `macro-chg ${dir}`, `${row.change_pct > 0 ? '+' : ''}${row.change_pct}%`)
      );
    }
    if (row.stale) item.appendChild(el('span', 'macro-stale', '旧'));
    strip.appendChild(item);
  }
}

// ======================================================================
// 订单簿(多卡片盘口墙,只读展示)
// ======================================================================
const book = {
  symbols: JSON.parse(localStorage.getItem('dafri-book-symbols') || '[]'),
  data: {},     // symbol → snapshot 或 {error}
  loading: new Set(),
};

function saveBookSymbols() {
  localStorage.setItem('dafri-book-symbols', JSON.stringify(book.symbols));
}

async function addBookSymbol() {
  const input = $('book-symbol');
  const symbol = input.value.trim().toUpperCase();
  if (!symbol) return;
  if (book.symbols.includes(symbol)) {
    input.value = '';
    return;
  }
  if (book.symbols.length >= 12) {
    showBanner('订单簿最多同时关注 12 个标的', true);
    return;
  }
  book.symbols.push(symbol);
  saveBookSymbols();
  input.value = '';
  renderBookGrid();
  await loadBook(symbol);
}

function removeBookSymbol(symbol) {
  book.symbols = book.symbols.filter((s) => s !== symbol);
  delete book.data[symbol];
  saveBookSymbols();
  renderBookGrid();
}

async function loadBook(symbol) {
  book.loading.add(symbol);
  renderBookGrid();
  try {
    book.data[symbol] = await window.dafri.orderBook(symbol);
  } catch (err) {
    book.data[symbol] = { error: err.message };
  } finally {
    book.loading.delete(symbol);
    renderBookGrid();
  }
}

async function refreshAllBooks() {
  // 逐个刷:引擎 sidecar 是串行处理的,并发只是排队 + 界面假象
  for (const symbol of [...book.symbols]) {
    await loadBook(symbol);
  }
}

function renderBookGrid() {
  const grid = $('book-grid');
  // 还没关注任何标的时,读盘常识正是这一刻要看的东西;加了标的它就该让路
  syncPrimer('book-primer', !book.symbols.length);
  if (!book.symbols.length) {
    return empty(grid, '还没有关注的标的。上面加一个,比如 SPY 或 NVDA。');
  }
  clear(grid);

  for (const symbol of book.symbols) {
    const node = el('div', 'sector-card');
    const head = el('div', 'record-head');
    head.appendChild(el('span', 'record-sym', symbol));
    const actions = el('span', 'row tight');
    const refresh = el('button', 'btn tiny', book.loading.has(symbol) ? '读取中…' : '刷新');
    refresh.disabled = book.loading.has(symbol);
    refresh.addEventListener('click', () => loadBook(symbol));
    actions.appendChild(refresh);
    const remove = el('button', 'btn tiny ghost', '移除');
    remove.addEventListener('click', () => removeBookSymbol(symbol));
    actions.appendChild(remove);
    head.appendChild(actions);
    node.appendChild(head);

    const snapshot = book.data[symbol];
    if (!snapshot) {
      node.appendChild(el('p', 'muted', book.loading.has(symbol) ? '正在读取盘口…' : '点「刷新」读取盘口。'));
    } else if (snapshot.error) {
      node.appendChild(el('p', 'empty', snapshot.error));
    } else {
      const l1 = snapshot.l1 || {};
      const meta = el('div', 'card-meta');
      if (l1.last != null) meta.appendChild(el('span', null, `最新 ${fmtMoney(l1.last)}`));
      if (l1.spread != null) meta.appendChild(el('span', null, `价差 ${l1.spread}(${l1.spread_bps} bps)`));
      const liq = snapshot.liquidity || {};
      if (liq.spread_grade) meta.appendChild(el('span', null, `流动性 ${liq.spread_grade}`));
      if (liq.bid_depth != null) {
        meta.appendChild(el('span', null, `深度 买${liq.bid_depth} / 卖${liq.ask_depth}`));
      }
      if (liq.imbalance_pct != null) {
        const side = liq.imbalance_pct >= 0 ? '买盘厚' : '卖盘厚';
        meta.appendChild(
          el('span', null, `失衡 ${side} ${Math.abs(liq.imbalance_pct)}%${liq.l1_only ? '(仅一档)' : ''}`)
        );
      }
      node.appendChild(meta);

      const l1row = el('div', 'row tight');
      l1row.appendChild(
        el('span', 'status filled', `买一 ${l1.bid != null ? fmtMoney(l1.bid) : '—'}${l1.bid_size ? ` ×${l1.bid_size}` : ''}`)
      );
      l1row.appendChild(
        el('span', 'status rejected', `卖一 ${l1.ask != null ? fmtMoney(l1.ask) : '—'}${l1.ask_size ? ` ×${l1.ask_size}` : ''}`)
      );
      node.appendChild(l1row);

      const hasDepth = (snapshot.bids && snapshot.bids.length) || (snapshot.asks && snapshot.asks.length);
      if (hasDepth) {
        const depth = el('div', 'book-grid');
        depth.appendChild(bookSide('买盘', (snapshot.bids || []).slice(0, 5), 'bid'));
        depth.appendChild(bookSide('卖盘', (snapshot.asks || []).slice(0, 5), 'ask'));
        node.appendChild(depth);
      }
      if (snapshot.note) node.appendChild(el('div', 'stock-sub', snapshot.note));
    }
    grid.appendChild(node);
  }
}

function bookSide(title, levels, side) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'muted', title));
  const maxSize = Math.max(...levels.map((l) => l.size), 1);
  for (const level of levels) {
    const row = el('div', 'book-row');
    const bar = el('div', `book-bar ${side}`);
    bar.style.width = `${Math.max((level.size / maxSize) * 100, 2)}%`;
    row.appendChild(bar);
    row.appendChild(el('span', 'book-price', fmtMoney(level.price)));
    row.appendChild(el('span', 'book-size', String(level.size)));
    wrap.appendChild(row);
  }
  return wrap;
}

// ======================================================================
// K线 PA:实时 K 线 + 价格行为分析
// 方向判断全部在引擎侧纯代码算完,这里只负责画;界面不做任何二次判断,
// 免得图上写的和引擎算的对不上——那种不一致比看错行情更难查。
// ======================================================================
const pa = {
  timeframes: [],
  symbol: localStorage.getItem('dafri-pa-symbol') || '',
  timeframe: localStorage.getItem('dafri-pa-timeframe') || '5m',
  rth: localStorage.getItem('dafri-pa-rth') === '1',   // 默认全时段
  data: null,
  comment: null,
  error: null,
  loading: false,
};

const PA_BIAS_KIND = {
  bullish: 'ok',
  lean_bull: 'ok',
  bearish: 'bad',
  lean_bear: 'bad',
  neutral: 'warn',
};

const PA_SIDE_LABEL = { bull: '看涨', bear: '看跌', neutral: '中性' };
const NS_SVG = 'http://www.w3.org/2000/svg';

// 图表取色统一走 CSS token(--up/--down/--blue/--orange/--purple),跟随深浅色与「涨跌配色」设置。
// SVG 属性与 canvas 都吃不了 var(),所以每次画图时在这里读一次计算值;主题切换后重画的图自然拿到新值。
// 原来 54 处硬编码的是深色模式的十六进制,浅色模式下绿 #30D158 在白底上对比度不够。
const THEME = {
  read(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#8e8e93';
  },
  get up() { return this.read('--up'); },
  get down() { return this.read('--down'); },
  get blue() { return this.read('--blue'); },
  get orange() { return this.read('--orange'); },
  get purple() { return this.read('--purple'); },
  get green() { return this.read('--green'); },
  get red() { return this.read('--red'); },
};

function svgNode(tag, attrs) {
  const node = document.createElementNS(NS_SVG, tag);
  for (const key of Object.keys(attrs || {})) node.setAttribute(key, String(attrs[key]));
  return node;
}

// ---------------------------------------------------------------- 交易分析(蝴蝶复盘)
const review = {
  candidates: [],
  selected: localStorage.getItem('dafri-review-record') || '',
  timeframe: localStorage.getItem('dafri-review-timeframe') || 'auto',
  data: null,
  error: null,
  loading: false,
};

function reviewCandidateLabel(c) {
  const when = fmtTimeShort(c.created_at);
  const strikes = (c.strikes || []).map((s) => String(s)).join('/');
  const state = c.source === 'ibkr' ? 'IBKR 成交'
    : (c.filled ? '已成交' : (c.final_status ? (FINAL_STATUS_LABEL[c.final_status] || c.final_status) : (c.status || '本地 · 未成交')));
  const price = c.price == null ? '' : ` @ ${c.price}${c.price_estimated ? '(限价)' : ''}`;
  const acct = c.account ? ` · ${c.account}` : '';
  if (c.exit) {
    const pnl = c.exit.pnl == null ? '' : ` · 盈亏 ${c.exit.pnl > 0 ? '+' : ''}${c.exit.pnl}`;
    return `${when} ${c.action === 'BUY' ? '买' : '卖'} @ ${c.price ?? '—'} → ${fmtTimeShort(c.exit.time)} 平 @ ${c.exit.price ?? '—'}${pnl} · ${c.qty} 张 ${c.symbol} ${strikes} ${c.right}蝴蝶 · 到期 ${c.expiry}${acct} · ${state}`;
  }
  return `${when} · ${c.action === 'BUY' ? '买' : '卖'} ${c.qty} ${c.symbol} ${strikes} ${c.right}蝴蝶 · 到期 ${c.expiry}${price}${acct} · ${state} · 未平仓 / 到期`;
}

async function loadReviewCandidates() {
  const select = $('review-record');
  const includeLocal = $('review-include-local').checked;
  let result;
  try {
    result = await window.dafri.reviewCandidates(200, includeLocal);
    review.candidates = result.candidates || [];
  } catch (err) {
    showBanner(`读取成交明细失败:${err.message}`, false);
    return;
  }
  if (!review.data) {
    const bits = [];
    if (result.ibkr_available) bits.push(result.synced == null ? '已连 TWS' : `本次新增 ${result.synced} 笔成交`);
    else bits.push('未连 TWS,只看本地累积的成交');
    bits.push(`库内成交 ${result.fills_stored ?? 0} 笔`);
    $('review-freshness').textContent = bits.join(' · ');
  }
  clear(select);
  if (!review.candidates.length) {
    const option = el('option', null, result.ibkr_available
      ? '今天的成交里没有蝴蝶(TWS 只给当天的;更早的要在连着时同步过才有)'
      : '还没有同步到任何 IBKR 成交:先连接 TWS 再点「同步成交」');
    option.value = '';
    select.appendChild(option);
  }
  for (const c of review.candidates) {
    const option = el('option', null, reviewCandidateLabel(c));
    option.value = c.id;
    select.appendChild(option);
  }
  if (review.candidates.some((c) => c.id === review.selected)) select.value = review.selected;
  else review.selected = select.value || '';
  $('review-timeframe').value = review.timeframe;
  const savedEm = localStorage.getItem('dafri-review-em');
  if (savedEm && !$('review-em').dataset.touched) $('review-em').value = savedEm;
}

/** 从交易记录详情跳过来:选中那一张并直接分析。 */
async function openReviewFor(recordId) {
  review.selected = recordId;
  localStorage.setItem('dafri-review-record', recordId);
  document.querySelector('.tab[data-tab="review"]').click();
  await loadReviewCandidates();
  $('review-record').value = recordId;
  await runReview();
}

async function runReview() {
  const id = $('review-record').value;
  if (!id) {
    showBanner('先选一张蝴蝶', true);
    return;
  }
  review.selected = id;
  review.timeframe = $('review-timeframe').value;
  const em = Number($('review-em').value) || 36;
  localStorage.setItem('dafri-review-record', id);
  localStorage.setItem('dafri-review-timeframe', review.timeframe);
  localStorage.setItem('dafri-review-em', String(em));
  review.loading = true;
  renderReview();
  try {
    review.data = await window.dafri.reviewAnalyze({ id, timeframe: review.timeframe, exit: { em } });
    review.error = null;
  } catch (err) {
    review.data = null;
    review.error = err.message;
  } finally {
    review.loading = false;
    renderReview();
  }
}

function reviewStat(k, v, sign) {
  const node = el('div', 'review-stat');
  node.appendChild(el('div', 'k', k));
  const val = el('div', 'v', v);
  if (sign > 0) val.classList.add('pos');
  if (sign < 0) val.classList.add('neg');
  node.appendChild(val);
  return node;
}

const REVIEW_TONE = { good: 'ok', warn: 'warn', bad: 'bad', info: 'info' };
const REVIEW_KIND = { closed: '已平仓', expired: '已到期', open: '持仓中' };

function renderReview() {
  const box = $('review-result');
  clear(box);
  $('review-freshness').textContent = review.data
    ? `${review.data.timeframe_label} · ${review.data.series.bars.length} 根 · ${REVIEW_KIND[review.data.outcome.kind] || ''}`
    : '—';
  if (review.loading) {
    box.appendChild(el('p', 'empty', '正在拉取 K 线并复盘…'));
    return;
  }
  if (review.error) {
    box.appendChild(card('bad', '分析失败', review.error));
    return;
  }
  const r = review.data;
  if (!r) {
    box.appendChild(el('p', 'empty', '选一张蝴蝶后点「分析」。'));
    return;
  }
  const p = r.profile;
  const z = r.zone;
  const o = r.outcome;
  const s = r.stats;
  const pnl = o.kind === 'open' ? o.pnl_if_expired_now : o.pnl;
  const pnlLabel = o.kind === 'open' ? '若此刻到期' : '盈亏';

  if (r.source === 'local') box.appendChild(card('warn', '这是本地记录,不是券商成交', '这张蝴蝶没有在 IBKR 成交过,下面的权利金按限价、开仓时刻按提交时间估算。'));
  const stats = el('div', 'review-stats');
  stats.appendChild(reviewStat('结构', `${p.symbol} ${p.lower}/${p.center}/${p.upper} ${p.right_label}`, 0));
  stats.appendChild(reviewStat(`权利金${p.price_estimated ? '(估算)' : ''}`, p.debit == null ? '—' : String(p.debit), 0));
  stats.appendChild(reviewStat('盈利区', z.known ? `${z.lower_be} ~ ${z.upper_be}` : '—', 0));
  stats.appendChild(reviewStat('开仓时标的', `${s.entry_underlying}(距中心 ${s.dist_entry > 0 ? '+' : ''}${s.dist_entry})`, 0));
  stats.appendChild(reviewStat(o.kind === 'open' ? '最新标的' : '结局时标的',
    `${s.exit_underlying}(距中心 ${s.dist_exit > 0 ? '+' : ''}${s.dist_exit})`, 0));
  stats.appendChild(reviewStat(pnlLabel, pnl == null ? '—' : `${fmtMoney(pnl)}${o.pnl_pct != null ? ` (${o.pnl_pct}%)` : ''}`,
    pnl == null ? 0 : (pnl > 0 ? 1 : -1)));
  box.appendChild(stats);

  box.appendChild(renderReviewChart(r));
  if (r.exit_plan) {
    box.appendChild(renderFlyChart(r));
    box.appendChild(renderExitPlan(r));
  }

  for (const f of r.findings || []) {
    box.appendChild(card(REVIEW_TONE[f.tone] || 'info', f.title, f.text));
  }

  const detail = detailSection('明细', [
    ['开仓时间(美东)', `${r.entry.time_et}${r.entry.estimated ? '(按提交时间)' : ''}`],
    ['结局', `${REVIEW_KIND[o.kind] || o.kind}${o.time_et ? ' · ' + o.time_et : ''}`],
    ['平仓 / 结算价', o.price == null ? null : String(o.price)],
    ['持有 K 线数', s.hold_bars],
    ['持有期间标的区间', `${s.hold_low} ~ ${s.hold_high}`],
    ['最接近中心', s.closest ? `${s.closest.price}(${s.closest.time},距 ${s.closest.distance})` : null],
    ['盈利区内收盘 K 线', s.in_zone_bars == null ? null : `${s.in_zone_bars}/${s.hold_bars}`],
    ['最好的理论时刻', s.best_theoretical ? `${s.best_theoretical.time} · ${fmtMoney(s.best_theoretical.pnl)}` : null],
    ['最大盈利 / 最大亏损', z.known ? `${fmtMoney(z.max_profit)} / ${fmtMoney(z.max_loss)}` : null],
    ['平仓记录', o.record_id],
  ]);
  if (detail) box.appendChild(detail);

  if ((r.notes || []).length) {
    const ul = el('ul', 'review-notes');
    for (const n of r.notes) ul.appendChild(el('li', null, n));
    box.appendChild(ul);
  }
}

function renderReviewChart(r) {
  const node = card('info', `标的走势(${r.timeframe_label},开仓前后到${REVIEW_KIND[r.outcome.kind] === '持仓中' ? '现在' : '结局'})`);
  const bars = r.series.bars || [];
  if (bars.length < 2) return node;

  const W = 660, H = 300;
  const PAD_L = 6, PAD_R = 62, PAD_T = 10, PAD_B = 16;
  const PRICE_H = H - PAD_T - PAD_B;

  const levels = r.series.levels || [];
  let lo = Math.min(...bars.map((b) => b.low), ...levels.map((l) => l.price));
  let hi = Math.max(...bars.map((b) => b.high), ...levels.map((l) => l.price));
  const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.001 || 1;
  lo -= pad;
  hi += pad;
  const span = hi - lo || 1;

  const slot = (W - PAD_L - PAD_R) / bars.length;
  const x = (i) => PAD_L + slot * (i + 0.5);
  const y = (p) => PAD_T + PRICE_H - ((p - lo) / span) * PRICE_H;
  const at = new Map(bars.map((b, i) => [b.time, i]));
  const rightEdge = W - PAD_R;
  const svg = svgNode('svg', { viewBox: `0 0 ${W} ${H}`, class: 'review-chart' });

  // 盈利区底色
  const lowerBe = levels.find((l) => l.kind === 'lower_be');
  const upperBe = levels.find((l) => l.kind === 'upper_be');
  if (lowerBe && upperBe) {
    svg.appendChild(svgNode('rect', {
      x: PAD_L, y: y(upperBe.price), width: rightEdge - PAD_L,
      height: Math.max(y(lowerBe.price) - y(upperBe.price), 1),
      fill: THEME.up, 'fill-opacity': 0.10,
    }));
  }
  // 止盈策略的临界线(|S−K| 的 0.45W / 0.55W / 0.8W)
  const ZONE_STYLE = { hold: [THEME.blue, '2 3'], half: [THEME.purple, '2 3'], stop: [THEME.down, '1 3'] };
  for (const z of ((r.exit_plan || {}).zones || [])) {
    const st = ZONE_STYLE[z.kind];
    if (!st) continue;
    for (const price of [z.low, z.high]) {
      const py = y(price);
      if (py < PAD_T || py > PAD_T + PRICE_H) continue;
      svg.appendChild(svgNode('line', {
        x1: PAD_L, x2: rightEdge, y1: py, y2: py,
        stroke: st[0], 'stroke-opacity': 0.45, 'stroke-width': 0.8, 'stroke-dasharray': st[1],
      }));
    }
    const label = svgNode('text', { x: PAD_L + 2, y: y(z.high) - 2, 'font-size': 8, fill: st[0], 'fill-opacity': 0.8 });
    label.textContent = `±${z.half_width}`;
    if (y(z.high) >= PAD_T + 8) svg.appendChild(label);
  }

  // 三条行权价
  const LEVEL_STYLE = {
    lower: { color: THEME.orange, dash: '4 3', label: '下翼' },
    center: { color: THEME.blue, dash: '', label: '中心' },
    upper: { color: THEME.orange, dash: '4 3', label: '上翼' },
    lower_be: { color: THEME.up, dash: '2 2', label: '盈亏平衡' },
    upper_be: { color: THEME.up, dash: '2 2', label: '盈亏平衡' },
  };
  for (const level of levels) {
    const st = LEVEL_STYLE[level.kind];
    if (!st) continue;
    const py = y(level.price);
    svg.appendChild(svgNode('line', {
      x1: PAD_L, x2: rightEdge, y1: py, y2: py,
      stroke: st.color, 'stroke-opacity': 0.8, 'stroke-width': level.kind === 'center' ? 1.2 : 1,
      'stroke-dasharray': st.dash,
    }));
    if (level.kind !== 'lower_be' && level.kind !== 'upper_be') {
      const label = svgNode('text', { x: rightEdge + 4, y: py + 3, 'font-size': 9, fill: st.color });
      label.textContent = String(level.price);
      svg.appendChild(label);
    }
  }

  // 蜡烛
  const bodyW = Math.max(slot * 0.6, 1);
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const up = bar.close >= bar.open;
    const color = up ? THEME.up : THEME.down;
    svg.appendChild(svgNode('line', {
      x1: x(i), x2: x(i), y1: y(bar.high), y2: y(bar.low),
      stroke: color, 'stroke-width': Math.min(bodyW * 0.28, 1.1),
    }));
    svg.appendChild(svgNode('rect', {
      x: x(i) - bodyW / 2, y: y(Math.max(bar.open, bar.close)), width: bodyW,
      height: Math.max(Math.abs(y(bar.close) - y(bar.open)), 0.8), fill: color,
    }));
  }

  // 开仓 / 平仓 / 到期 标记:竖线 + 圆点 + 文字
  const MARK = { entry: { color: THEME.blue, label: '开仓' }, exit: { color: THEME.purple, label: '平仓' }, expiry: { color: THEME.purple, label: '到期' } };
  for (const m of r.series.markers || []) {
    if (!at.has(m.time)) continue;
    const i = at.get(m.time);
    const st = MARK[m.kind] || MARK.entry;
    svg.appendChild(svgNode('line', {
      x1: x(i), x2: x(i), y1: PAD_T, y2: PAD_T + PRICE_H,
      stroke: st.color, 'stroke-width': 1, 'stroke-dasharray': '3 3', 'stroke-opacity': 0.8,
    }));
    svg.appendChild(svgNode('circle', { cx: x(i), cy: y(m.price), r: 3, fill: st.color }));
    const label = svgNode('text', {
      x: x(i) + (i > bars.length / 2 ? -4 : 4), y: PAD_T + 10, 'font-size': 9.5,
      'text-anchor': i > bars.length / 2 ? 'end' : 'start', fill: st.color,
    });
    label.textContent = `${st.label} ${m.price}`;
    svg.appendChild(label);
  }

  const first = svgNode('text', { x: PAD_L, y: H - 3, 'font-size': 9, fill: 'currentColor', 'fill-opacity': 0.5 });
  first.textContent = bars[0].time;
  svg.appendChild(first);
  const last = svgNode('text', { x: rightEdge, y: H - 3, 'font-size': 9, 'text-anchor': 'end', fill: 'currentColor', 'fill-opacity': 0.5 });
  last.textContent = bars[bars.length - 1].time;
  svg.appendChild(last);
  node.appendChild(svg);

  const legend = el('div', 'review-legend');
  const legendItems = [['中心行权价', THEME.blue], ['上下翼', THEME.orange], ['盈利区(到期)', THEME.up], ['开仓', THEME.blue], ['平仓 / 到期', THEME.purple]];
  if (r.exit_plan) legendItems.push(['临界线 ±0.45W / ±0.55W / ±0.8W(细虚线)', 'currentColor']);
  for (const [text, color] of legendItems) {
    const item = el('span', null, text);
    const swatch = el('i');
    swatch.style.color = color;
    item.insertBefore(swatch, item.firstChild);
    legend.appendChild(item);
  }
  node.appendChild(legend);
  return node;
}

const EXIT_LEVEL_STYLE = () => ({
  tp1: [THEME.up, '第一档'], tp2: [THEME.up, '第二档'],
  trail_arm: [THEME.orange, '回撤追踪激活'], stop: [THEME.down, '止损'],
});
const PHASE_LABEL = { A: '阶段 A', B: '阶段 B', C: '阶段 C' };

/** 蝶价走势:组合分钟中间价的蜡烛 + 模型价虚线 + 止盈/止损水平线 + 开仓/平仓/策略事件标记。 */
function renderFlyChart(r) {
  const plan = r.exit_plan || {};
  const sim = plan.simulation || {};
  const fs = r.fly_series || {};
  const real = fs.bars || [];
  const path = sim.series || [];
  const node = card('info', `蝶价走势(组合中间价 · 1 分钟 · ${fs.source === 'ibkr' ? 'IBKR 真实数据' : '模型价'})`);
  // 时间轴:真实 K 线与回放序列的并集,按时间排序
  const times = Array.from(new Set([...real.map((b) => b.time), ...path.map((p) => p.time)])).sort();
  if (times.length < 2) {
    node.appendChild(el('p', 'empty', '没有蝶价数据:引擎未连 TWS,或 IBKR 没有这张组合的历史分钟线。'));
    return node;
  }
  const realAt = new Map(real.map((b) => [b.time, b]));
  const pathAt = new Map(path.map((p) => [p.time, p]));
  const levels = (plan.levels || []).map((l) => l.price);
  const prices = [];
  for (const b of real) prices.push(b.low, b.high);
  for (const p of path) {
    prices.push(p.price);
    if (p.trail_stop != null) prices.push(p.trail_stop);
  }
  for (const m of fs.markers || []) if (m.price != null) prices.push(m.price);
  let lo = Math.min(...prices, ...levels.filter((v) => v != null));
  let hi = Math.max(...prices, ...levels.filter((v) => v != null));
  const pad = (hi - lo) * 0.08 || 0.5;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const span = hi - lo || 1;
  const W = 660, H = 260, PAD_L = 6, PAD_R = 92, PAD_T = 12, PAD_B = 16;
  const PRICE_H = H - PAD_T - PAD_B;
  const slot = (W - PAD_L - PAD_R) / times.length;
  const x = (i) => PAD_L + slot * (i + 0.5);
  const y = (p) => PAD_T + PRICE_H - ((p - lo) / span) * PRICE_H;
  const at = new Map(times.map((t, i) => [t, i]));
  const rightEdge = W - PAD_R;
  const svg = svgNode('svg', { viewBox: `0 0 ${W} ${H}`, class: 'review-chart' });

  // 阶段底色:B、C 段淡淡标出来
  const phaseBands = [];
  for (let i = 0; i < times.length; i += 1) {
    const ph = (pathAt.get(times[i]) || {}).phase;
    if (!ph) continue;
    const lastBand = phaseBands[phaseBands.length - 1];
    if (lastBand && lastBand.phase === ph) lastBand.to = i;
    else phaseBands.push({ phase: ph, from: i, to: i });
  }
  for (const band of phaseBands) {
    if (band.phase === 'A') continue;
    svg.appendChild(svgNode('rect', {
      x: x(band.from) - slot / 2, y: PAD_T, width: slot * (band.to - band.from + 1), height: PRICE_H,
      fill: band.phase === 'B' ? THEME.orange : THEME.purple, 'fill-opacity': 0.06,
    }));
    const t = svgNode('text', { x: x(band.from), y: PAD_T + 9, 'font-size': 8.5, fill: 'currentColor', 'fill-opacity': 0.55 });
    t.textContent = PHASE_LABEL[band.phase];
    svg.appendChild(t);
  }

  // 止盈 / 止损水平线
  for (const l of plan.levels || []) {
    const st = EXIT_LEVEL_STYLE()[l.kind];
    if (!st || l.price == null) continue;
    const py = y(l.price);
    svg.appendChild(svgNode('line', {
      x1: PAD_L, x2: rightEdge, y1: py, y2: py, stroke: st[0], 'stroke-opacity': 0.8, 'stroke-width': 1,
      'stroke-dasharray': l.kind === 'trail_arm' ? '2 2' : '5 3',
    }));
    const label = svgNode('text', { x: rightEdge + 4, y: py + 3, 'font-size': 8.5, fill: st[0] });
    label.textContent = `${st[1]} ${l.price}`;
    svg.appendChild(label);
  }

  // 回撤追踪线:触发价随浮盈高水位往上棘轮,只在激活之后有值。画成阶梯,断点处不连线。
  const trailSegs = [];
  for (const p of path) {
    if (p.trail_stop == null || !at.has(p.time)) { trailSegs.push(null); continue; }
    trailSegs.push([at.get(p.time), p.trail_stop]);
  }
  let run = [];
  const flushTrail = () => {
    if (run.length > 1) {
      let d = '';
      for (let i = 0; i < run.length; i += 1) {
        const [xi, v] = run[i];
        const px = x(xi).toFixed(1);
        if (!i) d += `M${px},${y(v).toFixed(1)}`;
        else d += ` L${x(run[i - 1][0]).toFixed(1)},${y(v).toFixed(1)} L${px},${y(v).toFixed(1)}`;
      }
      svg.appendChild(svgNode('path', { d, fill: 'none', stroke: THEME.orange, 'stroke-opacity': 0.85, 'stroke-width': 1.2, 'stroke-dasharray': '4 2' }));
    }
    run = [];
  };
  for (const seg of trailSegs) {
    if (seg) run.push(seg);
    else flushTrail();
  }
  flushTrail();

  // 蜡烛(真实分钟线)
  const bodyW = Math.max(slot * 0.6, 1);
  for (let i = 0; i < times.length; i += 1) {
    const b = realAt.get(times[i]);
    if (!b) continue;
    const up = b.close >= b.open;
    const color = up ? THEME.up : THEME.down;
    svg.appendChild(svgNode('line', { x1: x(i), x2: x(i), y1: y(b.high), y2: y(b.low), stroke: color, 'stroke-width': Math.min(bodyW * 0.28, 1) }));
    svg.appendChild(svgNode('rect', {
      x: x(i) - bodyW / 2, y: y(Math.max(b.open, b.close)), width: bodyW,
      height: Math.max(Math.abs(y(b.close) - y(b.open)), 0.8), fill: color,
    }));
  }
  // 模型价:只画没有真实数据的那些分钟,虚线
  const modelPts = path.filter((p) => p.source === 'model' && at.has(p.time));
  if (modelPts.length) {
    const d = modelPts.map((p, i) => `${i ? 'L' : 'M'}${x(at.get(p.time)).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
    svg.appendChild(svgNode('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-opacity': 0.6, 'stroke-width': 1, 'stroke-dasharray': '3 2' }));
  }

  // 标记:开仓 / 实际平仓 / 策略事件
  const MARK = { entry: [THEME.blue, '开仓'], exit: [THEME.purple, '实际平仓'] };
  for (const m of fs.markers || []) {
    if (!at.has(m.time) || m.price == null) continue;
    const i = at.get(m.time);
    const st = MARK[m.kind] || MARK.entry;
    svg.appendChild(svgNode('line', { x1: x(i), x2: x(i), y1: PAD_T, y2: PAD_T + PRICE_H, stroke: st[0], 'stroke-width': 1, 'stroke-dasharray': '3 3', 'stroke-opacity': 0.8 }));
    svg.appendChild(svgNode('circle', { cx: x(i), cy: y(m.price), r: 3, fill: st[0] }));
    const label = svgNode('text', { x: x(i) + 4, y: y(m.price) - 5, 'font-size': 9, fill: st[0] });
    label.textContent = `${st[1]} ${m.price}`;
    svg.appendChild(label);
  }
  for (const e of sim.events || []) {
    if (!at.has(e.time)) continue;
    const i = at.get(e.time);
    const color = e.source === 'settle' ? THEME.purple : (e.pnl >= 0 ? THEME.up : THEME.down);
    const py = y(e.price);
    svg.appendChild(svgNode('path', { d: `M${x(i)},${py - 9} l5,8 l-10,0 z`, fill: color }));
    const label = svgNode('text', { x: x(i), y: py - 12, 'font-size': 8.5, 'text-anchor': 'middle', fill: color });
    label.textContent = `策略 ${e.qty} 张 @ ${e.price}`;
    svg.appendChild(label);
  }

  const first = svgNode('text', { x: PAD_L, y: H - 3, 'font-size': 9, fill: 'currentColor', 'fill-opacity': 0.5 });
  first.textContent = times[0];
  svg.appendChild(first);
  const last = svgNode('text', { x: rightEdge, y: H - 3, 'font-size': 9, 'text-anchor': 'end', fill: 'currentColor', 'fill-opacity': 0.5 });
  last.textContent = times[times.length - 1];
  svg.appendChild(last);
  node.appendChild(svg);

  const legend = el('div', 'review-legend');
  for (const [text, color] of [['止盈档位', THEME.up], ['止损', THEME.down], ['回撤激活线 / 触发价(阶梯)', THEME.orange], ['开仓', THEME.blue], ['实际平仓', THEME.purple], ['模型价(无真实报价的分钟)', 'currentColor'], ['▲ 策略出手点', THEME.up]]) {
    const item = el('span', null, text);
    const swatch = el('i');
    swatch.style.color = color;
    item.insertBefore(swatch, item.firstChild);
    legend.appendChild(item);
  }
  node.appendChild(legend);
  return node;
}

function signedCell(v) {
  const td = el('td', 'num', v == null ? '—' : fmtMoney(v));
  if (v != null && v > 0) td.classList.add('pos');
  if (v != null && v < 0) td.classList.add('neg');
  return td;
}

/** 止盈点位与预计盈利 + 策略回放事件 + 三种结局对比。 */
function renderExitPlan(r) {
  const plan = r.exit_plan || {};
  const sim = plan.simulation || {};
  const p = r.profile || {};
  const box = el('div', 'detail-section');
  box.appendChild(el('h4', null, '止盈策略(SPX 0DTE 蝶式 v2.1 · 浮盈回撤追踪)'));
  const ph = plan.phases || {};
  box.appendChild(el('p', 'hint',
    `入场 D = ${p.debit ?? '—'},翼宽 W = ${p.width},EM = ${ph.em_at_open}(翼宽 = ${ph.wing_in_sigma ?? '—'} 个日 σ)。` +
    `阶段 A 到 ${ph.a_until};阶段 C 自 ${ph.c_from} 起(σ_剩余 ${ph.sigma_at_switch} < W/1.6 = ${ph.threshold})。` +
    (r.exit_plan.actual_exit_mult != null ? ` 实际平仓价 = ${r.exit_plan.actual_exit_mult}×D。` : '')));

  const table = el('table', 'review-table');
  const head = el('tr');
  for (const [h, num] of [['点位', 0], ['蝶价', 1], ['倍数', 1], ['张数', 1], ['每张盈亏', 1], ['预计盈亏', 1]]) head.appendChild(el('th', num ? 'num' : null, h));
  table.appendChild(head);
  for (const l of plan.levels || []) {
    const tr = el('tr');
    tr.appendChild(el('td', null, l.label));
    tr.appendChild(el('td', 'num', String(l.price)));
    tr.appendChild(el('td', 'num', `${l.mult_of_debit}×D`));
    tr.appendChild(el('td', 'num', l.tranche_qty ? String(l.tranche_qty) : '—'));
    tr.appendChild(signedCell(l.pnl_per_contract));
    tr.appendChild(signedCell(l.expected_pnl));
    table.appendChild(tr);
  }
  box.appendChild(table);

  if (sim.applicable === false) {
    box.appendChild(card('warn', '不能回放', sim.reason || ''));
  } else {
    const t = sim.totals || {};
    const cmp = el('table', 'review-table');
    const h2 = el('tr');
    for (const [h, num] of [['结局对比', 0], ['盈亏', 1], ['说明', 0]]) h2.appendChild(el('th', num ? 'num' : null, h));
    cmp.appendChild(h2);
    const rows = [
      ['按策略回放', t.strategy, `${(sim.events || []).length} 次出手`],
      ['实际', t.actual, r.outcome.kind === 'closed' ? `以 ${r.outcome.price} 平仓` : (r.outcome.kind === 'expired' ? '到期结算' : '持仓中,未计')],
      ['持到结算 / 最新', t.hold_to_settle, '按最后一根标的 K 线的内在价值'],
      ['最高蝶价', t.best_mid_pnl, t.best_mid != null ? `中间价曾到 ${t.best_mid}` : ''],
      ['浮盈高水位', t.profit_peak != null && p.debit != null ? t.profit_peak * p.multiplier * p.qty : null,
        t.profit_peak ? `激活之后记到 ${t.profit_peak} 点,回撤追踪按它算` : '没到回撤追踪的激活线'],
    ];
    for (const [k, v, note] of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', null, k));
      tr.appendChild(signedCell(v));
      tr.appendChild(el('td', null, note));
      cmp.appendChild(tr);
    }
    box.appendChild(cmp);

    const ev = el('table', 'review-table');
    const h3 = el('tr');
    for (const [h, num] of [['时间', 0], ['阶段', 0], ['张数', 1], ['蝶价', 1], ['盈亏', 1], ['规则', 0]]) h3.appendChild(el('th', num ? 'num' : null, h));
    ev.appendChild(h3);
    for (const e of sim.events || []) {
      const tr = el('tr');
      tr.appendChild(el('td', null, String(e.time).slice(11)));
      const ph2 = el('td');
      ph2.appendChild(el('span', 'review-phase', PHASE_LABEL[e.phase] || e.phase));
      tr.appendChild(ph2);
      tr.appendChild(el('td', 'num', String(e.qty)));
      tr.appendChild(el('td', 'num', `${e.price}${e.source === 'model' ? '(模型)' : ''}`));
      tr.appendChild(signedCell(e.pnl));
      tr.appendChild(el('td', null, e.rule));
      ev.appendChild(tr);
    }
    if (!(sim.events || []).length) {
      const tr = el('tr');
      tr.appendChild(el('td', null, '策略在这段数据里没有出手'));
      ev.appendChild(tr);
    }
    box.appendChild(ev);
  }
  if ((plan.notes || []).length) {
    const ul = el('ul', 'review-notes');
    for (const n of plan.notes) ul.appendChild(el('li', null, n));
    box.appendChild(ul);
  }
  return box;
}

async function loadPaTimeframes() {
  const select = $('pa-timeframe');
  if (!pa.timeframes.length) {
    try {
      const result = await window.dafri.paTimeframes();
      pa.timeframes = result.timeframes || [];
    } catch (err) {
      showBanner(`K 线周期表读取失败:${err.message}`, false);
      return;
    }
    clear(select);
    for (const tf of pa.timeframes) {
      const option = el('option', null, tf.label);
      option.value = tf.key;
      select.appendChild(option);
    }
  }
  if (pa.timeframes.some((tf) => tf.key === pa.timeframe)) select.value = pa.timeframe;
  $('pa-symbol').value = pa.symbol;
  $('pa-rth').checked = pa.rth;
}

function paSpec(force) {
  return { symbol: pa.symbol, timeframe: pa.timeframe, rth: pa.rth, force: Boolean(force) };
}

/** 自动刷新走这条:只用已存下的 state,不读输入框——用户正在改标的时不该被打断。 */
async function fetchPa(force) {
  if (!pa.symbol || pa.loading) return;
  pa.loading = true;
  renderPa();
  try {
    const next = await window.dafri.paAnalyze(paSpec(force));
    // 换了标的或周期就丢掉上一次的 AI 解读,免得张冠李戴
    if (!pa.data || pa.data.symbol !== next.symbol || pa.data.timeframe !== next.timeframe) {
      pa.comment = null;
    }
    pa.data = next;
    pa.error = null;
  } catch (err) {
    pa.data = null;
    pa.comment = null;
    pa.error = err.message;
  } finally {
    pa.loading = false;
    renderPa();
  }
}

/** 手动触发:先把输入同步进 state,再走同一条取数路径。 */
async function submitPa() {
  const symbol = $('pa-symbol').value.trim().toUpperCase();
  if (!symbol) {
    showBanner('先填一个标的代码', true);
    return;
  }
  pa.symbol = symbol;
  pa.timeframe = $('pa-timeframe').value;
  pa.rth = $('pa-rth').checked;
  localStorage.setItem('dafri-pa-symbol', pa.symbol);
  localStorage.setItem('dafri-pa-timeframe', pa.timeframe);
  localStorage.setItem('dafri-pa-rth', pa.rth ? '1' : '0');
  pa.comment = null;
  await fetchPa(true);
}

async function commentPa(button) {
  if (!pa.symbol) return;
  button.disabled = true;
  button.textContent = '解读中…';
  try {
    const result = await window.dafri.paComment(paSpec(false));
    pa.data = result.analysis;
    pa.comment = Object.assign({}, result.comment, { model: result.model });
  } catch (err) {
    showBanner(`AI 解读失败:${err.message}`, false);
  } finally {
    renderPa();
  }
}

function paFreshness(r) {
  if (!r) return '—';
  const parts = [`最后一根 ${r.last_bar}`];
  if (r.age_seconds != null) {
    const mins = Math.round(r.age_seconds / 60);
    parts.push(mins < 1 ? '刚刚' : `${mins} 分钟前`);
  }
  parts.push(`${r.bar_count} 根`);
  if (!r.rth) parts.push('含盘前盘后');
  if (r.cached) parts.push('引擎缓存');
  return parts.join(' · ');
}

function renderPa() {
  const box = $('pa-result');
  $('pa-freshness').textContent = pa.loading ? '读取中…' : paFreshness(pa.data);
  $('btn-pa-run').disabled = pa.loading;

  if (pa.error) return empty(box, pa.error);
  if (!pa.data) return empty(box, pa.loading ? '正在取 K 线…' : '输入标的后点「分析」。');

  const r = pa.data;
  clear(box);

  // ---- 结论 ----------------------------------------------------------
  const head = card(PA_BIAS_KIND[r.bias] || 'info', `${r.symbol} ${r.timeframe_label} · ${r.bias_label}`);
  const scoreRow = el('div', 'row tight');
  scoreRow.appendChild(el('span', `pa-score ${r.score > 0 ? 'up' : r.score < 0 ? 'down' : 'flat'}`,
    `${r.score > 0 ? '+' : ''}${r.score}`));
  scoreRow.appendChild(el('span', 'muted', `打分区间 −100 ~ +100 · 置信度 ${r.confidence}`));
  head.appendChild(scoreRow);
  for (const line of r.readout || []) head.appendChild(el('div', 'reason', line));
  box.appendChild(head);

  // ---- 图 ------------------------------------------------------------
  box.appendChild(renderPaChart(r));

  // ---- 判断依据(权重公开,可逐条推翻)---------------------------------
  const ev = card('info', '判断依据(加权求和,正=看涨)');
  for (const item of r.evidence || []) {
    const row = el('div', 'pa-ev');
    row.appendChild(el('span', 'pa-ev-label', item.label));
    row.appendChild(el('span', 'pa-ev-detail', item.detail));
    const dir = item.weight > 0 ? 'up' : item.weight < 0 ? 'down' : 'flat';
    row.appendChild(el('span', `pa-ev-w ${dir}`, `${item.weight > 0 ? '+' : ''}${item.weight}`));
    ev.appendChild(row);
  }
  ev.appendChild(el('div', 'reason', '权重固定在引擎里,不随行情浮动;不认同某条,可从总分中减去再看结论。'));
  box.appendChild(ev);

  // ---- 结构与关键位 ---------------------------------------------------
  const struct = card('info', `结构:${r.trend_label}`);
  if ((r.swings || []).length) {
    struct.appendChild(el('div', 'reason',
      `摆动序列(旧→新):${r.swings.map((s) => `${s.label}@${s.price}`).join(' → ')}`));
  }
  for (const event of (r.events || []).slice(-3)) {
    struct.appendChild(el('div', 'reason', `${event.kind === 'CHoCH' ? '⚠ ' : ''}${event.text}`));
  }
  for (const level of r.levels || []) {
    const row = el('div', 'pa-lv');
    row.appendChild(el('span', `status ${level.side === 'resistance' ? 'rejected' : 'filled'}`,
      level.side === 'resistance' ? '阻力' : '支撑'));
    row.appendChild(el('span', 'pa-lv-price', String(level.price)));
    row.appendChild(el('span', 'muted',
      `${level.touches} 次触碰 · ${level.swings} 个摆动点 · 距现价 ${level.distance_pct > 0 ? '+' : ''}${level.distance_pct}%`));
    struct.appendChild(row);
  }
  box.appendChild(struct);

  // ---- 流动性与形态 ---------------------------------------------------
  const flow = card('info', '流动性与形态');
  let flowRows = 0;
  for (const gap of r.fvgs || []) {
    flow.appendChild(el('div', 'reason',
      `未回补 FVG(${PA_SIDE_LABEL[gap.side]})${gap.bottom} ~ ${gap.top},${gap.time} 留下,已回补 ${gap.filled_pct}%`));
    flowRows += 1;
  }
  if (r.order_block) {
    flow.appendChild(el('div', 'reason',
      `订单块(${PA_SIDE_LABEL[r.order_block.side]})${r.order_block.bottom} ~ ${r.order_block.top},${r.order_block.time},${r.order_block.mitigated ? '已被回踩' : '尚未回踩'}`));
    flowRows += 1;
  }
  for (const sweep of r.sweeps || []) {
    flow.appendChild(el('div', 'reason', sweep.text));
    flowRows += 1;
  }
  for (const eq of r.equal_levels || []) {
    flow.appendChild(el('div', 'reason', eq.text));
    flowRows += 1;
  }
  for (const p of (r.patterns || []).filter((p) => p.bars_ago <= 2)) {
    flow.appendChild(el('div', 'reason', `${p.name}(${p.bars_ago} 根前):${p.note}`));
    flowRows += 1;
  }
  if (!flowRows) flow.appendChild(el('div', 'reason', '这一段没有留下未回补缺口、扫单或明显形态。'));
  box.appendChild(flow);

  // ---- 价位表(不给建议,只给位置)-------------------------------------
  const plan = r.plan || {};
  const planCard = card('warn', '关键价位');
  if (plan.confirm) planCard.appendChild(el('div', 'reason', `确认条件:${plan.confirm}`));
  if (plan.invalidation && plan.invalidation.why) {
    planCard.appendChild(el('div', 'reason', `失效条件:${plan.invalidation.why}`));
  }
  for (const item of plan.watch || []) planCard.appendChild(el('div', 'reason', `观察点:${item}`));
  if (plan.atr_note) planCard.appendChild(el('div', 'reason', plan.atr_note));
  planCard.appendChild(el('div', 'card-meta',
    '以上只是价位与条件,不是建议;本页不接下单链路,仅供研究参考。'));
  box.appendChild(planCard);

  // ---- 高周期 ---------------------------------------------------------
  if (r.htf) {
    const agree = r.agreement || {};
    const kind = agree.state === 'aligned' ? 'ok' : agree.state === 'conflict' ? 'bad' : 'warn';
    const htf = card(kind, `高周期 ${r.htf.timeframe_label}:${r.htf.bias_label}`);
    htf.appendChild(el('div', 'reason', r.htf.trend_label));
    if (r.htf.last_event) htf.appendChild(el('div', 'reason', r.htf.last_event));
    htf.appendChild(el('div', 'reason',
      `支撑 ${r.htf.support == null ? '该样本内无' : r.htf.support} / 阻力 ${r.htf.resistance == null ? '该样本内无' : r.htf.resistance}`));
    if (agree.text) htf.appendChild(el('div', 'reason', agree.text));
    box.appendChild(htf);
  }

  // ---- 警告 -----------------------------------------------------------
  if ((r.warnings || []).length) {
    const warn = card('bad', '这次分析的局限');
    const list = el('ul');
    for (const line of r.warnings) list.appendChild(el('li', null, line));
    warn.appendChild(list);
    box.appendChild(warn);
  }

  // ---- AI 解读 --------------------------------------------------------
  const ai = card('info', 'AI 解读(可选)');
  ai.appendChild(el('div', 'reason',
    '模型只拿到上面算好的事实,看不到原始 K 线;它只负责把事实串成叙述。'));
  if (pa.comment) {
    ai.appendChild(el('div', 'card-title', pa.comment.summary));
    if (pa.comment.reading) ai.appendChild(el('div', null, pa.comment.reading));
    if ((pa.comment.watch || []).length) {
      ai.appendChild(el('div', 'reason', '盯:'));
      const list = el('ul');
      for (const line of pa.comment.watch) list.appendChild(el('li', null, line));
      ai.appendChild(list);
    }
    if ((pa.comment.risks || []).length) {
      ai.appendChild(el('div', 'reason', '可能错在:'));
      const list = el('ul');
      for (const line of pa.comment.risks) list.appendChild(el('li', null, line));
      ai.appendChild(list);
    }
    ai.appendChild(el('div', 'card-meta', `模型 ${pa.comment.model || '—'} · 仅供研究参考,不构成投资建议`));
  }
  const aiBtn = el('button', 'btn', pa.comment ? '重新解读' : 'AI 解读');
  aiBtn.addEventListener('click', () => commentPa(aiBtn));
  ai.appendChild(aiBtn);
  box.appendChild(ai);
}

/**
 * K 线图:交给 pa-chart.js 的 canvas 实现。这里只负责卡片与容器,画什么、怎么画都在那边。
 * 容器进了文档、有了尺寸,ResizeObserver 才会触发第一次绘制——所以这里不必等。
 */
function renderPaChart(r) {
  const node = card('info', `K 线(${r.timeframe_label})`);
  if (!(r.bars || []).length) return node;
  const wrap = el('div', 'pa-chart-wrap');
  node.appendChild(wrap);
  if (window.DafriPaChart) window.DafriPaChart.mount(wrap, r);
  else wrap.appendChild(el('p', 'empty', '图表模块未加载'));
  return node;
}

// ======================================================================
// 期权墙 · 价位警告
// 价位与状态机都在引擎侧,这里只负责显示和触发重算。
// 唯一特别的地方:警告轮询**不挂在当前页上** —— 切走了还得报,不然就没用了。
// ======================================================================
const alerts = { watches: [], feed: [], busy: new Set(), polling: false };

// 提示音用 Web Audio 现场合成,不加载任何音频文件 —— CSP 是 default-src 'none',
// 连 data: 的 <audio> 都会被拦下;而现场合成不涉及任何资源请求。
const sound = {
  ctx: null,
  enabled: localStorage.getItem('dafri-alert-sound') !== '0',
};

function audioContext() {
  if (!sound.ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    sound.ctx = new Ctor();
  }
  // 自动播放策略可能把上下文挂起,每次播放前都试着唤醒
  if (sound.ctx.state === 'suspended') sound.ctx.resume();
  return sound.ctx;
}

/** 上穿升调、下破降调 —— 不用看屏幕就知道方向。 */
function playAlertTone(direction) {
  if (!sound.enabled) return;
  const ctx = audioContext();
  if (!ctx) return;
  const notes = direction === 'up' ? [587.33, 880.0] : [880.0, 587.33];
  notes.forEach((freq, i) => {
    const at = ctx.currentTime + i * 0.16;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    // 包络必须有:直接开关振荡器会有明显的咔哒声
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.18);
  });
}

/** 声音 + 系统通知。两条都走:声音提醒"有事",通知告诉你"什么事"。 */
async function announceAlert(event) {
  playAlertTone(event.direction);
  try {
    await window.dafri.notify(
      `${event.symbol || ''} ${event.direction === 'up' ? '上穿' : '下破'} ${event.price}`,
      event.text || '',
    );
  } catch (err) {
    console.warn('系统通知失败', err);
  }
}

const ALERT_SOURCE_LABEL = {
  call_wall: '持仓墙', put_wall: '持仓墙',
  call_vol_wall: '成交墙', put_vol_wall: '成交墙',
  max_pain: '最大痛点', gamma_flip: 'Gamma 翻转', round: '整数关口',
  ma60: '60日线', ma120: '120日线', ma200: '200日线',
  low_52w: '52周低点', high_52w: '52周高点',
};

async function loadAlerts() {
  try {
    const result = await window.dafri.listAlerts();
    alerts.watches = result.watches || [];
    renderAlerts();
  } catch (err) {
    showBanner(`警告列表读取失败:${err.message}`, false);
  }
}

async function addAlertWatch() {
  const symbol = $('alert-symbol').value.trim().toUpperCase();
  if (!symbol) {
    showBanner('先填一个标的代码', true);
    return;
  }
  const step = Number($('alert-step').value) || 5;
  try {
    const { watch } = await window.dafri.createAlert(symbol, step);
    $('alert-symbol').value = '';
    await loadAlerts();
    await refreshAlertWatch(watch.id);   // 建好立刻算一次墙,不用再点一下
  } catch (err) {
    showBanner(`添加失败:${err.message}`, false);
  }
}

async function refreshAlertWatch(id, expiry) {
  alerts.busy.add(id);
  renderAlerts();
  try {
    const result = await window.dafri.refreshAlert(id, expiry || '');
    await loadAlerts();
    // 期权墙/日线历史失败时降级继续 —— 降级可以,但必须说出来
    if (result && result.wall_error) {
      showBanner(`期权墙没算出来,已降级:${result.wall_error}`, true);
    }
    if (result && result.history_error) {
      showBanner(`均线/52周位没算出来,已降级:${result.history_error}`, true);
    }
  } catch (err) {
    showBanner(`计算期权墙失败:${err.message}`, false);
  } finally {
    alerts.busy.delete(id);
    renderAlerts();
  }
}

async function deleteAlertWatch(id, symbol) {
  const ok = await window.dafri.confirm({
    message: `不再盯 ${symbol}?`,
    detail: '该标的的价位与触发记录会一起删掉。',
    confirmLabel: '删除',
  });
  if (!ok) return;
  try {
    await window.dafri.deleteAlert(id);
    await loadAlerts();
  } catch (err) {
    showBanner(`删除失败:${err.message}`, false);
  }
}

/** 全局轮询:不管在哪一页都要跑,否则切走就不报了。 */
async function pollAlerts() {
  if (alerts.polling || !state.connected) return;
  if (!alerts.watches.some((w) => w.enabled && (w.levels || []).length)) return;
  alerts.polling = true;
  try {
    const result = await window.dafri.pollAlerts();
    for (const event of result.fired || []) await announceAlert(event);
    if ((result.fired || []).length) {
      alerts.feed = [...result.fired, ...alerts.feed].slice(0, 50);
      await loadAlerts();
    }
    $('alerts-status').textContent = `上次检查 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch (err) {
    console.warn('警告轮询失败', err);
  } finally {
    alerts.polling = false;
  }
}

function updateAlertBadge() {
  const badge = $('sidebar-alerts');
  const armed = alerts.watches.reduce((n, w) => n + ((w.levels || []).length ? 1 : 0), 0);
  badge.textContent = String(armed);
  badge.classList.toggle('hidden', armed === 0);
}

function renderAlerts() {
  updateAlertBadge();
  const box = $('alerts-list');
  if (!alerts.watches.length) {
    empty(box, '还没有在盯的标的。');
  } else {
    clear(box);
    for (const watch of alerts.watches) box.appendChild(alertCard(watch));
  }

  const feed = $('alerts-feed');
  const history = alerts.feed.length
    ? alerts.feed
    : alerts.watches.flatMap((w) => (w.events || []).map((e) => ({ ...e, symbol: w.symbol })));
  if (!history.length) {
    empty(feed, '还没有触发记录。');
    return;
  }
  clear(feed);
  for (const event of history.slice(0, 30)) {
    const item = el('div', 'feed-item');
    const when = event.at ? new Date(event.at * 1000) : null;
    item.appendChild(el('time', null, when ? when.toLocaleTimeString('zh-CN', { hour12: false }) : '—'));
    item.appendChild(el('span', null, `${event.symbol || ''} ${event.text || ''}`));
    feed.appendChild(item);
  }
}

function alertCard(watch) {
  const node = el('div', 'sector-card');
  const head = el('div', 'record-head');
  head.appendChild(el('span', 'record-sym', watch.symbol));

  const actions = el('span', 'row tight');
  const busy = alerts.busy.has(watch.id);
  const refresh = el('button', 'btn tiny', busy ? '计算中…' : '重算墙');
  refresh.disabled = busy;
  refresh.addEventListener('click', () => refreshAlertWatch(watch.id));
  actions.appendChild(refresh);
  const remove = el('button', 'btn tiny ghost', '移除');
  remove.addEventListener('click', () => deleteAlertWatch(watch.id, watch.symbol));
  actions.appendChild(remove);
  head.appendChild(actions);
  node.appendChild(head);

  const meta = el('div', 'card-meta');
  if (watch.last_price != null) meta.appendChild(el('span', null, `现价 ${watch.last_price}`));
  meta.appendChild(el('span', null, `整数关口步长 ${watch.step}`));
  if (watch.expiry) meta.appendChild(el('span', null, `到期 ${watch.expiry}`));
  meta.appendChild(el('span', null, `${(watch.levels || []).length} 个价位`));
  node.appendChild(meta);

  const wall = watch.wall;
  if (wall) {
    const gex = el('div', 'card-meta');
    gex.appendChild(el('span', null, `净 GEX ${wall.net_gex >= 0 ? '正' : '负'}`));
    gex.appendChild(el('span', null,
      wall.regime === 'positive' ? '做市商多头 gamma,压波动' : '做市商空头 gamma,放大波动'));
    if (wall.max_pain) gex.appendChild(el('span', null, `最大痛点 ${wall.max_pain.strike}`));
    if (wall.spot_source === 'parity') {
      // 富途拿不到指数现价,这个价是从期权链用平价关系算出来的。
      // 不标出来的话,用户会以为它和真实报价是一回事。
      const derived = el('span', null, '现价由期权链反推');
      derived.title =
        '券商未提供现价,此处由期权链的看跌看涨平价反推;报价不干净时引擎会拒绝计算,而非给出错价。';
      gex.appendChild(derived);
    }
    if (wall.pc_ratio_oi != null) gex.appendChild(el('span', null, `P/C ${wall.pc_ratio_oi}`));
    node.appendChild(gex);
    if ((wall.days_to_expiry ?? 99) <= 1) {
      node.appendChild(el('div', 'stock-sub',
        '当天到期:OI 是隔夜存量,请以成交墙为准。'));
    }
  }

  if (!(watch.levels || []).length) {
    node.appendChild(el('p', 'muted', '还没算价位。点「重算墙」。'));
    return node;
  }

  const spot = watch.last_price;
  for (const level of watch.levels) {
    const row = el('div', 'pa-lv');
    const kind = level.kind === 'resistance' ? 'rejected' : level.kind === 'support' ? 'filled' : 'pending';
    row.appendChild(el('span', `status ${kind}`, ALERT_SOURCE_LABEL[level.source] || '价位'));
    row.appendChild(el('span', 'pa-lv-price', String(level.price)));
    const gap = spot ? ((level.price / spot - 1) * 100).toFixed(2) : null;
    row.appendChild(el('span', 'muted',
      `${level.label}${gap != null ? ` · ${gap > 0 ? '+' : ''}${gap}%` : ''}`));
    node.appendChild(row);
  }
  return node;
}

// ======================================================================
// 外观(夜间模式):走主进程 nativeTheme,渲染层 prefers-color-scheme 一起切
// ======================================================================
/** 涨跌配色是显示偏好,不是引擎配置:记在本地,只改 :root 的 data-updown,token 映射随之翻转。 */
function applyUpDown(mode) {
  const value = mode === 'red-up' ? 'red-up' : 'green-up';
  document.documentElement.dataset.updown = value;
  try { localStorage.setItem('dafri-updown', value); } catch { /* 预览台的 data: 页面没有 localStorage */ }
  document.querySelectorAll('#updown-picker [data-updown]').forEach((btn) =>
    btn.classList.toggle('active', btn.dataset.updown === value)
  );
  // 已经画在屏幕上的图不会自己变色,能重画的当场重画
  if (typeof renderPa === 'function' && pa.data) renderPa();
  if (typeof renderReview === 'function' && review.data) renderReview();
}

async function applyTheme(mode) {
  try {
    await window.dafri.setTheme(mode);
  } catch (err) {
    showBanner(`切换外观失败:${err.message}`, false);
    return;
  }
  localStorage.setItem('dafri-theme', mode);
  document.querySelectorAll('#theme-picker [data-theme-mode]').forEach((btn) =>
    btn.classList.toggle('active', btn.dataset.themeMode === mode)
  );
}

async function addSectorStock(sectorId, input) {
  const symbol = input.value.trim().toUpperCase();
  if (!symbol) return;
  try {
    await window.dafri.addSectorStock(sectorId, symbol);
    input.value = '';
    await loadSectors(true);
  } catch (err) {
    showBanner(`添加股票失败:${err.message}`, false);
  }
}

async function removeSectorStock(sectorId, symbol) {
  try {
    await window.dafri.removeSectorStock(sectorId, symbol);
    await loadSectors(false);
  } catch (err) {
    showBanner(`移除股票失败:${err.message}`, false);
  }
}

async function addSector() {
  const input = $('sector-input');
  const name = input.value.trim();
  if (!name) return;
  try {
    await window.dafri.addSector(name);
    input.value = '';
    await loadSectors(false);
  } catch (err) {
    showBanner(`新建板块失败:${err.message}`, false);
  }
}

async function pickSector(id, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '选股中…';
  try {
    await window.dafri.pickSector(id);
    await loadSectors(true);
  } catch (err) {
    showBanner(`AI 选股失败:${err.message}`, false);
    button.disabled = false;
    button.textContent = original;
  }
}

async function deleteSector(id, name) {
  const ok = await window.dafri.confirm({
    message: `删除板块「${name}」?`,
    detail: '只删除这个板块及其 AI 选股结果,不影响任何交易数据。',
    confirmLabel: '删除',
  });
  if (ok !== true) return;
  try {
    await window.dafri.deleteSector(id);
    await loadSectors(false);
  } catch (err) {
    showBanner(`删除板块失败:${err.message}`, false);
  }
}

// ======================================================================
// 设置
// ======================================================================
async function loadSettings() {
  try {
    const settings = await window.dafri.getSettings();
    state.settings = settings;
    // 少一个字段就整页崩掉、只留一句 JS 报错,不是可交付的失败方式:
    // 缺什么就空着那一格,其余照常可用。
    const policies = settings.policies || {};
    const limits = settings.limits || {};
    $('opt-auto-execute').checked = Boolean(policies.auto_execute);
    $('opt-live').checked = Boolean(policies.allow_live_trading);
    $('opt-trigger-verify').checked = Boolean(policies.require_trigger_price_verification);
    $('opt-notional').value = limits.max_order_notional ?? '';
    $('opt-contracts').value = limits.max_option_contracts ?? '';
    $('opt-mkt-shares').value = limits.max_mkt_shares ?? '';
    $('opt-slippage').value = limits.max_spread_slippage ?? '';
    $('opt-dupe').value = limits.duplicate_window_minutes ?? '';
  } catch (err) {
    showBanner(`读取设置失败:${err.message}`, false);
  }
}

async function saveSettings() {
  const autoExecute = $('opt-auto-execute').checked;
  const allowLive = $('opt-live').checked;

  if (autoExecute && !(state.settings && state.settings.policies.auto_execute)) {
    const ok = await window.dafri.confirm({
      title: '打开自动执行',
      message: `打开后,解析通过的订单会被直接发送到${brokerShortName()},没有人工确认环节。`,
      detail: '建议先在纸面账户跑够回归测试再打开。',
      confirmLabel: '我明白,打开',
    });
    if (!ok) return ($('opt-auto-execute').checked = false);
  }
  if (allowLive && !(state.settings && state.settings.policies.allow_live_trading)) {
    const ok = await window.dafri.confirm({
      title: '允许实盘下单',
      message: '打开后,指向实盘账户的订单将不再被拦截,会用真钱成交。',
      confirmLabel: '我明白,打开实盘',
    });
    if (!ok) return ($('opt-live').checked = false);
  }

  const patch = {
    policies: {
      auto_execute: autoExecute,
      allow_live_trading: allowLive,
      require_trigger_price_verification: $('opt-trigger-verify').checked,
    },
    limits: {
      max_order_notional: Number($('opt-notional').value),
      max_option_contracts: Number($('opt-contracts').value),
      max_mkt_shares: Number($('opt-mkt-shares').value),
      max_spread_slippage: Number($('opt-slippage').value),
      duplicate_window_minutes: Number($('opt-dupe').value),
    },
  };

  try {
    await window.dafri.patchSettings(patch);
    showBanner('设置已保存,提示词与限额已同步更新。', true);
    await Promise.all([loadSettings(), refreshStatus()]);
  } catch (err) {
    showBanner(`保存失败(配置未改动):${err.message}`, false);
  }
}

// ======================================================================
// 通知流
// ======================================================================
function pushNotification(title, body) {
  const feed = $('notifications');
  if (feed.querySelector('.empty')) clear(feed);
  const item = el('div', 'feed-item');
  const time = el('time', null, new Date().toLocaleTimeString('zh-CN', { hour12: false }));
  item.appendChild(time);
  item.appendChild(el('span', null, `${title}${body ? ' · ' + body : ''}`));
  feed.insertBefore(item, feed.firstChild);
  while (feed.children.length > 60) feed.removeChild(feed.lastChild);
}

// ======================================================================
// 大模型接入
// ======================================================================
const llm = { catalog: null, provider: null };

async function loadLlm() {
  try {
    const catalog = await window.dafri.llmCatalog();
    llm.catalog = catalog;
    llm.provider = llm.provider || catalog.current.provider;
    renderProviderPicker();
    fillLlmForm();
  } catch (err) {
    showBanner(`读取模型配置失败:${err.message}`, false);
  }
}

function providerMeta(key) {
  return (llm.catalog?.providers || []).find((p) => p.key === key) || {};
}

function renderProviderPicker() {
  const box = $('llm-providers');
  clear(box);
  for (const provider of llm.catalog.providers) {
    const btn = el('button', 'tab' + (provider.key === llm.provider ? ' active' : ''), provider.label);
    btn.addEventListener('click', () => {
      llm.provider = provider.key;
      renderProviderPicker();
      fillLlmForm({ providerChanged: true });
    });
    box.appendChild(btn);
  }
}

function fillLlmForm(options = {}) {
  const current = llm.catalog.current;
  const meta = providerMeta(llm.provider);
  const sameProvider = llm.provider === current.provider;

  // 模型下拉:预设 + 当前值(当前值不在预设里也要能选中)
  const select = $('llm-model');
  clear(select);
  const models = [...(meta.models || [])];
  if (sameProvider && current.model && !models.includes(current.model)) models.unshift(current.model);
  for (const model of models) {
    const option = el('option', null, model);
    option.value = model;
    select.appendChild(option);
  }
  if (sameProvider && current.model) select.value = current.model;

  $('llm-model-custom').value = '';
  $('llm-base-url').value = sameProvider ? current.base_url || '' : meta.default_base_url || '';
  $('llm-base-url-row').classList.toggle('hidden', !meta.needs_base_url);
  $('llm-effort-row').classList.toggle('hidden', !meta.supports_effort);
  $('llm-temp-row').classList.toggle('hidden', !meta.supports_temperature);
  $('llm-effort').value = current.effort || 'high';
  $('llm-temperature').value = current.temperature ?? '';
  $('llm-max-tokens').value = current.max_tokens;
  $('llm-timeout').value = current.timeout_s;
  $('llm-provider-docs').textContent = meta.docs || '';

  const configured = llm.catalog.key_configured?.[llm.provider];
  const status = $('llm-key-status');
  status.textContent = configured ? '已配置(存于 Keychain)' : '未配置';
  status.style.color = configured ? 'var(--green)' : 'var(--orange)';
  // 就绪检查表要用它。这个信息只有大模型面板拿得到,拿到了就顺手告诉检查表——
  // 否则用户填完 Key,首页那条"还差一步"还挂在那里。
  state.llmKeyConfigured = Boolean(configured);
  renderReadiness();

  if (options.providerChanged) empty($('llm-test-result'), '');
}

function collectLlmForm() {
  const meta = providerMeta(llm.provider);
  const custom = $('llm-model-custom').value.trim();
  const patch = {
    provider: llm.provider,
    model: custom || $('llm-model').value,
    max_tokens: Number($('llm-max-tokens').value),
    timeout_s: Number($('llm-timeout').value),
  };
  if (meta.needs_base_url) patch.base_url = $('llm-base-url').value.trim();
  if (meta.supports_effort) patch.effort = $('llm-effort').value;
  if (meta.supports_temperature) {
    const raw = $('llm-temperature').value.trim();
    patch.temperature = raw === '' ? null : Number(raw);
  }
  return patch;
}

async function testLlm() {
  const box = $('llm-test-result');
  const btn = $('btn-llm-test');
  btn.disabled = true;
  clear(box);
  box.appendChild(card('info', '正在测试…', '会真打一次最小请求'));
  try {
    // 允许带一把还没保存的 key 先试,试通了再保存
    const key = $('llm-key').value.trim() || undefined;
    const result = await window.dafri.llmTest(collectLlmForm(), key);
    clear(box);
    if (result.ok) {
      const meta = [
        `${result.latency_ms} ms`,
        `结构化输出:${result.structured_mode}`,
        `in ${result.usage?.input_tokens ?? '—'} / out ${result.usage?.output_tokens ?? '—'}`,
      ];
      const node = card('ok', `连通 · ${result.model}`, null, meta);
      if (result.structured_mode === 'json_object') {
        node.appendChild(
          el('div', 'reason', '端点不支持 json_schema,已降级为 json_object + 提示词内嵌 schema,拒绝率可能升高。')
        );
      }
      box.appendChild(node);
    } else {
      box.appendChild(card('bad', '测试失败', result.error));
    }
  } catch (err) {
    clear(box);
    box.appendChild(card('bad', '测试失败', err.message));
  } finally {
    btn.disabled = false;
  }
}

async function saveLlm() {
  try {
    await window.dafri.llmPatch(collectLlmForm());
    await Promise.all([loadLlm(), refreshStatus()]);
    showBanner('模型配置已保存,提示词与解析引擎已重建。', true);
  } catch (err) {
    showBanner(`保存失败(配置未改动):${err.message}`, false);
  }
}

async function saveLlmKey() {
  const input = $('llm-key');
  const secret = input.value.trim();
  if (!secret) return;
  try {
    await window.dafri.setApiKeyFor(secret, llm.provider);
    input.value = '';
    await loadLlm();
    showBanner(`已把 ${providerMeta(llm.provider).label} 的 API Key 写入 Keychain。`, true);
  } catch (err) {
    showBanner(`写入失败:${err.message}`, false);
  }
}

// ======================================================================
// TWS 连接检测
// ======================================================================
async function scanTws() {
  const appsBox = $('tws-apps');
  const portsBox = $('tws-ports');
  try {
    const scan = await window.dafri.scanTws();
    renderApps(scan.apps);
    renderPorts(scan.ports, scan.connected);
    renderGuide(scan.guide);
  } catch (err) {
    empty(appsBox, `检测失败:${err.message}`);
    empty(portsBox, '—');
  }
}

function renderApps(apps) {
  const box = $('tws-apps');
  clear(box);
  for (const app of apps) {
    const kind = app.running ? 'ok' : app.installed ? 'warn' : 'bad';
    const stateText = app.running
      ? '正在运行'
      : app.installed
        ? '已安装,未运行'
        : '未安装(请从 IBKR 官网下载)';
    const node = card(kind, app.name, stateText, app.paths.length ? [app.paths[0]] : []);

    if (app.installed && !app.running) {
      const btn = el('button', 'btn tiny', `启动 ${app.name}`);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await window.dafri.launchTws(app.key);
          pushNotification(`已启动 ${app.name}`, '请在它自己的窗口里登录');
          setTimeout(scanTws, 4000);
        } catch (err) {
          showBanner(`启动失败:${err.message}`, false);
        } finally {
          btn.disabled = false;
        }
      });
      node.appendChild(btn);
    }
    box.appendChild(node);
  }
}

function renderPorts(ports, connected) {
  renderPortsInto($('tws-ports'), ports, connected);
}

// 端口栅格和指引两家券商长得一样,只是数据来源不同——共用一份渲染,
// 免得改了 TWS 那边、富途这边悄悄长成另一个样子。
function renderPortsInto(box, ports, connected) {
  clear(box);
  for (const port of ports) {
    const node = el('div', `port ${port.open ? 'open' : 'closed'}`);
    node.appendChild(el('div', 'port-num', String(port.port)));
    node.appendChild(el('div', 'port-label', port.label));
    node.appendChild(
      el(
        'div',
        `port-state ${port.open ? 'open' : 'closed'}`,
        port.open ? `开放 · ${port.latency_ms ?? '?'} ms` : port.error || '未监听'
      )
    );
    if (port.configured_as) {
      const badge = el('span', 'port-badge', `配置:${port.configured_as}`);
      if ((connected || []).includes(port.configured_as)) badge.textContent += ' · 已连接';
      node.appendChild(badge);
    }
    box.appendChild(node);
  }
}

function renderGuide(steps) {
  renderGuideInto($('tws-guide'), steps);
}

function renderGuideInto(box, steps) {
  clear(box);
  for (const step of steps || []) {
    const li = el('li');
    li.appendChild(el('strong', null, step.title));
    li.appendChild(el('span', null, step.detail));
    box.appendChild(li);
  }
}

async function diagnoseTws() {
  const box = $('tws-diagnosis');
  const restore = busy($('btn-tws-diagnose'));
  working(box, '正在握手…(首次连接 TWS 会弹确认框,点 Yes)');
  try {
    const { results } = await window.dafri.diagnoseTws();
    clear(box);
    for (const result of results) {
      box.appendChild(renderDiagnosis(result));
    }
  } catch (err) {
    empty(box, `诊断失败:${err.message}`);
  } finally {
    restore();
  }
}

function renderDiagnosis(result) {
  const kind = result.connected && !result.error ? 'ok' : result.connected ? 'warn' : 'bad';
  const title = `连接 ${result.connection} · ${result.host}:${result.port}`;
  const node = card(kind, title, result.connected ? '握手成功' : '未连接');

  if (result.connected) {
    const meta = el('div', 'card-meta');
    meta.appendChild(el('span', null, `服务器版本 ${result.server_version ?? '—'}`));
    meta.appendChild(el('span', null, `clientId ${result.client_id}`));
    if (result.port_latency_ms !== null && result.port_latency_ms !== undefined) {
      meta.appendChild(el('span', null, `${result.port_latency_ms} ms`));
    }
    node.appendChild(meta);
  }

  if (result.error) node.appendChild(el('div', 'reason', result.error));
  if (result.hint) {
    const hint = el('div', null, result.hint);
    hint.style.marginTop = '6px';
    node.appendChild(hint);
  }

  if (result.accounts && result.accounts.length) {
    const list = el('div');
    list.style.marginTop = '8px';
    for (const account of result.accounts.filter((a) => a.connection === result.connection)) {
      const row = el('div', 'acct-row');
      const left = el('span', null, `${account.alias} → ${account.account_masked}`);
      row.appendChild(left);
      row.appendChild(
        el(
          'span',
          account.resolved ? 'acct-ok' : 'acct-bad',
          account.resolved ? '✓ 对得上' : '✗ 不在可管账户里'
        )
      );
      list.appendChild(row);
    }
    if (list.children.length) node.appendChild(list);
  }
  return node;
}


// ======================================================================
// 持仓追踪:盯住一个持仓,到价自动平仓
// ======================================================================
const tracker = { positions: [], tracks: [], rows: {}, busy: false, hosted: {}, delayed: false, sig: '' };

const TRACK_STATE_LABEL = {
  holding: '持有中',
  take_profit: '止盈已触发',
  profit_trail: '利润回撤已触发',
  stop_loss: '止损已触发',
  closed: '持仓已不在',
};

/** 盈亏的颜色和符号。0 不着色——把 0 画成绿色会让人以为赚了。 */
function pnlNode(value, pct) {
  if (value === null || value === undefined) return el('span', 'muted', '—');
  const up = value > 0;
  const cls = value === 0 ? 'muted' : up ? 'pnl-up' : 'pnl-down';
  const sign = up ? '+' : '';
  const text = `${sign}${fmtMoney(value)}`;
  const node = el('span', cls, text);
  if (pct !== null && pct !== undefined) node.appendChild(el('span', 'pnl-pct', ` ${sign}${pct}%`));
  return node;
}

async function loadTracker(refreshPositions) {
  try {
    const { tracks } = await window.dafri.listTrackers();
    tracker.tracks = tracks || [];
  } catch (err) {
    tracker.tracks = [];
  }
  if (refreshPositions !== false) {
    const box = $('positions');
    try {
      const { positions } = await window.dafri.listPositions();
      tracker.positions = positions || [];
    } catch (err) {
      tracker.positions = [];
      empty(box, err.message);
    }
  }
  renderPositions();
  renderTrackers();
}

/** 期权腿显示成票面样子:SPX 7615P 2026-09-01;组合用引擎给的组合名。
 * 引擎给了 label 就用引擎的,老引擎没给时从合约现场拼(追踪卡片存的是合约)。 */
function legLabel(symbol, secType, contract) {
  const c = contract || {};
  if (secType === 'BAG') return c.label ? `${symbol} · ${c.label}` : `${symbol} 组合`;
  if (secType !== 'OPT' && secType !== 'FOP') return symbol;
  let expiry = String(c.lastTradeDateOrContractMonth || '').slice(0, 8);
  if (expiry.length === 8) expiry = `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6)}`;
  const strike = c.strike != null ? String(Number(c.strike)) : '';
  const right = String(c.right || '').slice(0, 1).toUpperCase();
  return [symbol, strike + right, expiry].filter((s) => s.trim()).join(' ');
}

/** 一条持仓(正股、期权腿或组合)的卡片主体:数量、成本、现价、盈亏、追踪表单。 */
function positionBody(p, node, compact) {
  const isCombo = p.sec_type === 'BAG';
  const unit = isCombo ? '组' : p.sec_type === 'OPT' ? '张' : '股';
  const meta = el('div', 'card-meta');
  meta.appendChild(el('span', null, `${Math.abs(p.quantity)} ${unit}`));
  // 组合的成本/现价是"每组净价"(IBKR 口径含乘数的成本 → 按乘数折回每股价),借方/贷方要标出来
  const perUnit = (v) => (isCombo && v != null ? v / (p.multiplier || 100) : v);
  meta.appendChild(el('span', null,
    `${isCombo ? (p.net_side === 'credit' ? '净收' : '净付') : '成本'} ${fmtMoney(perUnit(p.avg_cost))}`));
  meta.appendChild(el('span', isCombo ? 'strong' : null,
    p.market_price != null ? `${isCombo ? '组合现价' : '现价'} ${fmtMoney(p.market_price)}` : `${isCombo ? '组合现价' : '现价'} —`));
  if (!compact) meta.appendChild(el('span', null, `账户 ${p.account}`));
  node.appendChild(meta);

  const pnlRow = el('div', 'card-meta');
  pnlRow.appendChild(el('span', null, isCombo ? '组合未实现盈亏' : '未实现盈亏'));
  pnlRow.appendChild(pnlNode(p.unrealized_pnl, p.unrealized_pct != null ? Number(p.unrealized_pct).toFixed(2) : null));
  if (p.pnl_source === 'computed') {
    const src = el('span', 'muted', '本地按现价计算');
    src.title = '券商这条路没报盈亏(只给了成本),这里用与追踪器同一套口径算出来;对账以券商为准。';
    pnlRow.appendChild(src);
  }
  node.appendChild(pnlRow);

  if (p.tracked) {
    node.appendChild(el('div', 'muted', '已在追踪中,设置见下方。'));
  } else {
    node.appendChild(trackForm(p));
  }
}

function renderPositions() {
  const box = $('positions');
  if (!tracker.positions.length) {
    return empty(box, state.connected
      ? '这个账户里没有持仓。'
      : `连接${gatewayName()}之后才能读到持仓。`);
  }
  clear(box);
  const byKey = new Map(tracker.positions.map((p) => [p.key, p]));
  const combos = tracker.positions.filter((p) => p.sec_type === 'BAG');
  const inCombo = new Set(combos.flatMap((c) => c.legs || []));

  // 组合优先:一只蝴蝶就是一张卡,组合价格与盈亏在最上面,整组一个追踪表单;
  // 腿明细折叠在下面,想按腿追踪再展开。
  for (const combo of combos) {
    const node = el('div', 'card info');
    const head = el('div', 'card-title');
    head.appendChild(el('span', null, `${combo.symbol} · ${combo.label}`));
    head.appendChild(el('span', `side ${combo.quantity > 0 ? 'buy' : 'sell'}`,
      combo.net_side === 'credit' ? '贷方(收权利金)' : '借方(付权利金)'));
    node.appendChild(head);
    positionBody(combo, node, false);

    const legs = (combo.legs || []).map((k) => byKey.get(k)).filter(Boolean);
    const details = el('details', 'combo-legs');
    details.appendChild(el('summary', 'muted', `腿明细(${legs.length})· 按腿追踪`));
    for (const p of legs) {
      const legNode = el('div', 'card');
      const legHead = el('div', 'card-title');
      legHead.appendChild(el('span', null, p.label || legLabel(p.symbol, p.sec_type, p.contract)));
      legHead.appendChild(el('span', `side ${p.quantity > 0 ? 'buy' : 'sell'}`,
        p.quantity > 0 ? '多头' : '空头'));
      legNode.appendChild(legHead);
      positionBody(p, legNode, true);
      details.appendChild(legNode);
    }
    node.appendChild(details);
    box.appendChild(node);
  }

  for (const p of tracker.positions) {
    if (p.sec_type === 'BAG' || inCombo.has(p.key)) continue;
    const node = el('div', 'card info');
    const head = el('div', 'card-title');
    head.appendChild(el('span', null, p.label || legLabel(p.symbol, p.sec_type, p.contract)));
    head.appendChild(el('span', `side ${p.quantity > 0 ? 'buy' : 'sell'}`,
      p.quantity > 0 ? '多头' : '空头'));
    node.appendChild(head);
    positionBody(p, node, false);
    box.appendChild(node);
  }
}

/** 给一个持仓配止盈止损的表单。刻意做在卡片里——设置的对象就在眼前,不用记。 */
function trackForm(p) {
  const form = el('div', 'track-form');
  const mk = (label, hint, value) => {
    const wrap = el('label', 'track-field');
    wrap.appendChild(el('span', null, label));
    const input = el('input');
    input.type = 'number';
    input.step = '0.01';
    input.min = '0';
    input.placeholder = hint;
    if (value) input.value = value;
    wrap.appendChild(input);
    form.appendChild(wrap);
    return input;
  };
  const long = p.quantity > 0;
  const tp = mk('止盈价', long ? '高于现价' : '低于现价');
  const sl = mk('止损价', long ? '低于现价' : '高于现价');
  // 两个"追踪"是不同刻度,标签必须自解释:价格回撤 5% 在利润口径上
  // 会被成本杠杆放大(如成本 200 峰值 260 时 ≈ 利润回撤 21.7%)
  const trail = mk('跟踪止损 %(按价格)', '价格从峰值回落 N%,全平');
  const profitDd = mk('利润回撤 %(按利润)', '利润从峰值缩水 N%');
  // 分档回撤:蝶式那套 40/30/20。勾上之后固定百分比让位给档位——蝶式的盈利有硬天花板
  // (最大值 = 翼宽),浮盈越大剩余上涨空间越小,越该收紧。
  const tierWrap = el('label', 'switch');
  const tierText = el('span', null, '分档利润回撤(蝶式 40/30/20)');
  tierText.appendChild(el('span', 'sub',
    '按浮盈相对成本的倍数换档:<1× 让 40%、1–3× 让 30%、≥3× 让 20%,15:00 后一律减半。' +
    '勾上就不看上面那个固定百分比'));
  tierWrap.appendChild(tierText);
  const tiers = el('input');
  tiers.type = 'checkbox';
  tierWrap.appendChild(tiers);
  form.appendChild(tierWrap);
  tiers.addEventListener('change', () => {
    profitDd.disabled = tiers.checked;
    if (tiers.checked) profitDd.value = '';
  });
  // 触发后平掉多少仓位:100 = 全平,50 = 卖一半锁利。向下取整,绝不超过持仓
  const fraction = mk('触发后平仓比例 %', '默认 100 全平,50=卖一半');

  const autoWrap = el('label', 'switch');
  const autoText = el('span', null, '到价自动平仓');
  autoText.appendChild(el('span', 'sub',
    '到价即自动发平仓单,不再询问;仍受 auto_execute / 实盘开关 / 熔断约束'));
  autoWrap.appendChild(autoText);
  const auto = el('input');
  auto.type = 'checkbox';
  autoWrap.appendChild(auto);
  form.appendChild(autoWrap);

  const typeWrap = el('label', 'track-field');
  typeWrap.appendChild(el('span', null, '平仓方式'));
  const select = el('select');
  for (const [v, t] of [['MKT', '市价(一定成交)'], ['LMT', '限价(控价,可能不成交)']]) {
    const opt = el('option', null, t);
    opt.value = v;
    select.appendChild(opt);
  }
  typeWrap.appendChild(select);
  form.appendChild(typeWrap);

  // 托管到券商:GTC+OCA 挂在 IBKR 服务器,关机也生效;富途账户引擎会当场拒绝
  const hostWrap = el('label', 'switch');
  const hostText = el('span', null, '止盈/止损托管到券商(IBKR)');
  hostText.appendChild(el('span', 'sub',
    'GTC 单挂在券商服务器,关机也触发,不受本机轮询与行情延迟影响。' +
    '利润回撤为动态停损,软件开着时按秒调整,关掉则停在最后价位'));
  hostWrap.appendChild(hostText);
  const host = el('input');
  host.type = 'checkbox';
  hostWrap.appendChild(host);
  form.appendChild(hostWrap);
  if (p.sec_type === 'BAG') {
    // 自动平仓已打通:引擎盯盘、到价发反向腿的 BAG 限价单(组合一律不发市价单)。
    // 托管这条路没核对过——组合的 GTC+OCA 在 IBKR 侧支持不明,继续拦着。
    host.disabled = true;
    select.value = 'LMT';
    select.disabled = true;
    // 闸门按账户分:纸面账户组合追踪与自动平仓**完全放开**,只有实盘要额外开关。
    // 原来把"实盘"埋在长句尾巴上,看起来像是组合一律受限,反而让人不敢在模拟盘上测。
    const acctInfo = pickableAccounts().find((a) => a.alias === p.account);
    const isPaper = acctInfo ? acctInfo.is_paper : true;
    const note = el('div', 'muted');
    note.appendChild(el('div', null,
      '组合按整组净价触发。平仓会发一张腿方向全部反转的 BAG 限价单' +
      '(组合不发市价单:每条腿各吃一次价差)。托管到券商对组合仍不可用。'));
    const gate = el('div', null);
    if (isPaper) {
      gate.appendChild(el('span', 'tag paper', '模拟账户'));
      gate.appendChild(el('span', null,
        ' 组合追踪与到价自动平仓已完全开放,不需要任何额外开关——就在这里测。'));
    } else {
      gate.appendChild(el('span', 'tag live', '实盘账户'));
      gate.appendChild(el('span', null,
        ' 组合平仓单还没在实盘核对过:到价会算、会提醒,但不会发单,' +
        '除非在配置里打开 policies.allow_combo_live。建议先在模拟账户跑通。'));
    }
    note.appendChild(gate);
    form.appendChild(note);
  }

  const btn = el('button', 'btn primary tiny', '开始追踪');
  btn.addEventListener('click', async () => {
    const spec = {
      key: p.key,
      take_profit: tp.value.trim(),
      stop_loss: sl.value.trim(),
      trail_pct: trail.value.trim(),
      profit_drawdown_pct: tiers.checked ? '' : profitDd.value.trim(),
      profit_drawdown_preset: tiers.checked ? 'fly' : undefined,
      close_fraction_pct: fraction.value.trim() || undefined,
      auto_close: auto.checked,
      order_type: select.value,
      host_at_broker: host.checked,
    };
    if (spec.host_at_broker && !spec.auto_close) {
      // 托管单就是授权发单——没有总开关的托管是自相矛盾的设置
      showBanner('托管到券商需先打开「到价自动平仓」:挂托管单即发单授权。', false);
      return;
    }
    if (spec.host_at_broker) {
      const ok = await window.dafri.confirm({
        title: '托管到券商服务器',
        message: `${p.symbol} 的止盈/止损将作为 GTC 单挂在券商服务器上。`,
        detail: `数量 ${Math.abs(p.quantity)} · 账户 ${p.account}\n` +
          '软件关闭后托管单仍然有效;利润回撤停损停在最后一次调整的价位。\n' +
          '触发由券商实时行情决定,一张成交其余自动撤销(OCA)。',
        confirmLabel: '我确认',
      });
      if (!ok) return;
    } else if (spec.auto_close) {
      // 这一步是在授权软件替你发单,值得一次明确的确认
      const ok = await window.dafri.confirm({
        title: '开启到价自动平仓',
        message: `${p.symbol} 到价后会自动发出平仓单,不再询问。`,
        detail: `数量 ${Math.abs(p.quantity)} · 账户 ${p.account} · ${
          select.value === 'MKT' ? '市价平仓' : '限价平仓'}\n软件关闭后不再盯盘。`,
        confirmLabel: '我确认',
      });
      if (!ok) return;
    }
    const restore = busy(btn);
    try {
      const created = await window.dafri.addTracker(spec);
      showBanner(`已开始追踪 ${p.symbol},下面「正在追踪」里可以看盯盘进度。`, true);
      await loadTracker(true);
      // 点完按钮页面纹丝不动,人不知道追踪到底建没建。滚到那张卡片并闪一下。
      revealTrack((created && created.track && created.track.id) || null);
    } catch (err) {
      showBanner(err.message, false);
    } finally {
      restore();
    }
  });
  form.appendChild(btn);
  return form;
}

/** 建完追踪后把视线带过去:滚到「正在追踪」,并把那张新卡片闪一下。
 * 没有这一步,点完按钮页面不动,人不知道到底建没建成。 */
function revealTrack(trackId) {
  const box = $('trackers');
  if (!box) return;
  const heading = box.previousElementSibling;
  (heading || box).scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (!trackId) return;
  const node = box.querySelector(`[data-track-id="${trackId}"]`);
  if (!node) return;
  node.classList.add('just-added');
  setTimeout(() => node.classList.remove('just-added'), 1800);
}

/** 一条"离触发还有多远"的量表。没有现价就不画——画一条假的比不画更坏。 */
function trackGauge(live, targets) {
  const box = el('div', 'track-gauge');
  const price = live.price;
  if (price == null) {
    box.appendChild(el('span', 'muted', '拿不到现价,本轮不判断'));
    return box;
  }
  const rows = [];
  const pending = [];
  // 利润回撤(含分档):引擎每轮算出当前档位与它对应的价格
  const hasTrail = Boolean(targets.profit_drawdown_tiers) || targets.profit_drawdown_pct != null;
  if (live.profit_trail_stop != null) {
    const pct = live.profit_drawdown_threshold;
    rows.push({
      label: pct != null ? `利润回撤 ${fmtNum(pct)}%` : '利润回撤',
      target: live.profit_trail_stop,
      note: live.profit_peak != null ? `峰值利润 ${fmtMoney(live.profit_peak)}` : '',
      tone: 'warn',
    });
  } else if (hasTrail) {
    // 设了回撤、但峰值利润还没越过成本:回撤无从谈起,不是"没设"。
    // 这两件事看起来一样,说反了会让人以为设置没生效。
    const peak = live.profit_peak;
    pending.push(peak != null && peak <= 0
      ? `利润回撤已设,但这笔从建仓起还没盈利过(峰值利润 ${fmtMoney(peak)})——` +
        '先转正才会开始算回撤,在那之前只有止损能保护它。'
      : '利润回撤已设,等第一次盈利后开始记峰值。');
  }
  if (targets.take_profit != null) {
    rows.push({ label: '止盈', target: targets.take_profit, note: '', tone: 'ok' });
  }
  if (live.stop_effective != null) {
    rows.push({ label: live.trail_stop != null && live.stop_effective === live.trail_stop
      ? '跟踪止损' : '止损', target: live.stop_effective, note: '', tone: 'bad' });
  }
  if (!rows.length && !pending.length) {
    box.appendChild(el('span', 'muted', '没设任何触发条件,只是挂着看'));
    return box;
  }
  for (const text of pending) box.appendChild(el('div', 'muted', text));
  for (const r of rows) {
    const line = el('div', 'gauge-row');
    line.appendChild(el('span', 'gauge-label', r.label));
    const gap = r.target - price;
    const pct = price ? Math.abs(gap / price) * 100 : 0;
    const bar = el('div', 'gauge-bar');
    const fill = el('i', `gauge-fill ${r.tone}`);
    // 距离越近条越满:20% 以外就算"还远",满格 = 已经贴着触发价
    fill.style.width = `${Math.max(2, Math.min(100, 100 - Math.min(pct, 20) * 5))}%`;
    bar.appendChild(fill);
    line.appendChild(bar);
    line.appendChild(el('span', 'gauge-value',
      `${fmtMoney(r.target)} · ${gap >= 0 ? '还差 +' : '还差 '}${fmtNum(gap, 4)}(${fmtNum(pct, 1)}%)`));
    if (r.note) line.appendChild(el('span', 'muted', r.note));
    box.appendChild(line);
  }
  return box;
}

function renderTrackers() {
  const box = $('trackers');
  if (!tracker.tracks.length) {
    return empty(box, '还没有在追踪任何持仓。在上面的持仓卡片里设置止盈止损。');
  }
  clear(box);
  for (const t of tracker.tracks) {
    const live = tracker.rows[t.id] || {};
    const fired = Boolean(t.fired_at);
    const kind = fired ? (t.fired_state === 'take_profit' ? 'ok' : 'bad')
      : t.enabled ? 'info' : 'warn';
    const node = el('div', `card ${kind}`);
    node.dataset.trackId = t.id;

    const head = el('div', 'card-title');
    head.appendChild(el('span', null, `${legLabel(t.symbol, t.sec_type, t.contract)} · ${t.account}`));
    head.appendChild(el('span', `status ${fired ? (t.fired_state === 'take_profit' ? 'filled' : 'rejected') : 'pending'}`,
      fired ? TRACK_STATE_LABEL[t.fired_state] || '已触发'
        : t.enabled ? (TRACK_STATE_LABEL[live.state] || '持有中') : '已暂停'));
    node.appendChild(head);

    const targets = t.targets || {};
    const meta = el('div', 'card-meta');
    if (targets.take_profit) meta.appendChild(el('span', null, `止盈 ${fmtMoney(targets.take_profit)}`));
    if (targets.stop_loss) meta.appendChild(el('span', null, `止损 ${fmtMoney(targets.stop_loss)}`));
    const ddTiers = targets.profit_drawdown_tiers || null;
    if (targets.profit_drawdown_pct || ddTiers) {
      const frac = (t.auto_close || {}).close_fraction_pct;
      // 分档时阈值每一轮都可能变,显示当前生效的那一档而不是配置里的静态值
      const now = live.profit_drawdown_threshold;
      const label = ddTiers
        ? `利润回撤 分档${now != null ? ` · 当前 ${now}%` : ''}`
        : `利润回撤 ${targets.profit_drawdown_pct}%`;
      meta.appendChild(el('span', null, `${label}${frac && frac < 100 ? ` → 平 ${frac}%` : ''}`));
      if (ddTiers && live.profit_peak != null) {
        meta.appendChild(el('span', null, `峰值利润 ${fmtMoney(live.profit_peak)}`));
      }
    }
    if (targets.trail_pct) {
      const s = el('span', null, `跟踪 ${targets.trail_pct}%`);
      if (live.trail_stop) s.textContent += ` → ${fmtMoney(live.trail_stop)}`;
      meta.appendChild(s);
    }
    if (t.peak) meta.appendChild(el('span', null, `最有利价 ${fmtMoney(t.peak)}`));
    meta.appendChild(el('span', (t.auto_close || {}).enabled ? 'tag live' : 'tag paper',
      (t.auto_close || {}).enabled ? '自动平仓已开' : '仅提醒'));
    node.appendChild(meta);

    // 券商托管状态:每张托管单一个 chip,来自按秒的 reconcile 结果
    if ((t.auto_close || {}).host_at_broker) {
      const hosted = tracker.hosted[t.id];
      const row = el('div', 'card-meta');
      row.appendChild(el('span', 'tag live', '券商托管'));
      const orders = (hosted && hosted.orders) || [];
      if (orders.length) {
        for (const o of orders) {
          row.appendChild(el('span', null,
            o.kind === 'ptrail' ? `${o.label}(秒级调整)` : o.label));
        }
      } else {
        row.appendChild(el('span', 'muted', state.connected
          ? '托管单尚未挂出(对账中,或被闸门拦住——看下方提示)'
          : `连接${gatewayName()}后自动挂出`));
      }
      if (tracker.delayed) {
        row.appendChild(el('span', 'muted',
          '行情可能延迟:动态调整或滞后;触发由券商实时行情决定,不受影响'));
      }
      node.appendChild(row);
    }

    if (live.unrealized_pnl !== undefined) {
      const row = el('div', 'card-meta');
      row.appendChild(el('span', null, '未实现盈亏'));
      row.appendChild(pnlNode(live.unrealized_pnl, live.unrealized_pct));
      if (live.price != null) row.appendChild(el('span', null, `现价 ${fmtMoney(live.price)}`));
      node.appendChild(row);
    }
    // 盯盘条:离触发还有多远。百分比看不出紧迫感,画出来才一眼看得懂;
    // 分档回撤的触发价每轮都会跳,所以取引擎算好的那个,不在界面上按配置自己算。
    if (!fired && t.enabled) node.appendChild(trackGauge(live, targets));
    if (live.reason) node.appendChild(el('div', 'reason', live.reason));
    if (live.blocked && live.blocked.length) {
      node.appendChild(card('warn', '到价了但没有平仓', live.blocked.join('、')));
    }

    const actions = el('div', 'row tight');
    const toggle = el('button', 'btn tiny', t.enabled ? '暂停' : '恢复');
    toggle.addEventListener('click', async () => {
      const restore = busy(toggle);
      try {
        await window.dafri.updateTracker({ id: t.id, enabled: !t.enabled });
        await loadTracker(false);
      } catch (err) {
        showBanner(err.message, false);
      } finally {
        restore();
      }
    });
    actions.appendChild(toggle);

    const closeNow = el('button', 'btn warn tiny', '立即平仓');
    closeNow.addEventListener('click', async () => {
      const ok = await window.dafri.confirm({
        title: '立即平仓',
        message: `马上把 ${t.symbol} 的持仓平掉?`,
        detail: '这会立刻发出一张平仓单,和到价自动平仓走的是同一条路。',
        confirmLabel: '平仓',
      });
      if (!ok) return;
      const restore = busy(closeNow);
      try {
        const res = await window.dafri.closePositionNow(t.id);
        showBanner(`平仓单已发出:${res.fired.reason}`, true);
        await Promise.all([loadTracker(true), loadRecords()]);
      } catch (err) {
        showBanner(err.message, false);
      } finally {
        restore();
      }
    });
    actions.appendChild(closeNow);

    const del = el('button', 'btn tiny ghost', '删除');
    del.addEventListener('click', async () => {
      const ok = await window.dafri.confirm({
        message: `不再追踪 ${t.symbol}?`,
        detail: '只删除追踪设置,不影响持仓本身。',
        confirmLabel: '删除',
      });
      if (!ok) return;
      try {
        await window.dafri.deleteTracker(t.id);
        await loadTracker(false);
      } catch (err) {
        showBanner(err.message, false);
      }
    });
    actions.appendChild(del);
    node.appendChild(actions);
    box.appendChild(node);
  }
}

/**
 * 盯盘一轮。**不看当前在哪一页**——止损要保命,切走了还得盯着。
 * 和价位警告的轮询是同一个道理。
 */
async function pollTrackers() {
  if (tracker.busy || !state.connected) return;
  if (!tracker.tracks.length) return;
  tracker.busy = true;
  try {
    const result = await window.dafri.pollTrackers();
    tracker.rows = {};
    for (const row of result.rows || []) tracker.rows[row.id] = row;
    if ((result.fired || []).length) {
      for (const f of result.fired) {
        pushNotification(`自动平仓:${f.symbol}`, f.reason);
      }
      await Promise.all([loadTracker(true), loadRecords()]);
      return;
    }
    // 1 秒一轮之后,盘口不动的那些轮次不该重建 DOM——重建会把用户正按下去的按钮
    // 换掉,点击就丢了。只有真正影响显示的字段变了才重绘。
    const sig = JSON.stringify((result.rows || []).map((r) => [
      r.id, r.state, r.price, r.unrealized_pnl, r.profit_peak,
      r.profit_drawdown_threshold, r.profit_trail_stop, r.stop_effective, r.blocked,
    ]));
    if (sig !== tracker.sig) {
      tracker.sig = sig;
      if (document.querySelector('.tab-panel.active')?.id === 'tab-tracker') renderTrackers();
    }
  } catch {
    /* 单轮失败不打断界面;下一轮再来 */
  } finally {
    tracker.busy = false;
  }
}

/**
 * 券商托管对账,一秒一轮。把"追踪设置"和券商侧挂着的托管单对齐:
 * 该挂的挂上、利润回撤的动态停损价随峰值棘轮上移、不该在的撤掉。
 * 软件关掉不影响已挂的托管单——这正是托管的意义;这个循环只负责"调整"。
 */
async function reconcileHosted() {
  if (reconcileHosted.busy || !state.connected) return;
  if (!(tracker.tracks || []).some((t) => (t.auto_close || {}).host_at_broker)) return;
  reconcileHosted.busy = true;
  try {
    const result = await window.dafri.reconcileTrackers();
    tracker.hosted = {};
    for (const h of result.hosted || []) tracker.hosted[h.id] = h;
    tracker.delayed = Boolean(result.quote_maybe_delayed);
    // 每秒都重画会打断正在点按钮的手:只有内容变了、且正停在本页才重画
    const snap = JSON.stringify([tracker.hosted, tracker.delayed, result.blocked || []]);
    if (snap !== reconcileHosted.last) {
      reconcileHosted.last = snap;
      if (document.querySelector('.tab-panel.active')?.id === 'tab-tracker') renderTrackers();
    }
  } catch {
    /* 单轮失败不打扰;托管单仍在券商侧站岗,下一秒再对 */
  } finally {
    reconcileHosted.busy = false;
  }
}

// ======================================================================
// 富途 OpenD 接入
// ======================================================================
const BROKER_HINT = {
  ibkr: '需本机运行并登录 TWS 或 IB Gateway。支持组合单(价差 / 蝴蝶 / 铁鹰)。',
  futu: '需本机运行并登录富途 OpenD。不支持组合单,多腿结构会被拒绝。',
};

async function loadFutu() {
  await Promise.all([loadBrokerSwitch(), scanFutu()]);
}

async function loadBrokerSwitch() {
  const box = $('broker-switch');
  try {
    const catalog = await window.dafri.brokerCatalog();
    renderBrokerSwitch(catalog);
    renderTwsBrokerBanner(catalog);
    renderFutuUnlockState(catalog);
  } catch (err) {
    empty(box, `读取失败:${err.message}`);
  }
}

function renderBrokerSwitch(catalog) {
  const box = $('broker-switch');
  clear(box);
  for (const provider of catalog.providers || []) {
    const conns = Object.entries(provider.connections || {});
    const node = card(
      provider.current ? 'ok' : 'warn',
      `${provider.label}${provider.current ? ' · 当前生效' : ''}`,
      BROKER_HINT[provider.key] || ''
    );
    const meta = el('div', 'card-meta');
    meta.appendChild(
      el(
        'span',
        null,
        conns.length
          ? conns.map(([name, c]) => `${name} ${c.host}:${c.port}`).join(' · ')
          : '未配置连接'
      )
    );
    meta.appendChild(el('span', null, `${(provider.accounts || []).length} 个账户`));
    node.appendChild(meta);

    if (provider.config_snippet) {
      // 账户与连接不给界面通道(§9.6),那至少别让人去猜字段名和默认端口
      const tip = el('div', null, '尚未配置连接与账户。把下面这段并入 config/settings.json 后再切换:');
      tip.style.marginTop = '8px';
      node.appendChild(tip);
      const pre = el('pre', 'snippet', provider.config_snippet);
      node.appendChild(pre);
    } else if (!provider.current) {
      const btn = el('button', 'btn tiny', `切到${provider.label}`);
      btn.addEventListener('click', () => switchBroker(provider, btn));
      node.appendChild(btn);
    }
    box.appendChild(node);
  }
}

async function switchBroker(provider, btn) {
  // 换券商 = 换下单出口。不该点一下就生效,先把后果讲清楚
  const ok = await window.dafri.confirm({
    message: `把下单出口切到「${provider.label}」?`,
    detail:
      '现有的券商连接会先断开,选择会写进配置文件。' +
      (provider.key === 'futu' ? ' 富途不支持组合单:价差 / 蝴蝶 / 铁鹰会被引擎拒绝。' : ''),
    confirmLabel: '切换',
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    await window.dafri.selectBroker(provider.key);
    showBanner(`已切到 ${provider.label}。请在下面点「连接 / 断开交易引擎」重新连接。`, true);
    await loadBrokerSwitch();
    await refreshStatus();
  } catch (err) {
    showBanner(`切换失败:${err.message}`, false);
  } finally {
    btn.disabled = false;
  }
}

function renderTwsBrokerBanner(catalog) {
  const box = $('tws-broker-banner');
  if (!box) return;
  clear(box);
  if (catalog.current === 'ibkr') {
    box.className = 'notice';
    box.appendChild(el('strong', null, '当前券商接入:IBKR。'));
    box.appendChild(el('span', null, ' 引擎正通过此通道下单。'));
    return;
  }
  box.className = 'notice warn';
  box.appendChild(el('strong', null, '当前券商接入:富途 OpenD。'));
  box.appendChild(
    el('span', null, ' 本页仅检测 IBKR,引擎不经此下单;切换请到「富途 OpenD」页。')
  );
}

function renderFutuUnlockState(catalog) {
  const node = $('futu-unlock-state');
  if (!node) return;
  const saved = catalog.futu && catalog.futu.unlock_password_saved;
  node.textContent = saved
    ? '已存密码(md5),连接引擎后点「交易解锁」'
    : '未存密码,模拟盘不受影响,实盘单会被拦下';
}

async function scanFutu() {
  const appsBox = $('futu-apps');
  const portsBox = $('futu-ports');
  try {
    const scan = await window.dafri.scanFutu();
    renderFutuApps(scan.apps, scan.sdk_installed);
    renderPortsInto(portsBox, scan.ports, scan.connected);
    renderGuideInto($('futu-guide'), scan.guide);
  } catch (err) {
    empty(appsBox, `检测失败:${err.message}`);
    empty(portsBox, '—');
  }
}

function renderFutuApps(apps, sdkInstalled) {
  const box = $('futu-apps');
  clear(box);

  // SDK 没装的话,后面几步全都会卡在同一个地方。先把它摆在最前面,给按钮
  if (sdkInstalled === false) {
    const node = card(
      'bad',
      'futu-api(Python SDK)未安装',
      '连接 OpenD 必需;体积较大(含 pandas / protobuf),默认不装。'
    );
    const btn = el('button', 'btn tiny', '安装 futu-api');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '安装中…(需要联网)';
      try {
        await window.dafri.installFutuSdk();
        showBanner('futu-api 安装完成,引擎已重启。', true);
        setTimeout(loadFutu, 2000);
      } catch (err) {
        showBanner(`安装失败:${err.message}`, false);
      } finally {
        btn.disabled = false;
        btn.textContent = '安装 futu-api';
      }
    });
    node.appendChild(btn);
    box.appendChild(node);
  }

  for (const app of apps || []) {
    const kind = app.running ? 'ok' : app.installed ? 'warn' : 'bad';
    const stateText = app.running
      ? '正在运行'
      : app.installed
        ? '已安装,未运行'
        : '未找到(绿色包放在非常见目录时检测不到,可手动启动)';
    const node = card(kind, app.name, stateText, app.paths.length ? [app.paths[0]] : []);

    if (app.installed && !app.running) {
      const btn = el('button', 'btn tiny', `启动 ${app.name}`);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await window.dafri.launchFutu();
          pushNotification(`已启动 ${app.name}`, '请在它自己的窗口里登录');
          setTimeout(scanFutu, 4000);
        } catch (err) {
          showBanner(`启动失败:${err.message}`, false);
        } finally {
          btn.disabled = false;
        }
      });
      node.appendChild(btn);
    }
    box.appendChild(node);
  }
}

async function diagnoseFutu() {
  const box = $('futu-diagnosis');
  const restore = busy($('btn-futu-diagnose'));
  working(box, '正在握手…(OpenD 需已登录,否则超时)');
  try {
    const { results } = await window.dafri.diagnoseFutu();
    clear(box);
    for (const result of results) box.appendChild(renderFutuDiagnosis(result));
  } catch (err) {
    empty(box, `诊断失败:${err.message}`);
  } finally {
    restore();
  }
}

function renderFutuDiagnosis(result) {
  const kind = result.connected && !result.error ? 'ok' : result.connected ? 'warn' : 'bad';
  const title = `连接 ${result.connection} · ${result.host ?? '—'}:${result.port ?? '—'}`;
  const node = card(kind, title, result.connected ? '握手成功' : '未连接');

  if (result.connected) {
    const meta = el('div', 'card-meta');
    meta.appendChild(el('span', null, `OpenD 版本 ${result.server_version ?? '—'}`));
    meta.appendChild(el('span', null, `行情登录 ${loginText(result.qot_logined)}`));
    meta.appendChild(el('span', null, `交易登录 ${loginText(result.trd_logined)}`));
    if (result.port_latency_ms !== null && result.port_latency_ms !== undefined) {
      meta.appendChild(el('span', null, `${result.port_latency_ms} ms`));
    }
    node.appendChild(meta);
  }

  if (result.error) node.appendChild(el('div', 'reason', result.error));
  if (result.hint) {
    const hint = el('div', null, result.hint);
    hint.style.marginTop = '6px';
    node.appendChild(hint);
  }

  const rows = (result.accounts || []).filter((a) => a.connection === result.connection);
  if (rows.length) {
    const list = el('div');
    list.style.marginTop = '8px';
    for (const account of rows) {
      const row = el('div', 'acct-row');
      row.appendChild(el('span', null, `${account.alias} → ${account.account_masked}`));
      row.appendChild(
        el(
          'span',
          account.resolved ? 'acct-ok' : 'acct-bad',
          account.resolved ? '✓ 对得上' : '✗ 不在可管账户里'
        )
      );
      list.appendChild(row);
    }
    node.appendChild(list);
  }
  return node;
}

function loginText(value) {
  if (value === true) return '已登录';
  if (value === false) return '未登录';
  return '未知';
}

async function saveFutuPassword() {
  const input = $('futu-password');
  if (!input.value) return;
  const btn = $('btn-futu-save-password');
  btn.disabled = true;
  try {
    await window.dafri.setFutuPassword(input.value, $('futu-password-md5').checked);
    input.value = '';
    await loadBrokerSwitch();
    showBanner('交易密码已写入 Keychain(只存 md5)。', true);
  } catch (err) {
    showBanner(`写入失败:${err.message}`, false);
  } finally {
    btn.disabled = false;
  }
}

async function unlockFutu() {
  const btn = $('btn-futu-unlock');
  btn.disabled = true;
  try {
    const result = await window.dafri.unlockFutu();
    const failed = Object.entries(result.failed || {}).map(([name, msg]) => `${name}(${msg})`);
    if ((result.unlocked || []).length) {
      const tail = failed.length ? `;失败:${failed.join('、')}` : '';
      showBanner(`已解锁:${result.unlocked.join('、')}${tail}`, !failed.length);
    } else {
      showBanner(`解锁失败:${failed.join('、') || '没有可解锁的连接'}`, false);
    }
  } catch (err) {
    showBanner(`解锁失败:${err.message}`, false);
  } finally {
    btn.disabled = false;
  }
}

// ======================================================================
// 关于
// ======================================================================
// 注册在案的快捷键。别在这里编不存在的——列表本身就是承诺。
const SHORTCUTS = [
  { keys: ['mod', 'Enter'], what: '解析当前指令(不发送)' },
  { keys: ['mod', 'Shift', 'Enter'], what: '解析并发送(有确认框)' },
  { keys: ['mod', 'Shift', 'H'], what: '暂停全部自动执行(熔断)' },
  { keys: ['mod', 'R'], what: '刷新状态' },
  { keys: ['Esc'], what: '收起打开的记录详情' },
  { keys: ['↑', '↓'], what: '侧栏导航移动(焦点在侧栏时)' },
];

function renderShortcuts() {
  const box = document.getElementById('shortcuts');
  if (!box) return;
  clear(box);
  const mod = MOD_KEY === '⌘' ? '⌘' : 'Ctrl';
  for (const item of SHORTCUTS) {
    const dt = el('dt');
    item.keys.forEach((k) => dt.appendChild(el('kbd', null, k === 'mod' ? mod : k)));
    box.appendChild(dt);
    box.appendChild(el('dd', null, item.what));
  }
}
async function loadAbout() {
  renderShortcuts();
  try {
    const [info, selftest] = await Promise.all([window.dafri.appInfo(), window.dafri.selftest()]);
    const box = $('about');
    clear(box);
    const dl = el('dl');
    const rows = [
      ['应用版本', info.version],
      ['Electron', info.electron],
      ['Chromium', info.chrome],
      ['Node', info.node],
      ['配置文件', info.configPath],
      ['提示词', `${selftest.prompt_version} · ${selftest.prompt_fingerprint}`],
      ['系统提示词', `${selftest.system_prompt_chars} 字 / ${selftest.fewshot_pairs} 组少样本`],
      ['账户', selftest.accounts.map((a) => `${a.alias}(${a.account_masked}${a.is_paper ? ' 纸面' : ' 实盘'})`).join('、')],
    ];
    for (const [key, value] of rows) {
      dl.appendChild(el('dt', null, key));
      dl.appendChild(el('dd', null, value ?? '—'));
    }
    box.appendChild(dl);
  } catch (err) {
    empty($('about'), `读取失败:${err.message}`);
  }
}

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
  // 用过一次就记住收起状态,别每次都占一块
  const shorthand = document.getElementById('shorthand-panel');
  if (shorthand) {
    try {
      if (localStorage.getItem('dafri.shorthand.closed') === '1') shorthand.open = false;
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

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
        t.tabIndex = -1;                 // 只让当前项进 Tab 序列,这是 tablist 的规矩
      });
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      tab.tabIndex = 0;
      $(`tab-${tab.dataset.tab}`).classList.add('active');
      auto.last[tab.dataset.tab] = Date.now();  // 切页时已手动加载,自动刷新从现在起算
      if (tab.dataset.tab === 'about') loadAbout();
      if (tab.dataset.tab === 'settings') loadSettings();
      // 切回主页面时把光标放回输入框:这是整个软件唯一的主动作,
      // 每次都要用鼠标点一下才能打字是白白多出来的一步
      if (tab.dataset.tab === 'trade') $('instruction').focus();
      if (tab.dataset.tab === 'tws') { scanTws(); loadBrokerSwitch(); }
      if (tab.dataset.tab === 'futu') loadFutu();
      if (tab.dataset.tab === 'llm') loadLlm();
      if (tab.dataset.tab === 'board') { loadPending(); loadRecords(); }
      if (tab.dataset.tab === 'ideas') loadIdeas();
      if (tab.dataset.tab === 'review') loadReviewCandidates();
      if (tab.dataset.tab === 'sectors') loadSectors(true);
      if (tab.dataset.tab === 'backtest' && !bt.strategies.length) loadBacktestStrategies();
      if (tab.dataset.tab === 'book') renderBookGrid();
      if (tab.dataset.tab === 'tracker') loadTracker(true);
      if (tab.dataset.tab === 'pa') { loadPaTimeframes(); renderPa(); }
      if (tab.dataset.tab === 'alerts') loadAlerts();
    });
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

  window.dafri.on('bootstrap', ({ message }) => showBanner(message, true));
  window.dafri.on('menu', ({ action }) => {
    if (action === 'refresh') {
      refreshStatus();
      loadRecords();
      loadPending();
    }
  });
}

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
    const tab = document.querySelector('.tab.active')?.dataset.tab;
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
