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

function fmtMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  connected: false,
  breakerEngaged: false,
  busy: false,
};

// ======================================================================
// 顶栏与状态
// ======================================================================
async function refreshStatus() {
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
  }
}

function renderStatus(status) {
  $('chip-clock').textContent = `美东 ${status.now_et}`;

  const market = $('chip-market');
  market.textContent = `市场 ${status.market_status}`;
  market.className = 'chip ' + (status.market_status === '盘中' ? 'ok' : 'warn');

  $('chip-model').textContent = `模型 ${status.model}`;

  const broker = $('chip-broker');
  broker.textContent = status.broker_connected ? 'TWS 已连接' : 'TWS 未连接';
  broker.className = 'chip ' + (status.broker_connected ? 'ok' : '');
  $('btn-connect').textContent = status.broker_connected ? '断开 TWS' : '连接 TWS';

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

function showBanner(message, isInfo) {
  const banner = $('banner');
  banner.textContent = message;
  banner.className = 'banner' + (isInfo ? ' info' : '');
}

function hideBanner() {
  $('banner').className = 'banner hidden';
}

// ======================================================================
// 指令提交
// ======================================================================
async function submit(execute) {
  const text = $('instruction').value.trim();
  if (!text) return;
  if (state.busy) return;

  if (execute) {
    const ok = await window.dafri.confirm({
      title: '发送真实订单',
      message: '这条指令解析后会直接发送到 IBKR,没有二次确认环节。',
      detail: text,
      confirmLabel: '我确认,发送',
    });
    if (!ok) return;
  }

  state.busy = true;
  $('btn-parse').disabled = true;
  $('btn-execute').disabled = true;
  const result = $('result');
  empty(result, execute ? '正在解析并发送…' : '正在解析…');

  try {
    const payload = await window.dafri.submit(text, execute);
    renderResult(payload);
    await Promise.all([refreshStatus(), loadRecords(), loadPending()]);
  } catch (err) {
    clear(result);
    result.appendChild(card('bad', '调用失败', err.message));
  } finally {
    state.busy = false;
    $('btn-parse').disabled = false;
    $('btn-execute').disabled = !(state.status && state.status.auto_execute && state.connected && !state.breakerEngaged);
  }
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

function renderResult(payload) {
  const box = $('result');
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
    box.appendChild(
      card('info', '本次解析', null, [
        `模型 ${payload.llm.model}`,
        `提示词 ${payload.llm.prompt_version}`,
        `${payload.llm.latency_ms} ms`,
        `in ${payload.llm.usage?.input_tokens ?? '—'} / out ${payload.llm.usage?.output_tokens ?? '—'} tokens`,
      ])
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
          `入队 ${fmtTime(item.created_at)}`,
        ])
      );
    }
  } catch (err) {
    empty($('pending-list'), `读取失败:${err.message}`);
  }
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
      record.final_status || record.status || '—',
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

function renderRecords() {
  const box = $('records');
  const keyword = $('record-filter').value.trim().toLowerCase();
  const rows = state.records.filter((r) => {
    if (!keyword) return true;
    return [r.symbol, r.reason, r.final_status, r.intent_summary, r.raw_instruction, r.account]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(keyword));
  });

  if (!rows.length) return empty(box, keyword ? '没有匹配的记录。' : '暂无记录。');
  clear(box);

  for (const record of rows) {
    const node = el('div', 'record');
    node.tabIndex = 0;

    const head = el('div', 'record-head');
    head.appendChild(el('span', 'record-sym', `${record.symbol || '—'} ${record.action || ''}`));

    const statusText = record.final_status || record.status || '进行中';
    const statusClass = record.final_status === 'filled'
      ? 'filled'
      : String(record.final_status || '').startsWith('rejected')
        ? 'rejected'
        : 'pending';
    head.appendChild(el('span', `status ${statusClass}`, statusText));
    node.appendChild(head);

    node.appendChild(el('div', null, record.intent_summary || record.raw_instruction || ''));
    if (record.reason) node.appendChild(el('div', 'reason', record.reason));

    const meta = el('div', 'card-meta');
    meta.appendChild(el('span', null, fmtTime(record.created_at)));
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
    const head = el('div', 'row tight');
    head.appendChild(el('strong', null, '记录详情'));
    const close = el('button', 'btn tiny ghost', '收起');
    close.addEventListener('click', () => detail.classList.add('hidden'));
    head.appendChild(close);
    detail.appendChild(head);
    detail.appendChild(el('pre', null, JSON.stringify(record, null, 2)));
  } catch (err) {
    clear(detail);
    detail.appendChild(el('p', 'empty', `读取失败:${err.message}`));
  }
}

