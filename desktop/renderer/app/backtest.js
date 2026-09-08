'use strict';
// 策略回测(含条件搭建器与流程图)

// ======================================================================
// 策略回测(纯计算展示;历史数据来自 TWS)
// ======================================================================
const bt = {
  strategies: [],
  // 自定义策略的条件(默认给一组 RSI 超卖示例,进页面就能看懂结构)
  rules: {
    entry: [{ left: { kind: 'indicator', name: 'rsi', period: 14 }, op: '<', right: { kind: 'const', value: 30 } }],
    exit: [{ left: { kind: 'indicator', name: 'rsi', period: 14 }, op: '>', right: { kind: 'const', value: 70 } }],
  },
};

const BT_INDICATORS = [
  ['close', '收盘价'], ['open', '开盘价'], ['high', '最高价'], ['low', '最低价'],
  ['sma', 'SMA均线'], ['ema', 'EMA均线'], ['rsi', 'RSI'],
  ['highest', '前N日最高'], ['lowest', '前N日最低'], ['change_pct', 'N日涨跌幅%'],
  ['const', '常数'],
];
const BT_NEEDS_PERIOD = new Set(['sma', 'ema', 'rsi', 'highest', 'lowest', 'change_pct']);
const BT_OPS = [['>', '>'], ['<', '<'], ['>=', '≥'], ['<=', '≤'], ['cross_up', '上穿'], ['cross_down', '下穿']];
const BT_INST_LABELS = {
  stock: '正股', call: '买入看涨期权', put: '买入看跌期权',
  call_spread: '看涨借方价差', put_spread: '看跌借方价差', butterfly: '买入蝴蝶',
};

async function loadBacktestStrategies() {
  try {
    const { strategies } = await window.dafri.backtestStrategies();
    bt.strategies = strategies;
    if (!$('bt-end').value) {
      const today = new Date();
      $('bt-end').value = today.toISOString().slice(0, 10);
      $('bt-start').value = new Date(today.getTime() - 365 * 86400e3).toISOString().slice(0, 10);
    }
    const select = $('bt-strategy');
    clear(select);
    for (const s of strategies) {
      const opt = el('option', null, s.label);
      opt.value = s.key;
      select.appendChild(opt);
    }
    renderBacktestParams();
  } catch (err) {
    showBanner(`读取策略目录失败:${err.message}`, false);
  }
}

function currentStrategy() {
  return bt.strategies.find((s) => s.key === $('bt-strategy').value) || null;
}

function renderBacktestParams() {
  const box = $('bt-params');
  clear(box);
  const strategy = currentStrategy();
  if (!strategy) return;
  $('bt-strategy-desc').textContent = strategy.desc || '';

  if (strategy.key === 'custom') {
    renderRuleBuilder(box);
    renderStrategyFlow();
    return;
  }
  const labels = strategy.param_labels || {};
  for (const [key, value] of Object.entries(strategy.params)) {
    const row = el('div', 'field-row');
    // 认得出就用中文名,认不出退回原名——总比显示 "参数 buy_below" 强
    const label = el('label', null, labels[key] || key);
    if (labels[key]) label.appendChild(el('span', 'sub', key));
    row.appendChild(label);
    const input = el('input');
    input.type = 'number';
    input.value = String(value);
    input.dataset.paramKey = key;
    row.appendChild(input);
    box.appendChild(row);
  }
  renderStrategyFlow();
}

// ---- 自定义策略:图形化条件搭建器 + 文字生成 ----------------------------
function renderRuleBuilder(box) {
  // 文字输入:自然语言 → 条件(由外接大模型转换,结构再过软件层校验)
  const aiRow = el('div', 'row tight');
  const aiInput = el('input');
  aiInput.type = 'text';
  aiInput.className = 'grow';
  aiInput.id = 'bt-rule-text';
  aiInput.placeholder = '用文字描述,如:RSI跌破30且收盘价高于200日均线时买入,RSI回到70卖出';
  aiInput.maxLength = 1000;
  const aiBtn = el('button', 'btn tiny primary', 'AI 生成条件');
  aiBtn.addEventListener('click', () => generateRulesFromText(aiBtn));
  aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') generateRulesFromText(aiBtn);
  });
  aiRow.appendChild(aiInput);
  aiRow.appendChild(aiBtn);
  box.appendChild(aiRow);

  box.appendChild(ruleSection('入场条件(全部满足才买入)', bt.rules.entry, 'entry'));
  box.appendChild(ruleSection('出场条件(全部满足才卖出;留空 = 持有到区间结束)', bt.rules.exit, 'exit'));
}

