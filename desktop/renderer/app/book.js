'use strict';
// 订单簿

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
