'use strict';
// 订单看板

// ======================================================================
// 订单看板
// ======================================================================
async function loadPending() {
  try {
    const { pending } = await window.dafri.listPending();
    const box = $('pending-list');
    $('count-pending').textContent = String(pending.length);
    updateSidebarBadge(pending.length);
    if (!pending.length) return empty(box, '没有等待触发的条件单。');
    clear(box);
    for (const item of pending) {
      box.appendChild(
        card('info', item.intent_summary, null, [
          // 比较符是协议里的取值,摆给人看要用数学符号(和记录详情里的翻译口径一致)
          `${item.symbol} ${TRIGGER_OP_LABEL[item.operator] || item.operator} ${item.value}`,
          `账户 ${item.account}`,
          `入队 ${fmtTimeShort(item.created_at)}`,
        ])
      );
    }
  } catch (err) {
    empty($('pending-list'), `读取失败:${err.message}`);
  }
}

// 终态在库里是英文枚举(append-only 的既有词表,不动它),但直接摆给用户看
// 既不好读、又带着券商名:富途用户看到 ibkr_error 会以为软件连错了地方。
// 所以只在渲染这一层翻译。
const FINAL_STATUS_LABEL = {
  filled: '已成交',
  partially_filled: '部分成交',
  cancelled: '已撤单',
  expired_untriggered: '当日未触发',
  rejected_by_validator: '校验拒绝',
  rejected_by_llm: '模型拒绝',
  ibkr_error: '券商报错',
  halted_by_breaker: '熔断拦下',
};

// 在途状态来自券商,是英文枚举(Submitted / PreSubmitted / …)。终态翻了、
// 在途没翻的话,同一列里会中英夹杂——而这一列恰恰是最常扫的一列。
const LIVE_STATUS_LABEL = {
  PendingSubmit: '待发送',
  PreSubmitted: '已受理',
  Submitted: '已挂单',
  ApiPending: '发送中',
  PendingCancel: '撤单中',
  Filled: '已成交',
  Cancelled: '已撤单',
  ApiCancelled: '已撤单',
  Inactive: '券商报错',
  Unknown: '状态未知',
};

function statusLabel(record, fallback) {
  const final = record.final_status;
  if (final) return FINAL_STATUS_LABEL[final] || final;
  if (record.status) return LIVE_STATUS_LABEL[record.status] || record.status;
  return fallback;
}

function renderLive(records) {
  const box = $('live-list');
  const live = records.filter((r) => r.status && !r.rejection).slice(0, 8);
  $('count-live').textContent = String(live.length);
  if (!live.length) return empty(box, '今天还没有提交过订单。');
  clear(box);
  for (const record of live) {
    const kind = record.final_status === 'filled' ? 'ok' : record.final_status ? 'warn' : 'info';
    const meta = [
      `${ACTION_LABEL[record.action] || record.action || ''} ${record.quantity ?? ''} ${record.symbol}`,
      `账户 ${record.account}`,
      statusLabel(record, '—'),
    ];
    if (record.avg_fill_price) meta.push(`均价 ${fmtMoney(record.avg_fill_price)}`);
    box.appendChild(card(kind, record.intent_summary || record.raw_instruction, null, meta));
  }
}
