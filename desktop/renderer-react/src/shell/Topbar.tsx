import { useState } from 'react';
import { Badge, Button, Tooltip } from 'antd';
import { toggleBreaker, toggleBrokerConnection } from '../store/broker';
import { gatewayName, useEngineOk, useStatus } from '../store/status';
import { MOD_KEY, SHIFT_KEY } from '../theme/appearance';

type Dot = 'success' | 'warning' | 'error' | 'default';

/**
 * 统一工具栏:引擎圆点、四个状态、两个动作。顺序 = 重要性,会断的、管安全的排在视线起点。
 * 状态是 AntD Badge 的 8px 圆点 + 常规文字,颜色只落在圆点上——工具栏里没有彩色填充的胶囊。
 */
export function Topbar() {
  const status = useStatus();
  const engineOk = useEngineOk();
  const [busy, setBusy] = useState(false);

  const gateway = gatewayName(status);
  const connected = Boolean(status?.broker_connected);
  const upstreamDown = connected && status?.broker_upstream_ok === false;
  const engaged = Boolean(status?.breaker.engaged);
  // 保护规则的暂停:比熔断轻一档,到点自己解除(见 engine-ts/src/protections.ts)
  const guarded = Boolean(status?.protections?.paused);

  const brokerText = upstreamDown ? `${gateway} 上游中断` : connected ? `${gateway} 已连接` : `${gateway} 未连接`;
  const brokerDot: Dot = upstreamDown ? 'warning' : connected ? 'success' : 'default';
  const brokerTip = upstreamDown
    ? `${gateway} 与券商服务器断连:本机连得上 ${gateway},但行情无回应。等待自动重连或检查网络。`
    : connected
      ? '引擎与券商网关的长连接正常'
      : '未连接券商:只能解析,不能下单,也拿不到行情';

  let modeText = '仅解析';
  let modeDot: Dot = 'default';
  let modeTip = '自动执行未打开:校验通过也不发单';
  if (engaged) {
    modeText = '已熔断';
    modeDot = 'error';
    modeTip = '熔断中:所有自动执行暂停,解除后恢复';
  } else if (guarded) {
    modeText = '保护暂停';
    modeDot = 'warning';
    modeTip = `${status?.protections?.reason || '保护规则已触发'}。平仓不受影响。`;
  } else if (status?.auto_execute) {
    modeText = status.allow_live_trading ? '自动执行(含实盘)' : '自动执行(仅纸面)';
    modeDot = 'warning';
    modeTip = status.allow_live_trading ? '解析通过的订单会直接发出,实盘账户也不拦' : '解析通过的订单会直接发出;指向实盘账户的会被拦下';
  }

  // 时间和市场时段合成一格,只留时分——秒在这里没有决策价值,却让这一格每秒都在跳
  const hhmm = String(status?.now_et || '').slice(11, 16);
  const marketText = status ? `${status.market_status} ${hhmm} 美东` : '—';
  const marketDot: Dot = status?.market_status === '盘中' ? 'success' : status ? 'warning' : 'default';
  const model = String(status?.model || '—').replace(/^claude-/, '');
  const engineDot: Dot = engineOk === null ? 'default' : engineOk ? 'success' : 'error';

  async function connect() {
    setBusy(true);
    try {
      await toggleBrokerConnection();
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="topbar">
      <Tooltip title={engineOk === null ? '引擎启动中' : engineOk ? '交易引擎运行中' : '交易引擎无响应'} placement="bottomLeft">
        <div className="brand">
          <span className="brand-mark">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 11 6 7.2l2.6 2.2 4.9-5.6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M10.4 3.6h3.2v3.2" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <i className={`engine-dot ${engineDot}`} />
          </span>
          <strong>IBKR-Assistant</strong>
        </div>
      </Tooltip>
      <div className="status-chips glass-capsule">
        <Tooltip title={brokerTip} placement="bottom">
          <span className="chip">
            <Badge status={brokerDot} text={brokerText} />
          </span>
        </Tooltip>
        <Tooltip title={modeTip} placement="bottom">
          <span className="chip">
            <Badge status={modeDot} text={modeText} />
          </span>
        </Tooltip>
        <Tooltip title={status ? `美东时间 ${status.now_et}` : undefined} placement="bottom">
          <span className="chip chip-clock">
            <Badge status={marketDot} text={marketText} />
          </span>
        </Tooltip>
        <Tooltip title={status?.model ? `解析用的模型:${status.model}` : undefined} placement="bottom">
          <span className="chip subtle chip-model">{model}</span>
        </Tooltip>
      </div>
      <div className="topbar-spacer" />
      <div className="topbar-actions">
        <Button shape="round" loading={busy} onClick={() => void connect()}>
          {connected ? `断开 ${gateway}` : `连接 ${gateway}`}
        </Button>
        <Tooltip title={`${MOD_KEY}${SHIFT_KEY}H`} placement="bottom">
          <Button shape="round" className={`halt${engaged ? ' engaged' : ''}`} danger={engaged} onClick={() => void toggleBreaker()}>
            {engaged ? '解除熔断' : '暂停自动执行'}
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}
