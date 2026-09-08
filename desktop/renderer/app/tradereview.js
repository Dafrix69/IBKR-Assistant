'use strict';
// 交易分析(蝴蝶复盘)与止盈策略回放

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

/** 标的走势:蜡烛 + 三条行权价 + 盈利区 + 止盈策略的临界线 + 开仓/平仓竖线。字段全部来自 r.series 与 r.exit_plan。 */
function renderReviewChart(r) {
  const node = card('info', `标的走势(${r.timeframe_label},开仓前后到${REVIEW_KIND[r.outcome.kind] === '持仓中' ? '现在' : '结局'})`);
  const bars = r.series.bars || [];
  if (bars.length < 2) return node;
  const levels = r.series.levels || [];
  const LEVEL_STYLE = {
    lower: { color: 'orange', dash: [4, 3], alpha: 0.8, label: '下翼' },
    center: { color: 'blue', dash: [], alpha: 0.9, label: '中心' },
    upper: { color: 'orange', dash: [4, 3], alpha: 0.8, label: '上翼' },
    lower_be: { color: 'up', dash: [2, 2], alpha: 0.6, tag: false, label: '盈亏平衡' },
    upper_be: { color: 'up', dash: [2, 2], alpha: 0.6, tag: false, label: '盈亏平衡' },
  };
  const hlines = [];
  for (const l of levels) {
    const st = LEVEL_STYLE[l.kind];
    if (st) hlines.push({ price: l.price, ...st });
  }
  // 止盈策略的临界线(|S−K| 的 0.45W / 0.55W / 0.8W):不撑开区间、不占轴,名字写在上沿那条线的左端
  const ZONE_STYLE = { hold: ['blue', '持有'], half: ['purple', '清半'], stop: ['down', '止损'] };
  for (const z of ((r.exit_plan || {}).zones || [])) {
    const st = ZONE_STYLE[z.kind];
    if (!st) continue;
    hlines.push({ price: z.high, color: st[0], dash: [2, 3], alpha: 0.45, tag: false, fit: false, label: `${st[1]} ±${z.half_width}` });
    hlines.push({ price: z.low, color: st[0], dash: [2, 3], alpha: 0.45, tag: false, fit: false });
  }
  const lowerBe = levels.find((l) => l.kind === 'lower_be');
  const upperBe = levels.find((l) => l.kind === 'upper_be');
  const bands = lowerBe && upperBe ? [{ top: upperBe.price, bottom: lowerBe.price, color: 'up', fill: 0.1 }] : [];
  const MARK = { entry: ['blue', '开仓'], exit: ['purple', '平仓'], expiry: ['purple', '到期'] };
  const vlines = [];
  const markers = [];
  for (const m of r.series.markers || []) {
    const st = MARK[m.kind] || MARK.entry;
    vlines.push({ time: m.time, color: st[0], label: `${st[1]} ${m.price}` });
    markers.push({ time: m.time, price: m.price, shape: 'dot', color: st[0], fit: false });
  }
  const legend = [
    ['■', 'up', '阳线'], ['■', 'down', '阴线'], ['—', 'blue', '中心'], ['╌', 'orange', '上下翼'],
    ['▮', 'up', '盈利区(到期)'], ['┆', 'blue', '开仓'], ['┆', 'purple', '平仓 / 到期'],
  ];
  if (r.exit_plan) legend.push(['╌', 'label2', '临界线 ±0.45W / 0.55W / 0.8W']);
  mountChart(node, 'mid', { ariaLabel: '标的走势', bars, hlines, bands, vlines, markers, legend, volume: false });
  return node;
}

const EXIT_LEVEL_STYLE = () => ({
  tp1: [THEME.up, '第一档'], tp2: [THEME.up, '第二档'],
  trail_arm: [THEME.orange, '回撤追踪激活'], stop: [THEME.down, '止损'],
});
const PHASE_LABEL = { A: '阶段 A', B: '阶段 B', C: '阶段 C' };

