'use strict';
// 自定义板块 + AI 选股

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
        // 一只股 = 行 + 价位条,包成一个块:块内不画分隔线,块之间才画
        const block = el('div', 'stock-block');
        const row = el('div', 'stock-row');
        row.appendChild(el('span', 'stock-sym', stock.symbol));

        // 行内只放核心竞争点(简短);公司名进悬停提示,不占行宽
        const core = stock.reason !== '手动添加' ? stock.reason : '';
        const sub = el('span', 'stock-sub', core || stock.company || '');
        const tipParts = [stock.company, core].filter(Boolean);
        if (tipParts.length) sub.title = tipParts.join('\n');
        row.appendChild(sub);
        row.appendChild(tagChip(sector.id, stock));

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

        const watch = alerts.watches.find((w) => w.symbol === stock.symbol);
        if (!watch) {
          const eye = el('button', 'btn tiny ghost', '盯');
          eye.title = '算这只股的期权墙 / 均线 / 整数关口,并在穿越时提醒';
          eye.addEventListener('click', () => watchSymbol(stock.symbol, eye));
          row.appendChild(eye);
        }
        const remove = el('button', 'btn tiny ghost', '移除');
        remove.addEventListener('click', () => removeSectorStock(sector.id, stock.symbol));
        row.appendChild(remove);
        block.appendChild(row);
        if (watch && (watch.levels || []).length) {
          const strip = el('div', 'stock-levels');
          strip.appendChild(levelStrip(watch.levels, watch.last_price != null ? watch.last_price : (quote && quote.last)));
          block.appendChild(strip);
        } else if (watch) {
          block.appendChild(el('div', 'stock-levels muted', alerts.busy.has(watch.id) ? '正在算价位…' : '价位还没算出来:到下面「价位提醒」点「重算墙」。'));
        }
        stocksBox.appendChild(block);
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
    const tagInput = el('input');
    tagInput.type = 'text';
    tagInput.className = 'narrow';
    tagInput.placeholder = '业务标签';
    tagInput.title = '业务标签(如 芯片 / 数据中心),RS 强度按它汇总';
    tagInput.maxLength = 12;
    const addBtn = el('button', 'btn tiny', '添加');
    const doAdd = () => addSectorStock(sector.id, addInput, tagInput);
    addBtn.addEventListener('click', doAdd);
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doAdd();
    });
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doAdd();
    });
    addRow.appendChild(addInput);
    addRow.appendChild(tagInput);
    addRow.appendChild(addBtn);
    node.appendChild(addRow);

    box.appendChild(node);
  }
}


// ---- 板块与成分股的增删改 ---------------------------------------------------
// 引擎侧这些都是本地库操作,走"本地道"即来即答;界面用回执里的板块直接覆盖本地那一份,
// 不再多拉一次列表。移除先改本地再等回执:等回执的那几百毫秒里再点一次会得到"不在该板块中"。

/** 用 RPC 回来的板块覆盖本地那一份并重画;回执没带板块就退回拉列表。 */
function replaceSector(fresh) {
  if (!fresh || !fresh.id) return loadSectors(false);
  const i = state.sectors.findIndex((s) => s.id === fresh.id);
  if (i >= 0) state.sectors[i] = fresh;
  else state.sectors.push(fresh);
  renderSectors();
  return Promise.resolve();
}

async function removeSectorStock(sectorId, symbol) {
  const sector = state.sectors.find((s) => s.id === sectorId);
  const before = sector ? sector.stocks : null;
  if (sector) {
    sector.stocks = sector.stocks.filter((s) => s.symbol !== symbol);
    renderSectors();
  }
  try {
    const { sector: fresh } = await window.dafri.removeSectorStock(sectorId, symbol);
    await replaceSector(fresh);
  } catch (err) {
    if (sector && before) sector.stocks = before;
    showBanner(`移除股票失败:${err.message}`, false);
    await loadSectors(false); // 以引擎为准
  }
}

async function addSector() {
  const input = $('sector-input');
  const name = input.value.trim();
  if (!name) return;
  try {
    const { sector } = await window.dafri.addSector(name);
    input.value = '';
    await replaceSector(sector);
  } catch (err) {
    showBanner(`新建板块失败:${err.message}`, false);
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
    state.sectors = state.sectors.filter((s) => s.id !== id);
    renderSectors();
  } catch (err) {
    showBanner(`删除板块失败:${err.message}`, false);
    await loadSectors(false);
  }
}

async function addSectorStock(sectorId, input, tagInput) {
  const symbol = input.value.trim().toUpperCase();
  if (!symbol) return;
  try {
    const { sector } = await window.dafri.addSectorStock(sectorId, symbol, tagInput ? tagInput.value.trim() : '');
    input.value = '';
    if (tagInput) tagInput.value = '';
    await replaceSector(sector);
    refreshSectorQuotes(); // 新加那只的行情后台补
  } catch (err) {
    showBanner(`添加股票失败:${err.message}`, false);
  }
}

/** 成分股的业务标签胶囊:点一下变成输入框,回车 / 失焦提交,Esc 取消。空串 = 清掉。 */
function tagChip(sectorId, stock) {
  const tag = (stock.tag || '').trim();
  const chip = el('button', `stock-tag${tag ? '' : ' none'}`, tag || '＋标签');
  chip.type = 'button';
  chip.title = tag ? `业务标签:${tag}(点击修改)` : '加一个业务标签(如 芯片 / 数据中心),RS 强度按它汇总';
  chip.addEventListener('click', () => {
    const input = el('input', 'stock-tag-input');
    input.type = 'text';
    input.maxLength = 12;
    input.value = tag;
    input.placeholder = '业务标签';
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (!commit || next === tag) {
        input.replaceWith(chip);
        return;
      }
      try {
        const { sector } = await window.dafri.setSectorTag(sectorId, stock.symbol, next);
        await replaceSector(sector);
      } catch (err) {
        showBanner(`改标签失败:${err.message}`, false);
        input.replaceWith(chip);
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    chip.replaceWith(input);
    input.focus();
    input.select();
  });
  return chip;
}
