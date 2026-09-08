'use strict';
// 扫描:RS 强度 / 拐点筛选 / 极值偏离

// ======================================================================
// 扫描:RS 强度 / 拐点筛选 / 极值偏离(引擎纯计算;这里只管选项与展示)
// ======================================================================
const screener = {
  sectors: [],
  rs: { benchmark: 'SPY', result: null, busy: false },
  infl: { timeframes: ['1w', '1d'], result: null, busy: false },
  dev: { symbol: '', result: null, busy: false, list: [] },
};
const SCREEN_TF_LABEL = { '1w': '周线', '1d': '日线', '1h': '1 小时', '30m': '30 分', '15m': '15 分' };
const SCREEN_SECTOR_KEY = 'dafri-screener-sector';

function screenerSector() {
  try { return localStorage.getItem(SCREEN_SECTOR_KEY) || 'all'; } catch { return 'all'; }
}

/** 三个子页共用一份股票池下拉;进页时重读板块(板块页刚加的股要立刻可选)。 */
async function loadScreenerSectors(page) {
  try {
    const { sectors } = await window.dafri.listSectors();
    screener.sectors = sectors || [];
  } catch (err) {
    showBanner(`读取板块失败:${err.message}`, false);
    return;
  }
  const chosen = screenerSector();
  for (const id of ['rs-sector', 'infl-sector', 'dev-sector']) {
    const select = $(id);
    clear(select);
    const all = el('option', null, '全部板块');
    all.value = 'all';
    select.appendChild(all);
    for (const sector of screener.sectors) {
      const option = el('option', null, `${sector.name}(${sector.stocks.length})`);
      option.value = sector.id;
      select.appendChild(option);
    }
    select.value = screener.sectors.some((s) => s.id === chosen) ? chosen : 'all';
  }
  if (page === 'deviation') fillDevSymbols();
}

function rememberScreenerSector(id) {
  try { localStorage.setItem(SCREEN_SECTOR_KEY, id); } catch { /* 记不住就算了 */ }
  for (const sel of ['rs-sector', 'infl-sector', 'dev-sector']) $(sel).value = id;
}

function screenNum(v, digits = 2, sign = false) {
  if (v == null || Number.isNaN(v)) return '—';
  const text = Number(v).toFixed(digits);
  return sign && v > 0 ? `+${text}` : text;
}

function rsCell(value) {
  const td = el('td', 'rs-cell');
  if (value == null) { td.textContent = '—'; td.classList.add('dim'); return td; }
  td.textContent = `${screenNum(value, 1, true)}%`;
  td.classList.add(value >= 0 ? 'pos' : 'neg');
  td.style.setProperty('--heat', String(Math.min(40, Math.abs(value) * 1.6).toFixed(0)));
  return td;
}

function symbolLink(symbol) {
  const btn = el('button', 'sym-btn', symbol);
  btn.type = 'button';
  btn.title = '到极值偏离页复盘这只';
  btn.addEventListener('click', () => {
    screener.dev.symbol = symbol;
    document.querySelector('.tab[data-tab="deviation"]').click();
  });
  return btn;
}

// ---- RS 强度 ------------------------------------------------------------
async function runRs() {
  const st = screener.rs;
  if (st.busy) return;
  st.busy = true;
  const button = $('btn-rs-run');
  const restore = busy(button);
  $('rs-status').textContent = '正在拉日线并计算…(一个 30 只的板块约 10~30 秒)';
  try {
    st.result = await window.dafri.screenerRs({ sector: $('rs-sector').value, benchmark: st.benchmark });
    renderRs();
  } catch (err) {
    $('rs-status').textContent = '—';
    showBanner(`RS 扫描失败:${err.message}`, false);
  } finally {
    st.busy = false;
    restore();
  }
}