// ======================================================================
// 设置
// ======================================================================
async function loadSettings() {
  try {
    const settings = await window.dafri.getSettings();
    state.settings = settings;
    $('opt-auto-execute').checked = Boolean(settings.policies.auto_execute);
    $('opt-live').checked = Boolean(settings.policies.allow_live_trading);
    $('opt-trigger-verify').checked = Boolean(settings.policies.require_trigger_price_verification);
    $('opt-notional').value = settings.limits.max_order_notional;
    $('opt-contracts').value = settings.limits.max_option_contracts;
    $('opt-mkt-shares').value = settings.limits.max_mkt_shares;
    $('opt-slippage').value = settings.limits.max_spread_slippage;
    $('opt-dupe').value = settings.limits.duplicate_window_minutes;
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
      message: '打开后,解析通过的订单会被直接发送到 IBKR,没有人工确认环节。',
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
          el('div', 'reason', '该端点不支持 json_schema,已降级为 json_object + 提示词内嵌 schema。解析可靠性会下降,拒绝率可能升高。')
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
  const box = $('tws-ports');
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
  const box = $('tws-guide');
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
  const btn = $('btn-tws-diagnose');
  btn.disabled = true;
  empty(box, '正在握手…(第一次连接时 TWS 会弹确认框,记得点 Yes)');
  try {
    const { results } = await window.dafri.diagnoseTws();
    clear(box);
    for (const result of results) {
      box.appendChild(renderDiagnosis(result));
    }
  } catch (err) {
    empty(box, `诊断失败:${err.message}`);
  } finally {
    btn.disabled = false;
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
// 关于
// ======================================================================
async function loadAbout() {
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
  $('btn-parse').addEventListener('click', () => submit(false));
  $('btn-execute').addEventListener('click', () => submit(true));
  $('btn-clear-result').addEventListener('click', () => empty($('result'), '还没有解析结果。'));
  $('btn-refresh').addEventListener('click', () => {
    refreshStatus();
    loadRecords();
    loadPending();
  });

  $('instruction').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(false);
  });

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
        pushNotification('已断开 TWS 连接');
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

  $('record-filter').addEventListener('input', renderRecords);
  $('btn-save-settings').addEventListener('click', saveSettings);

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

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`tab-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'about') loadAbout();
      if (tab.dataset.tab === 'settings') loadSettings();
      if (tab.dataset.tab === 'tws') scanTws();
      if (tab.dataset.tab === 'llm') loadLlm();
      if (tab.dataset.tab === 'board') { loadPending(); loadRecords(); }
    });
  });

  window.dafri.on('engine-event', ({ event, data }) => {
    if (event === 'notification') {
      pushNotification(data.title, data.body);
    } else if (event === 'breaker') {
      refreshStatus();
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
async function boot() {
  // macOS 之外没有 vibrancy 底材,半透明面板背后是空的 —— 换成实底
  document.documentElement.dataset.vibrancy =
    window.dafri.platform === 'darwin' ? 'on' : 'off';
  bind();
  await refreshStatus();
  await Promise.all([loadSettings(), loadRecords(), loadPending(), scanTws(), loadLlm()]);

  setInterval(refreshStatus, 5000);
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