/** 蝶价走势:组合分钟中间价的蜡烛 + 模型价虚线 + 止盈/止损水平线 + 开仓/平仓/策略事件标记。 */
/** 蝶价走势:组合分钟中间价的蜡烛 + 模型价虚线 + 止盈/止损水平线 + 回撤触发价阶梯 + 开仓/平仓/策略事件标记。 */
function renderFlyChart(r) {
  const plan = r.exit_plan || {};
  const sim = plan.simulation || {};
  const fs = r.fly_series || {};
  const real = fs.bars || [];
  const path = sim.series || [];
  const node = card('info', `蝶价走势(组合中间价 · 1 分钟 · ${fs.source === 'ibkr' ? 'IBKR 真实数据' : '模型价'})`);
  // 时间轴:真实 K 线与回放序列的并集,按时间排序
  const times = Array.from(new Set([...real.map((b) => b.time), ...path.map((pt) => pt.time)])).sort();
  if (times.length < 2) {
    node.appendChild(el('p', 'empty', '没有蝶价数据:引擎未连 TWS,或 IBKR 没有这张组合的历史分钟线。'));
    return node;
  }
  const pathAt = new Map(path.map((pt) => [pt.time, pt]));
  // 阶段底色:B、C 段淡淡标出来
  const phases = [];
  let band = null;
  for (const t of times) {
    const ph = (pathAt.get(t) || {}).phase;
    if (!ph) { band = null; continue; }
    if (band && band.phase === ph) band.to = t;
    else { band = { phase: ph, from: t, to: t }; phases.push(band); }
  }
  const bands = phases.filter((b) => b.phase !== 'A').map((b) => ({
    v: true, from: b.from, to: b.to, color: b.phase === 'B' ? 'orange' : 'purple', fill: 0.06, label: PHASE_LABEL[b.phase],
  }));
  const EXIT = { tp1: ['up', '第一档'], tp2: ['up', '第二档'], trail_arm: ['orange', '回撤追踪激活'], stop: ['down', '止损'] };
  const hlines = (plan.levels || []).filter((l) => EXIT[l.kind] && l.price != null).map((l) => ({
    price: l.price, color: EXIT[l.kind][0], dash: l.kind === 'trail_arm' ? [2, 2] : [5, 3], alpha: 0.8, label: EXIT[l.kind][1],
  }));
  const lines = [
    // 模型价:只画没有真实报价的那些分钟
    { points: path.filter((pt) => pt.source === 'model').map((pt) => ({ time: pt.time, value: pt.price })), color: 'label', alpha: 0.55, dash: [3, 2], label: '模型价' },
    // 回撤触发价随浮盈高水位往上棘轮,只在激活之后有值:画成阶梯
    { points: path.filter((pt) => pt.trail_stop != null).map((pt) => ({ time: pt.time, value: pt.trail_stop })), color: 'orange', alpha: 0.85, dash: [4, 2], step: true, label: '回撤触发价' },
  ];
  const MARK = { entry: ['blue', '开仓'], exit: ['purple', '实际平仓'] };
  const markers = [];
  for (const m of fs.markers || []) {
    if (m.price == null) continue;
    const st = MARK[m.kind] || MARK.entry;
    markers.push({ time: m.time, price: m.price, shape: 'dot', color: st[0], label: `${st[1]} ${m.price}` });
  }
  for (const e of sim.events || []) {
    const color = e.source === 'settle' ? 'purple' : (e.pnl >= 0 ? 'up' : 'down');
    markers.push({ time: e.time, price: e.price, shape: 'tri-down', color, label: `策略 ${e.qty} 张 @ ${e.price}` });
  }
  const legend = [
    ['╌', 'up', '止盈档位'], ['╌', 'down', '止损'], ['╌', 'orange', '回撤激活 / 触发价'],
    ['·', 'blue', '开仓'], ['·', 'purple', '实际平仓'], ['╌', 'label2', '模型价'], ['▼', 'up', '策略出手点'],
  ];
  mountChart(node, 'mid', { ariaLabel: '蝶价走势', times, bars: real, lines, hlines, bands, markers, legend, volume: false, yMin: 0, padPct: 0.08 });
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
