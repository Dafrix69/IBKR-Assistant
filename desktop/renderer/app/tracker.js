'use strict';
// 持仓追踪

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
    return;
  }
  // 表单默认收起:十个字段摊在每张卡片里,两只持仓就是两屏表单。点「设置追踪」才展开,
  // 一次只展开一张(设置的对象就在眼前这张卡上,不用记)。展开的那张记在 tracker.openKey,刷新后不收回去。
  const row = el('div', 'row tight track-toggle');
  const toggle = el('button', 'btn tiny', '设置追踪');
  row.appendChild(toggle);
  node.appendChild(row);
  const holder = el('div', 'track-holder hidden');
  node.appendChild(holder);
  const openForm = () => {
    if (!holder.children.length) holder.appendChild(trackForm(p));
    holder.classList.remove('hidden');
    toggle.textContent = '收起';
    tracker.openKey = p.key;
  };
  toggle.addEventListener('click', () => {
    const opening = holder.classList.contains('hidden');
    document.querySelectorAll('#positions .track-holder').forEach((h) => {
      h.classList.add('hidden');
      const b = h.previousElementSibling && h.previousElementSibling.querySelector('button');
      if (b) b.textContent = '设置追踪';
    });
    if (opening) {
      openForm();
      const first = holder.querySelector('input');
      if (first) first.focus();
    } else {
      tracker.openKey = null;
    }
  });
  if (tracker.openKey === p.key) openForm();
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
    '到价即自动发平仓单,不再询问;仍受自动执行、实盘开关、熔断三道闸门约束'));
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
