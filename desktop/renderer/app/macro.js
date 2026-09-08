'use strict';
// 顶栏宏观行情带

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
  // 一个数都没有(刚启动、公开源全部失败)时整条收起:一行 7 个「—」占着 27px,却没有任何信息
  strip.hidden = !rows.some((row) => row.last != null);
  for (const row of rows) {
    const item = el('div', 'macro-item');
    const live = row.source === 'tws';
    item.title = live
      ? row.instrument === 'PAXOS'
        ? 'TWS 实时流式,读的是 IBKR/PAXOS 的比特币现货,就是币价本身'
        : `TWS 实时流式,实际读的是 ${row.instrument}(ETF,涨跌幅贴近但绝对价位与指数不同)`
      : '公开数据源,分钟级;VIX 与美债10Y 永远走这条(它们没有不失真的 ETF 替身)';
    item.appendChild(el('span', 'macro-label', row.label));
    // 读的不是指数本身就必须标出来:GLD 几百美元、黄金期货几千美元,
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
