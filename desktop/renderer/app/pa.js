'use strict';
// K线 PA:实时 K 线 + 价格行为分析

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

/**
 * 引擎的 readout 是一组"字段:结论"的句子(结构 / 最近结构事件 / 近端摆动序列 / 位置 / 流动性 / 形态 / 确认条件 / 失效条件)。
 * 九行散文扫不动;拆成两列,字段名进左列二级色,和记录详情那张"单据"同一做法。首句是总括,原样留着;
 * 拆不开的行(没有冒号,或冒号前不像字段名)也原样留着——界面不替引擎改写结论。
 */
function renderReadout(lines) {
  const box = el('div', 'pa-readout');
  const dl = el('dl', 'detail-grid pa-readout-grid');
  lines.forEach((line, i) => {
    const m = /^([^:：]{1,12})[:：]\s*(.+)$/.exec(String(line));
    if (i === 0 || !m) { box.appendChild(el('div', 'reason', line)); return; }
    dl.appendChild(el('dt', null, m[1].trim()));
    dl.appendChild(el('dd', null, m[2].trim()));
  });
  if (dl.children.length) box.appendChild(dl);
  return box;
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
  head.appendChild(renderReadout(r.readout || []));
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