function renderRs() {
  const r = screener.rs.result;
  const tagsBox = $('rs-tags');
  const box = $('rs-table');
  clear(tagsBox);
  if (!r) return empty(box, '选一个股票池,点「扫描」。');
  $('rs-status').textContent = `${r.sector} · 对 ${r.benchmark}(${screenNum(r.bench_last)}) · ${r.counted}/${r.total} 只有分 · ${fmtTimeShort(r.fetched_at)}`;

  // 标签汇总卡:每个区间一格,中位数 RS + 跑赢家数
  if (r.tags.length > 1 || (r.tags[0] && r.tags[0].tag !== '未分类')) {
    const grid = el('div', 'rs-tags');
    for (const t of r.tags) {
      const cardNode = el('div', 'rs-tag-card');
      const head = el('div', 'rs-tag-head');
      head.appendChild(el('span', 'rs-tag-name', `${t.tag} · ${t.count} 只`));
      head.appendChild(el('span', 'rs-tag-score', t.score == null ? '—' : `${screenNum(t.score, 1, true)}%`));
      cardNode.appendChild(head);
      const rowNode = el('div', 'rs-tag-row');
      for (const w of r.windows) {
        const cell = t.rs[String(w.n)];
        const span = el('span', null, cell ? `${w.label} ${screenNum(cell.median_pct, 0, true)}` : `${w.label} —`);
        if (cell) {
          span.title = `${w.label}:中位数 RS ${screenNum(cell.median_pct, 2, true)}%,${cell.beats}/${cell.total} 只跑赢`;
          span.className = `rs-cell ${cell.median_pct >= 0 ? 'pos' : 'neg'}`;
          span.style.setProperty('--heat', String(Math.min(40, Math.abs(cell.median_pct) * 1.6).toFixed(0)));
        }
        rowNode.appendChild(span);
      }
      cardNode.appendChild(rowNode);
      cardNode.appendChild(el('div', 'rs-tag-syms', t.symbols.join(' · ')));
      grid.appendChild(cardNode);
    }
    tagsBox.appendChild(grid);
  } else {
    tagsBox.appendChild(el('p', 'hint', '成分股还没有业务标签,按标签汇总要先到「板块」页给股票加标签(AI 选股会自动给)。'));
  }

  clear(box);
  const wrap = el('div', 'screen-wrap');
  const table = el('table', 'screen-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['#', '标的', '标签', '现价']) hr.appendChild(el('th', h === '#' || h === '现价' ? null : 'text', h));
  for (const w of r.windows) {
    const th = el('th', null, `RS ${w.label}`);
    th.title = `${w.n} 个交易日`;
    hr.appendChild(th);
  }
  hr.appendChild(el('th', null, '综合'));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const row of r.rows) {
    const tr = el('tr', row.score == null ? 'dim' : null);
    tr.appendChild(el('td', 'rank', row.rank == null ? '' : String(row.rank)));
    const sym = el('td', 'sym text');
    sym.appendChild(symbolLink(row.symbol));
    tr.appendChild(sym);
    tr.appendChild(el('td', 'text', row.tag));
    tr.appendChild(el('td', null, row.error ? row.error : screenNum(row.last)));
    for (const w of r.windows) {
      const cell = row.rs[String(w.n)];
      const td = rsCell(cell ? cell.rs_pct : null);
      if (cell) td.title = `自身 ${screenNum(cell.ret_pct, 2, true)}% · 基准 ${screenNum(cell.bench_pct, 2, true)}%`;
      tr.appendChild(td);
    }
    tr.appendChild(rsCell(row.score));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  box.appendChild(wrap);
  box.appendChild(el('div', 'card-meta', 'RS = (1 + 成员收益) ÷ (1 + 基准收益) − 1,按各自日线算,基准按日期对齐;仅供研究,不构成投资建议'));
}

// ---- 拐点筛选 ------------------------------------------------------------
async function runInflection() {
  const st = screener.infl;
  if (st.busy) return;
  if (!st.timeframes.length) return showBanner('至少选一个 K 线周期', true);
  st.busy = true;
  const restore = busy($('btn-infl-run'));
  const ma = Number($('infl-ma').value) || 0;
  $('infl-status').textContent = st.timeframes.some((tf) => tf !== '1d' && tf !== '1w')
    ? '正在逐只拉 K 线…日内周期受券商节流,可能要一两分钟'
    : '正在拉日线并计算…';
  try {
    st.result = await window.dafri.screenerInflection({
      sector: $('infl-sector').value, timeframes: st.timeframes, ma_period: ma || null,
    });
    renderInflection();
  } catch (err) {
    $('infl-status').textContent = '—';
    showBanner(`拐点筛选失败:${err.message}`, false);
  } finally {
    st.busy = false;
    restore();
  }
}

function signalCell(sig) {
  const td = el('td');
  if (!sig) { td.appendChild(el('span', 'sig none', '—')); return td; }
  if (sig.error) {
    const span = el('span', 'sig err', '拿不到');
    span.title = sig.error;
    td.appendChild(span);
    return td;
  }
  if (!sig.signal) {
    const span = el('span', 'sig none', sig.bars < 40 ? '数据少' : '无');
    span.title = sig.reason || '';
    td.appendChild(span);
    return td;
  }
  const span = el('span', `sig ${sig.signal}`, sig.label);
  const bits = [`${sig.age} 根前`];
  if (sig.confirm) {
    const map = { confirmed: '已确认', waiting: '等确认', failed: '作废', 'n/a': '无均线' };
    bits.push(`MA${sig.confirm.ma} ${map[sig.confirm.status] || sig.confirm.status}`);
  }
  span.appendChild(el('span', 'sub', bits.join(' · ')));
  const [p1, p2] = sig.pivots;
  span.title = `${p1.time} ${p1.price}(DIF ${p1.dif}) → ${p2.time} ${p2.price}(DIF ${p2.dif})\n价差 ${screenNum(sig.price_gap_pct, 2, true)}%,DIF 差 ${screenNum(sig.dif_gap, 4, true)}`
    + (sig.confirm && sig.confirm.at ? `\n均线穿越:${sig.confirm.at}` : '');
  td.appendChild(span);
  td.appendChild(el('span', 'sig-detail', `${p2.time} · DIF ${screenNum(sig.dif_last, 3)}`));
  return td;
}

function renderInflection() {
  const r = screener.infl.result;
  const box = $('infl-table');
  if (!r) return empty(box, '选一个股票池和周期,点「扫描」。');
  const summary = r.timeframes.map((tf) => {
    const c = r.per_timeframe[tf];
    return `${SCREEN_TF_LABEL[tf] || tf} 底 ${c.bull} / 顶 ${c.bear}${r.ma_period ? ` / 确认 ${c.confirmed}` : ''}`;
  }).join(' · ');
  $('infl-status').textContent = `${r.sector} · ${r.hit_count}/${r.total} 只有背离 · ${summary} · ${fmtTimeShort(r.fetched_at)}`;
  clear(box);
  const wrap = el('div', 'screen-wrap');
  const table = el('table', 'screen-table');
  const thead = el('thead');
  const hr = el('tr');
  hr.appendChild(el('th', 'text', '标的'));
  hr.appendChild(el('th', 'text', '标签'));
  for (const tf of r.timeframes) hr.appendChild(el('th', 'text', SCREEN_TF_LABEL[tf] || tf));
  hr.appendChild(el('th', null, '命中'));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const row of r.rows) {
    const tr = el('tr', row.hits ? null : 'dim');
    const sym = el('td', 'sym text');
    sym.appendChild(symbolLink(row.symbol));
    tr.appendChild(sym);
    tr.appendChild(el('td', 'text', row.tag));
    for (const tf of r.timeframes) {
      const td = signalCell(row.signals[tf]);
      td.classList.add('text');
      tr.appendChild(td);
    }
    tr.appendChild(el('td', null, row.hits ? `${row.hits}${row.confirmed ? ` (✓${row.confirmed})` : ''}` : ''));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  box.appendChild(wrap);
  box.appendChild(el('div', 'card-meta', '左侧信号:背离 ≠ 反转,只是动能与价格不一致;右侧确认才是价格真的过了均线。仅供研究,不构成投资建议'));
}

// ---- 极值偏离 ------------------------------------------------------------
function fillDevSymbols() {
  const select = $('dev-symbol');
  const chosen = $('dev-sector').value || 'all';
  const sectors = chosen === 'all' ? screener.sectors : screener.sectors.filter((s) => s.id === chosen);
  const seen = new Set();
  const list = [];
  for (const sector of sectors) {
    for (const stock of sector.stocks) {
      if (stock.symbol && !seen.has(stock.symbol)) { seen.add(stock.symbol); list.push(stock); }
    }
  }
  screener.dev.list = list.map((s) => s.symbol);
  clear(select);
  for (const stock of list) {
    const option = el('option', null, stock.company ? `${stock.symbol} · ${stock.company}` : stock.symbol);
    option.value = stock.symbol;
    select.appendChild(option);
  }
  if (screener.dev.symbol && screener.dev.list.includes(screener.dev.symbol)) select.value = screener.dev.symbol;
  else if (screener.dev.list.length) screener.dev.symbol = select.value;
  syncDevPos();
}

function syncDevPos() {
  const list = screener.dev.list;
  const i = list.indexOf(screener.dev.symbol);
  $('dev-pos').textContent = list.length
    ? (i >= 0 ? `第 ${i + 1} / ${list.length} 只 · ‹ › 逐只翻看` : `${screener.dev.symbol || '—'}(手输,不在股票池里)`)
    : '股票池是空的:先到「板块」页加成分股,或在右边手输标的';
}

function devStep(delta) {
  const list = screener.dev.list;
  if (!list.length) return;
  let i = list.indexOf(screener.dev.symbol);
  i = i < 0 ? 0 : (i + delta + list.length) % list.length;
  screener.dev.symbol = list[i];
  $('dev-symbol').value = list[i];
  $('dev-symbol-free').value = '';
  runDeviation();
}

async function runDeviation() {
  const st = screener.dev;
  if (st.busy) return;
  const free = $('dev-symbol-free').value.trim().toUpperCase();
  const symbol = free || $('dev-symbol').value || st.symbol;
  if (!symbol) return showBanner('先选或手输一个标的', true);
  st.symbol = symbol;
  syncDevPos();
  st.busy = true;
  const restore = busy($('btn-dev-run'));
  $('dev-status').textContent = `正在拉 ${symbol} 的 K 线…`;
  try {
    st.result = await window.dafri.screenerDeviation({
      symbol, timeframe: $('dev-timeframe').value,
      period: Number($('dev-period').value) || 20, lookback: Number($('dev-lookback').value) || 120,
    });
    renderDeviation();
  } catch (err) {
    $('dev-status').textContent = '—';
    showBanner(`极值偏离失败:${err.message}`, false);
  } finally {
    st.busy = false;
    restore();
  }
}

function devStat(k, v, tone) {
  const node = el('div', `dev-stat${tone ? ` ${tone}` : ''}`);
  node.appendChild(el('div', 'k', k));
  node.appendChild(el('div', 'v', v));
  return node;
}

function renderDeviation() {
  const r = screener.dev.result;
  const box = $('dev-result');
  if (!r) return empty(box, '选一只股,点「复盘」。');
  clear(box);
  $('dev-status').textContent = `${r.symbol} · ${SCREEN_TF_LABEL[r.timeframe] || r.timeframe} · ${r.bars} 根 · ${fmtTimeShort(r.fetched_at)}`;
  const last = r.last;
  if (!last) {
    box.appendChild(card('warn', '数据不够', (r.readout || []).join(' ')));
    return;
  }
  const tone = r.extreme === 'overbought' ? 'hot' : r.extreme === 'oversold' ? 'cold' : '';
  const stats = el('div', 'dev-stats');
  stats.appendChild(devStat(`偏离 MA${r.period}`, `${screenNum(last.dev_pct, 2, true)}%`, tone));
  stats.appendChild(devStat(`z 分数(近 ${r.lookback} 根)`, last.z == null ? '—' : screenNum(last.z, 2, true), tone));
  stats.appendChild(devStat('历史分位', last.rank_pct == null ? '—' : `${screenNum(last.rank_pct, 0)}%`));
  stats.appendChild(devStat('修正版买卖压力', screenNum(last.pressure, 3, true), last.pressure > 0.3 ? 'cold' : last.pressure < -0.3 ? 'hot' : ''));
  stats.appendChild(devStat('收盘在真实区间', `${screenNum(last.buy_pct, 0)}%`));
  stats.appendChild(devStat('相对量', last.volume_ratio == null ? '—' : `${screenNum(last.volume_ratio, 2)}×`));
  box.appendChild(stats);

  const headline = card(r.extreme ? 'warn' : 'ok', r.extreme_label);
  const ul = el('ul', 'dev-readout');
  for (const line of r.readout || []) ul.appendChild(el('li', null, line));
  headline.appendChild(ul);
  box.appendChild(headline);

  const times = r.series.map((s) => s.time);
  const devNode = card('info', `偏离程度(收盘相对 MA${r.period},z 分数)`);
  mountChart(devNode, 'short', {
    ariaLabel: '偏离 z 分数',
    times,
    lines: [
      { values: r.series.map((s) => s.z), color: 'blue', width: 1.5, label: 'z' },
    ],
    hlines: [
      { price: 0, color: 'label', dash: [3, 3], alpha: 0.3, tag: false },
      { price: r.z_extreme, color: 'down', dash: [2, 3], alpha: 0.6, label: `+${r.z_extreme}σ 上方极值` },
      { price: -r.z_extreme, color: 'up', dash: [2, 3], alpha: 0.6, label: `−${r.z_extreme}σ 下方极值` },
    ],
    legend: [['—', 'blue', 'z 分数'], ['╌', 'down', '上方极值'], ['╌', 'up', '下方极值']],
    decimals: 2,
    volume: false,
  });
  box.appendChild(devNode);

  const prNode = card('info', '修正版买卖压力(−1 全卖压 … +1 全买压,量加权 + 平滑)');
  mountChart(prNode, 'short', {
    ariaLabel: '买卖压力',
    times,
    lines: [
      { values: r.series.map((s) => s.pressure), color: 'orange', width: 1.5, label: '压力' },
      { values: r.series.map((s) => (s.buy_pct == null ? null : s.buy_pct / 50 - 1)), color: 'label2', alpha: 0.4, label: '单根原始' },
    ],
    hlines: [{ price: 0, color: 'label', dash: [3, 3], alpha: 0.3, tag: false }],
    legend: [['—', 'orange', '修正版压力'], ['—', 'label2', '单根原始位置']],
    decimals: 2,
    volume: false,
  });
  box.appendChild(prNode);

  const w = r.window;
  if (w) {
    box.appendChild(el('div', 'card-meta',
      `本段偏离 最大 ${screenNum(w.dev_max.dev_pct, 2, true)}%(${w.dev_max.time}) · 最小 ${screenNum(w.dev_min.dev_pct, 2, true)}%(${w.dev_min.time}) · `
      + `压力 最高 ${screenNum(w.pressure_max.pressure, 2, true)}(${w.pressure_max.time}) · 最低 ${screenNum(w.pressure_min.pressure, 2, true)}(${w.pressure_min.time})`));
  }
}

function bindScreener() {
  $('btn-rs-run').addEventListener('click', runRs);
  $('btn-infl-run').addEventListener('click', runInflection);
  $('btn-dev-run').addEventListener('click', runDeviation);
  $('btn-dev-prev').addEventListener('click', () => devStep(-1));
  $('btn-dev-next').addEventListener('click', () => devStep(1));
  $('rs-benchmark').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    screener.rs.benchmark = btn.dataset.value;
    $('rs-benchmark').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
  });
  $('infl-timeframes').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    btn.classList.toggle('on');
    screener.infl.timeframes = [...$('infl-timeframes').querySelectorAll('button.on')].map((b) => b.dataset.value);
  });
  for (const id of ['rs-sector', 'infl-sector', 'dev-sector']) {
    $(id).addEventListener('change', () => {
      rememberScreenerSector($(id).value);
      if (id === 'dev-sector') fillDevSymbols();
    });
  }
  $('dev-symbol').addEventListener('change', () => {
    screener.dev.symbol = $('dev-symbol').value;
    $('dev-symbol-free').value = '';
    syncDevPos();
  });
  $('dev-symbol-free').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runDeviation();
  });
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