function ruleSection(title, conditions, kind) {
  const wrap = el('div', 'group');
  wrap.appendChild(el('div', 'muted', title));
  conditions.forEach((cond, index) => {
    const row = el('div', 'row tight');
    row.appendChild(operandEditor(cond.left));

    const opSelect = el('select');
    for (const [value, label] of BT_OPS) {
      const opt = el('option', null, label);
      opt.value = value;
      opSelect.appendChild(opt);
    }
    opSelect.value = cond.op;
    opSelect.addEventListener('change', () => {
      cond.op = opSelect.value;
      renderStrategyFlow();
    });
    const opWrap = el('span', 'select-wrap');
    opWrap.appendChild(opSelect);
    row.appendChild(opWrap);

    row.appendChild(operandEditor(cond.right));

    const remove = el('button', 'btn tiny ghost', '✕');
    remove.addEventListener('click', () => {
      bt.rules[kind].splice(index, 1);
      renderBacktestParams();
    });
    row.appendChild(remove);
    wrap.appendChild(row);
  });

  const add = el('button', 'btn tiny', '+ 添加条件');
  add.addEventListener('click', () => {
    bt.rules[kind].push({
      left: { kind: 'indicator', name: 'close' },
      op: '>',
      right: { kind: 'indicator', name: 'sma', period: 50 },
    });
    renderBacktestParams();
  });
  wrap.appendChild(add);
  return wrap;
}

function operandEditor(operand) {
  const span = el('span', 'row tight');

  const select = el('select');
  for (const [value, label] of BT_INDICATORS) {
    const opt = el('option', null, label);
    opt.value = value;
    select.appendChild(opt);
  }
  select.value = operand.kind === 'const' ? 'const' : operand.name || 'close';
  const selWrap = el('span', 'select-wrap');
  selWrap.appendChild(select);
  span.appendChild(selWrap);

  const num = el('input');
  num.type = 'number';
  num.style.width = '76px';

  const sync = () => {
    const choice = select.value;
    if (choice === 'const') {
      operand.kind = 'const';
      delete operand.name;
      delete operand.period;
      num.placeholder = '数值';
      num.value = operand.value != null ? String(operand.value) : '';
      num.style.display = '';
    } else {
      operand.kind = 'indicator';
      operand.name = choice;
      delete operand.value;
      if (BT_NEEDS_PERIOD.has(choice)) {
        num.placeholder = '周期';
        if (!operand.period) operand.period = 20;
        num.value = String(operand.period);
        num.style.display = '';
      } else {
        delete operand.period;
        num.style.display = 'none';
      }
    }
  };
  select.addEventListener('change', () => {
    sync();
    renderStrategyFlow();
  });
  num.addEventListener('input', () => {
    const value = Number(num.value);
    if (operand.kind === 'const') operand.value = value;
    else operand.period = value;
    renderStrategyFlow();
  });
  sync();
  span.appendChild(num);
  return span;
}

// ---- 策略流程图(moomoo 风格卡片流,随表单实时生成)----------------------
function fmtRuleOperand(o) {
  return o.kind === 'const'
    ? String(o.value)
    : `${(BT_INDICATORS.find(([k]) => k === o.name) || [o.name, o.name])[1]}${o.period ? `(${o.period})` : ''}`;
}

function fmtRuleCond(c) {
  return `${fmtRuleOperand(c.left)} ${(BT_OPS.find(([k]) => k === c.op) || [c.op, c.op])[1]} ${fmtRuleOperand(c.right)}`;
}

function flowCard(kind, title, body) {
  const node = el('div', `flow-card ${kind}`);
  node.appendChild(el('div', 'flow-title', title));
  if (body) node.appendChild(el('div', 'flow-body', body));
  return node;
}

function flowArrow(label) {
  return el('span', 'flow-arrow', label ? `—${label}→` : '→');
}

