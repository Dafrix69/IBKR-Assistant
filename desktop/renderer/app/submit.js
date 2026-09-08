'use strict';
// 指令提交

// ======================================================================
// 指令提交
// ======================================================================
async function submit(execute) {
  const text = $('instruction').value.trim();
  if (!text) return;
  if (state.busy) return;
  const accounts = selectedAccounts();
  if (!accounts.length) {
    showBanner('请至少勾选一个发单账户', false);
    return;
  }

  if (execute) {
    const fanout = accounts.length > 1 ? `同时发到 ${accounts.length} 个账户,每笔订单各一份:` : '目标账户:';
    const ok = await window.dafri.confirm({
      title: '发送真实订单',
      message: `这条指令解析后会直接发送到${brokerShortName()},没有二次确认环节。${fanout}${accounts.join('、')}。`,
      detail: text,
      confirmLabel: '我确认,发送',
    });
    if (!ok) return;
  }

  state.busy = true;
  const restore = busy(execute ? $('btn-execute') : $('btn-parse'));
  $('btn-parse').disabled = true;
  $('btn-execute').disabled = true;
  const result = $('result');
  working(result, execute ? '正在解析并发送…' : '正在解析…(最长约 1 分钟)');

  const t0 = performance.now();
  try {
    const payload = await window.dafri.submit(text, execute, accounts);
    payload.__elapsedMs = Math.round(performance.now() - t0);
    renderResult(payload);
    await Promise.all([refreshStatus(), loadRecords(), loadPending()]);
  } catch (err) {
    clear(result);
    result.appendChild(card('bad', '调用失败', err.message));
  } finally {
    restore();
    state.busy = false;
    $('btn-parse').disabled = false;
    $('btn-execute').disabled = !(state.status && state.status.auto_execute && state.connected && !state.breakerEngaged);
  }
}
