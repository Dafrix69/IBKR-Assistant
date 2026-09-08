'use strict';
// 发单账户勾选(按账户扇出)

// ======================================================================
// 发单账户勾选:勾一个发一个,勾两个每笔各发一份(引擎按账户扇出)
// 只列当前生效券商下的账户——把富途账户勾进 IBKR 的发单里,发出去只会换来券商错误。
// 勾选状态存本地;没存过时默认只勾默认账户,行为与没有这个控件时一致。
// ======================================================================
const ACCOUNT_PICK_KEY = 'dafri-submit-accounts';

function pickableAccounts() {
  const status = state.status;
  if (!status || !Array.isArray(status.accounts)) return [];
  const provider = status.broker_provider || 'ibkr';
  return status.accounts.filter((a) => (a.broker || 'ibkr') === provider);
}

function loadPickedAccounts() {
  try {
    const raw = JSON.parse(localStorage.getItem(ACCOUNT_PICK_KEY) || 'null');
    if (Array.isArray(raw)) return raw.map(String);
  } catch (err) { /* 存坏了就当没存 */ }
  return null;
}

function selectedAccounts() {
  const usable = pickableAccounts();
  if (!usable.length) return [];
  const saved = loadPickedAccounts();
  const aliases = usable.map((a) => a.alias);
  if (saved === null) {
    const def = usable.find((a) => a.default) || usable[0];
    return [def.alias];
  }
  return saved.filter((alias) => aliases.includes(alias));
}

function renderAccountPicker() {
  const picker = $('account-picker');
  const chips = $('account-chips');
  if (!picker || !chips) return;
  const usable = pickableAccounts();
  // 「发送」按钮只在真的会发到实盘账户时才橙字——常态是普通次要按钮,常橙会被读成"一直在警告"
  const pickedNow = new Set(selectedAccounts());
  const liveOn = usable.length < 2
    ? usable.some((a) => !a.is_paper)
    : usable.some((a) => !a.is_paper && pickedNow.has(a.alias));
  const exec = document.getElementById('btn-execute');
  if (exec) exec.classList.toggle('warn', liveOn);
  // 只有一个账户时没什么可选,控件隐藏,行为与以前完全一样
  if (usable.length < 2) {
    picker.hidden = true;
    return;
  }
  const picked = new Set(selectedAccounts());
  clear(chips);
  for (const account of usable) {
    const label = el('label', 'account-chip' + (account.is_paper ? '' : ' live') + (picked.has(account.alias) ? ' checked' : ''));
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = picked.has(account.alias);
    input.addEventListener('change', () => {
      const next = new Set(selectedAccounts());
      if (input.checked) next.add(account.alias); else next.delete(account.alias);
      localStorage.setItem(ACCOUNT_PICK_KEY, JSON.stringify(usable.map((a) => a.alias).filter((x) => next.has(x))));
      renderAccountPicker();
    });
    label.appendChild(input);
    label.appendChild(el('span', null, `${account.alias} · ${account.is_paper ? '纸面' : '实盘'}`));
    label.title = `${account.account_masked} · 连接 ${account.connection}`;
    chips.appendChild(label);
  }
  const hint = $('account-picker-hint');
  const n = picked.size;
  hint.textContent = n > 1
    ? `每笔订单各发 ${n} 份,各自独立校验与记录`
    : n === 1 ? '' : '未勾选账户,无法发单';
  picker.hidden = false;
}

function card(kind, title, body, meta) {
  const node = el('div', `card ${kind}`);
  node.appendChild(el('div', 'card-title', title));
  if (body) node.appendChild(el('div', null, body));
  if (meta && meta.length) {
    const metaNode = el('div', 'card-meta');
    meta.forEach((item) => metaNode.appendChild(el('span', null, item)));
    node.appendChild(metaNode);
  }
  return node;
}

function renderResult(payload, target) {
  const box = target || $('result');
  clear(box);

  const groups = [
    ['ok', '已提交', payload.submitted],
    ['info', '排队等待触发', payload.queued],
    ['warn', '已通过校验(未发送)', payload.validated_only],
  ];

  for (const [kind, label, items] of groups) {
    for (const item of items || []) {
      const meta = [`账户 ${item.account || '—'}`];
      if (item.notional !== undefined) meta.push(`敞口 ≈ ${fmtMoney(item.notional)} USD`);
      if (item.order_id) meta.push(`订单号 ${item.order_id}`);
      if (item.mode) meta.push(item.mode === 'software_watch' ? '软件盯盘(AUTO_MID)' : item.mode);
      box.appendChild(card(kind, `${label} · ${item.intent_summary || ''}`, null, meta));
    }
  }

  for (const rejection of payload.rejections || []) {
    const source = { llm: '模型拒绝', validator: '校验拒绝', broker: '券商错误' }[rejection.source] || '拒绝';
    const node = card('bad', `${source} · ${rejection.code}`, rejection.message);
    if (rejection.original_text || rejection.intent_summary) {
      node.appendChild(el('div', 'reason', rejection.original_text || rejection.intent_summary));
    }
    box.appendChild(node);
  }

  if (payload.warnings && payload.warnings.length) {
    const node = card('warn', '提示', null);
    const list = el('ul');
    payload.warnings.forEach((w) => list.appendChild(el('li', null, w)));
    node.appendChild(list);
    box.appendChild(node);
  }

  if (payload.llm) {
    // 本地速记命中时不显示 token 用量——根本没调大模型,显示 0 tokens 反而让人疑惑
    const local = payload.llm.model === 'local-shorthand';
    const elapsed = payload.__elapsedMs != null ? `全链路 ${payload.__elapsedMs} ms` : null;
    const meta = local
      ? [`语法 ${payload.llm.model}`, '毫秒级本地解析,规则与 AI 同一套校验']
      : [
        `模型 ${payload.llm.model}`,
        `提示词 ${payload.llm.prompt_version}`,
        `模型 ${payload.llm.latency_ms} ms`,
        `in ${payload.llm.usage?.input_tokens ?? '—'} / out ${payload.llm.usage?.output_tokens ?? '—'} tokens`,
      ];
    if (elapsed) meta.push(elapsed);
    box.appendChild(
      card('info', local ? '本次解析 · 本地秒解(未经大模型)' : '本次解析', null, meta)
    );
  }

  if (!box.children.length) empty(box, '没有解析出任何订单。');
}