function renderStrategyFlow() {
  const box = $('bt-flow');
  if (!box) return;
  clear(box);
  const strategy = currentStrategy();
  if (!strategy) return;

  const instType = $('bt-inst-type').value;
  const isOption = instType !== 'stock';
  let entryText, exitText;
  if (strategy.key === 'custom') {
    entryText = bt.rules.entry.map(fmtRuleCond).join(' 且 ') || '(未设置)';
    exitText = bt.rules.exit.length ? bt.rules.exit.map(fmtRuleCond).join(' 且 ') : null;
  } else {
    entryText = strategy.desc;
    exitText = strategy.key === 'buy_hold' ? null : '策略离场信号触发';
  }

  const buyBody = isOption
    ? `${BT_INST_LABELS[instType]} · DTE ${$('bt-inst-dte').value} · 偏移 ${$('bt-inst-offset').value}% · 投入 ${$('bt-inst-risk').value}% 净值`
    : '全仓买入正股(收盘价成交)';

  const row1 = el('div', 'flow-row');
  row1.appendChild(flowCard('start', '开始', '每根日线收盘评估'));
  row1.appendChild(flowArrow());
  row1.appendChild(flowCard('cond', '持仓是否为空?', '持有数量 = 0?'));
  row1.appendChild(flowArrow('是'));
  row1.appendChild(flowCard('cond', '入场条件是否满足?', entryText));
  row1.appendChild(flowArrow('是'));
  row1.appendChild(flowCard('action', '开仓', buyBody));
  box.appendChild(row1);

  const row2 = el('div', 'flow-row');
  row2.appendChild(el('span', 'flow-arrow', '　　　　└—否→'));
  if (exitText) {
    row2.appendChild(flowCard('cond', '出场条件是否满足?', exitText));
    row2.appendChild(flowArrow('是'));
    row2.appendChild(flowCard('action', '平仓', isOption ? '按模型价卖出;到期按内在价值结算' : '全仓卖出(收盘价成交)'));
  } else {
    row2.appendChild(flowCard('action', '继续持有', isOption ? '持有至到期,按内在价值结算' : '持有到区间结束'));
  }
  box.appendChild(row2);
}

