'use strict';
// 期权墙 · 价位警告

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
  ma20: '20日线', ma60: '60日线', ma120: '120日线', ma200: '200日线',
  low_52w: '52周低点', high_52w: '52周高点',
};
// 价位条上的短名:一行里要摆七八个,字要短;完整名进悬停提示
const ALERT_SOURCE_SHORT = {
  call_wall: 'C 墙', put_wall: 'P 墙', call_vol_wall: 'C 成交墙', put_vol_wall: 'P 成交墙',
  max_pain: '痛点', gamma_flip: 'γ 翻转', round: '关口',
  ma20: 'MA20', ma60: 'MA60', ma120: 'MA120', ma200: 'MA200',
  low_52w: '52周低', high_52w: '52周高',
};

/** 板块行里点「盯」:建一个提醒并立刻算墙,和「价位提醒」那一节里手填标的是同一条路。 */
async function watchSymbol(symbol, button) {
  if (button) button.disabled = true;
  const step = Number(($('alert-step') || {}).value) || 5;
  try {
    const { watch } = await window.dafri.createAlert(symbol, step);
    await loadAlerts();
    await refreshAlertWatch(watch.id);
  } catch (err) {
    showBanner(`盯 ${symbol} 失败:${err.message}`, false);
    if (button) button.disabled = false;
  }
}

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
  if (state.sectors.length) renderSectors();   // 成分股行下面的价位条来自同一份 watches
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

  node.appendChild(renderLadder(watch.levels, watch.last_price));
  return node;
}

/**
 * 价位梯子:把墙、关口、现价按价格摆到一根竖轴上,离现价多远一眼可见——一列数字要一个个读,
 * 位置不用读。挤在一起的行按和图表轴上标签同一套逻辑推开;行高 22px,整体高度随价位数走。
 */
function renderLadder(levels, spot) {
  const box = el('div', 'ladder');
  const rows = levels.map((l) => ({ price: l.price, level: l }));
  if (spot != null) rows.push({ price: spot, spot: true, pinned: true });
  const prices = rows.map((r) => r.price);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.005 || 1;
  lo -= pad;
  hi += pad;
  const ROW = 22;
  const H = Math.max(120, rows.length * ROW + 16);
  box.style.height = `${H}px`;
  for (const r of rows) r.y = 8 + (1 - (r.price - lo) / (hi - lo)) * (H - 16);
  const sorted = rows.slice().sort((a, b) => a.y - b.y);
  for (const r of sorted) r.ly = r.y;
  for (let pass = 0; pass < 8; pass += 1) {
    let moved = false;
    for (let i = 1; i < sorted.length; i += 1) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const overlap = a.ly + ROW - b.ly;
      if (overlap > 0) {
        moved = true;
        if (a.pinned) b.ly += overlap;
        else if (b.pinned) a.ly -= overlap;
        else { a.ly -= overlap / 2; b.ly += overlap / 2; }
      }
    }
    for (const r of sorted) if (!r.pinned) r.ly = Math.min(H - ROW / 2, Math.max(ROW / 2, r.ly));
    if (!moved) break;
  }
  box.appendChild(el('div', 'ladder-axis'));
  for (const r of sorted) {
    const kind = r.spot ? 'spot' : r.level.kind === 'resistance' ? 'resistance' : r.level.kind === 'support' ? 'support' : 'neutral';
    const row = el('div', `ladder-row ${kind}`);
    row.style.top = `${r.ly}px`;
    row.appendChild(el('span', 'ladder-src', r.spot ? '现价' : (ALERT_SOURCE_LABEL[r.level.source] || '价位')));
    row.appendChild(el('i', 'ladder-tick'));
    row.appendChild(el('span', 'ladder-price', String(r.price)));
    if (!r.spot) {
      const gap = spot ? ((r.price / spot - 1) * 100).toFixed(2) : null;
      row.appendChild(el('span', 'ladder-dist', gap != null ? `${gap > 0 ? '+' : ''}${gap}%` : ''));
      row.title = r.level.label || '';
    }
    box.appendChild(row);
  }
  return box;
}
