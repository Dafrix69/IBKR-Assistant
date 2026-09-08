'use strict';
// 顶栏与状态

// ======================================================================
// 顶栏与状态
// ======================================================================
const statusPoll = { inFlight: false };

async function refreshStatus() {
  // 引擎 sidecar 串行处理:上一轮没回来就再发,只会在管道里排队。
  // 曾经因为这个攒出 159 个待处理的 system.status,引擎恢复后还要逐个吐完。
  if (statusPoll.inFlight) return;
  statusPoll.inFlight = true;
  try {
    const status = await window.dafri.status();
    state.status = status;
    state.connected = status.broker_connected;
    state.breakerEngaged = status.breaker.engaged;
    renderStatus(status);
    setEngineDot(true);
  } catch (err) {
    setEngineDot(false);
    showBanner(`引擎无响应:${err.message}`, false);
  } finally {
    statusPoll.inFlight = false;
  }
}

// 网关名与面板名跟着生效的券商走。写死"TWS"的文案在富途通道上是错的指引:
// 用户照着去点一个跟他无关的面板,点完还是连不上。
// 快捷键要显示这个平台上真实存在的键。macOS 是 ⌘,Windows / Linux 是 Ctrl——
// 在 Windows 上画一个 ⌘ 等于告诉用户去按一个键盘上没有的键。
const MOD_KEY = navigator.platform.toUpperCase().includes('MAC') ? '⌘' : 'Ctrl+';
const ENTER_KEY = MOD_KEY === '⌘' ? '↩' : 'Enter';

/** 当前券商在界面上的短名。按钮上写"发送到 IBKR"而实际发去富途,是会出事的。 */
function brokerShortName() {
  return state.status && state.status.broker_provider === 'futu' ? '富途' : 'IBKR';
}

/** 顶栏、按钮、提示里那些跟平台或券商绑定的文案,统一在这里刷新。 */
function syncPlatformLabels() {
  const parseKey = document.getElementById('hint-parse-key');
  if (parseKey) {
    parseKey.textContent = `${MOD_KEY}${ENTER_KEY} 解析 · ${MOD_KEY}${
      MOD_KEY === '⌘' ? '⇧' : 'Shift+'}${ENTER_KEY} 发送`;
  }
  const halt = document.getElementById('btn-halt');
  if (halt) halt.title = `${MOD_KEY}${MOD_KEY === '⌘' ? '⇧H' : 'Shift+H'}`;
  const execute = document.getElementById('btn-execute');
  if (execute) execute.textContent = `发送到${brokerShortName()}`;
  const gateway = document.getElementById('hint-gateway');
  if (gateway) gateway.textContent = `已连接 ${gatewayName()}`;
}