async function generateRulesFromText(button) {
  const text = $('bt-rule-text').value.trim();
  if (!text) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '生成中…';
  try {
    const { rules } = await window.dafri.parseBacktestRules(text);
    bt.rules = rules;
    renderBacktestParams();
    $('bt-rule-text').value = text;   // 重渲染后回填描述,方便微调重试
  } catch (err) {
    showBanner(`条件生成失败:${err.message}`, false);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function runBacktest() {
  const symbol = $('bt-symbol').value.trim().toUpperCase();
  const start = $('bt-start').value;
  const end = $('bt-end').value;
  const strategy = $('bt-strategy').value;
  if (!symbol || !start || !end) {
    showBanner('请填写标的与起止日期', true);
    return;
  }
  const params = {};
  document.querySelectorAll('#bt-params input[data-param-key]').forEach((input) => {
    if (input.value !== '') params[input.dataset.paramKey] = Number(input.value);
  });
  const spec = { symbol, start, end, strategy, params };
  if (strategy === 'custom') spec.rules = bt.rules;
  const instType = $('bt-inst-type').value;
  spec.instrument = instType === 'stock'
    ? { type: 'stock' }
    : {
        type: instType,
        dte: Number($('bt-inst-dte').value) || 30,
        offset_pct: Number($('bt-inst-offset').value) || 0,
        width_pct: Number($('bt-inst-width').value) || 2,
        risk_pct: Number($('bt-inst-risk').value) || 10,
      };

  const box = $('bt-result');
  clear(box);
  box.appendChild(el('p', 'muted', '正在拉取历史数据并回测…'));
  $('btn-bt-run').disabled = true;
  try {
    const result = await window.dafri.runBacktest(spec);
    renderBacktestResult(result);
  } catch (err) {
    clear(box);
    box.appendChild(card('bad', '回测失败', err.message));
  } finally {
    $('btn-bt-run').disabled = false;
  }
}

function renderBacktestResult(r) {
  const box = $('bt-result');
  clear(box);

  const beat = r.total_return_pct - r.buy_hold_return_pct;
  const instLabel = r.instrument && r.instrument.type !== 'stock'
    ? ` · ${BT_INST_LABELS[r.instrument.type] || r.instrument.type}(DTE ${r.instrument.dte},投入 ${r.instrument.risk_pct}%)`
    : '';
  const head = card(
    beat >= 0 ? 'ok' : 'warn',
    `${r.symbol} · ${currentStrategy()?.label || r.strategy}${instLabel} · ${r.start} ~ ${r.end}(${r.bars} 根日线)`,
    null,
    [
      `策略收益 ${r.total_return_pct}%`,
      `买入持有 ${r.buy_hold_return_pct}%`,
      `超额 ${beat >= 0 ? '+' : ''}${beat.toFixed(2)}%`,
      `年化 ${r.annualized_pct}%`,
      `最大回撤 ${r.max_drawdown_pct}%`,
      `交易 ${r.trades} 次`,
      r.win_rate_pct != null ? `胜率 ${r.win_rate_pct}%` : '',
      `持仓时间占比 ${r.exposure_pct}%`,
    ].filter(Boolean)
  );
  box.appendChild(head);

  if (r.rules) {
    const rulesCard = card('info', '本次使用的条件');
    const fmtOperand = (o) =>
      o.kind === 'const'
        ? String(o.value)
        : `${(BT_INDICATORS.find(([k]) => k === o.name) || [o.name, o.name])[1]}${o.period ? `(${o.period})` : ''}`;
    const fmtCond = (c) =>
      `${fmtOperand(c.left)} ${(BT_OPS.find(([k]) => k === c.op) || [c.op, c.op])[1]} ${fmtOperand(c.right)}`;
    rulesCard.appendChild(el('div', null, `入场:${r.rules.entry.map(fmtCond).join(' 且 ')}`));
    rulesCard.appendChild(
      el('div', null, r.rules.exit.length ? `出场:${r.rules.exit.map(fmtCond).join(' 且 ')}` : '出场:持有到区间结束')
    );
    box.appendChild(rulesCard);
  }

  box.appendChild(renderEquityCurve(r.curve, r.trade_list));

  if (r.trade_list && r.trade_list.length && r.strategy !== 'buy_hold') {
    const tradesCard = card('info', `交易明细(${r.trade_list.length})`);
    const list = el('div', 'sector-stocks');
    for (const t of r.trade_list) {
      const row = el('div', 'stock-row');
      row.appendChild(el('span', 'stock-sub', `${t.entry_date} → ${t.exit_date || '持有中'}`));
      row.appendChild(el('span', 'stock-price', `${fmtMoney(t.entry_price)} → ${fmtMoney(t.exit_price)}`));
      const up = t.return_pct >= 0;
      row.appendChild(el('span', `status ${up ? 'filled' : 'rejected'}`, `${up ? '+' : ''}${t.return_pct}%`));
      list.appendChild(row);
    }
    tradesCard.appendChild(list);
    box.appendChild(tradesCard);
  }

  box.appendChild(
    card('warn', '注意', '收盘价成交、未计滑点与成本、单标的全仓。历史收益不代表未来;参数越漂亮越要怀疑过拟合。')
  );
}

/** 把一份 spec 交给图表引擎(pa-chart.js)画到卡片里。容器进了文档、有了尺寸,ResizeObserver 才会触发第一次绘制。 */
function mountChart(node, size, spec) {
  const wrap = el('div', `chart-wrap ${size}`);
  node.appendChild(wrap);
  if (window.DafriChart) window.DafriChart.mount(wrap, spec);
  else wrap.appendChild(el('p', 'empty', '图表模块未加载'));
  return wrap;
}

/** 净值曲线:策略与买入持有两条线,起点 1.0 的基线,交易明细的进出点标在策略线上。全部来自引擎的 curve / trade_list。 */
function renderEquityCurve(curve, tradeList) {
  const node = card('info', '净值曲线(起点 = 1.0)');
  if (!curve || curve.length < 2) return node;
  const times = curve.map((pt) => pt.date);
  const at = new Map(times.map((t, i) => [t, i]));
  const markers = [];
  for (const t of tradeList || []) {
    if (at.has(t.entry_date)) markers.push({ time: t.entry_date, price: curve[at.get(t.entry_date)].equity, shape: 'tri-up', color: 'up', fit: false });
    if (t.exit_date && at.has(t.exit_date)) markers.push({ time: t.exit_date, price: curve[at.get(t.exit_date)].equity, shape: 'tri-down', color: 'down', fit: false });
  }
  mountChart(node, 'short', {
    ariaLabel: '净值曲线',
    times,
    lines: [
      { values: curve.map((pt) => pt.bench), color: 'label2', alpha: 0.6, label: '买入持有' },
      { values: curve.map((pt) => pt.equity), color: 'blue', width: 1.5, label: '策略' },
    ],
    hlines: [{ price: 1, color: 'label', dash: [3, 3], alpha: 0.25, tag: false }],
    markers,
    legend: [['—', 'blue', '策略'], ['—', 'label2', '买入持有'], ['▲', 'up', '买入'], ['▼', 'down', '卖出'], ['╌', 'label2', '起点 1.0']],
    decimals: 3,
  });
  const first = curve[0];
  const last = curve[curve.length - 1];
  node.appendChild(el('div', 'card-meta', `${first.date} → ${last.date} · 期末净值 策略 ${last.equity} / 基准 ${last.bench}`));
  return node;
}
