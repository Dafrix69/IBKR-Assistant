'use strict';
// 交易记录

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
const TRIGGER_OP_LABEL = { '>=': '≥', '<=': '≤', '>': '>', '<': '<', '==': '=' };
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
    `${record.contract?.symbol || '—'} · ${ACTION_LABEL[record.order?.action] || record.order?.action || ''} ${record.order?.totalQuantity ?? ''}`));
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
