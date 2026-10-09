import { useState } from 'react';
import { Badge, Button, Tooltip } from 'antd';
import { toggleBreaker, toggleBrokerConnection } from '../store/broker';
import { gatewayName, pickableAccounts, useEngineOk, useStatus } from '../store/status';
import { MOD_KEY, SHIFT_KEY } from '../store/appearance';
import { navigate } from '../store/nav';
import { useUpdateBadge } from '../store/update';
import { AppMark } from '../ui/AppMark';

type Dot = 'success' | 'warning' | 'error' | 'default';

/**
 * 统一工具栏:引擎圆点、四个状态、两个动作。顺序 = 重要性,会断的、管安全的排在视线起点。
 * 状态是 AntD Badge 的 8px 圆点 + 常规文字,颜色只落在圆点上——工具栏里没有彩色填充的胶囊。
 */
export function Topbar() {
  const status = useStatus();
  const engineOk = useEngineOk();
  const [busy, setBusy] = useState(false);
  const update = useUpdateBadge();

  const gateway = gatewayName(status);
  const connected = Boolean(status?.broker_connected);
  const upstreamDown = connected && status?.broker_upstream_ok === false;
  const engaged = Boolean(status?.breaker.engaged);
  // 保护规则的暂停:比熔断轻一档,到点自己解除(见 engine-ts/src/protections.ts)
  const guarded = Boolean(status?.protections?.paused);
  // 只停了某个账户的(日内亏损上限按账户当日盈亏算):别的账户照发,所以不占「保护暂停」那一格,只在悬停里说
  const accountPauses = status?.protections?.accounts ?? [];

  // 引擎不答话时,手上这份状态是它最后一次答话时的样子:不能再照着它写「已连接」
  const stale = engineOk === false;
  const brokerText = stale ? `${gateway} 状态未知` : upstreamDown ? `${gateway} 上游中断` : connected ? `${gateway} 已连接` : `${gateway} 未连接`;
  const brokerDot: Dot = stale ? 'error' : upstreamDown ? 'warning' : connected ? 'success' : 'default';
  const brokerTip = stale
    ? '交易引擎没有回应,券商连接的状态读不到。引擎恢复后这里会自己更新。'
    : upstreamDown
      ? `${gateway} 与券商服务器断连:本机连得上 ${gateway},但行情无回应。等待自动重连或检查网络。`
      : connected
        ? '引擎与券商网关的长连接正常'
        : '未连接券商:只能解析,不能下单,也拿不到行情';

  // 实盘闸门单独一格、常驻。它原来只藏在「自动执行(含实盘)」那几个字里,和「仅纸面」同一个颜色;
  // 自动执行关着、熔断着、保护暂停着的时候更是完全看不出来——而那几样一恢复,实盘单就发得出去了
  const liveAliases = pickableAccounts(status).filter((a) => !a.is_paper).map((a) => a.alias);
  const liveOpen = Boolean(status?.allow_live_trading) && liveAliases.length > 0;
  const liveText = !status ? '—' : liveOpen ? '实盘已放开' : '仅纸面';
  const liveTip = !status
    ? undefined
    : liveOpen
      ? `实盘闸门开着:发到实盘账户(${liveAliases.join('、')})的订单不会被它拦下,会用真钱成交。` +
        (status.auto_execute ? '' : '现在自动执行关着,什么单都发不出去;一打开就是这个状态。') +
        '在「设置」里关掉「允许实盘账户下单」当场生效。'
      : liveAliases.length
        ? `发到实盘账户(${liveAliases.join('、')})的订单会被拦下:「设置」里没有允许实盘账户下单。`
        : '这家券商下没有配置实盘账户。';

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
  if (!engaged && !guarded && accountPauses.length) {
    modeText = `${modeText} · ${accountPauses.map((a) => a.account).join('、')} 暂停`;
    modeTip = `${modeTip}。${accountPauses.map((a) => a.reason).join(';')}。平仓不受影响。`;
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
            <AppMark size={24} />
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
        <Tooltip title={liveTip} placement="bottom">
          <span className={`chip chip-live${liveOpen ? ' on' : ''}`} id="live-chip">
            <Badge status={liveOpen ? 'error' : 'default'} text={liveText} />
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
        {update ? (
          // 有更新的正式版才出现;点进「关于」看说明、下载或忽略这一版。不用彩色填充——它不比熔断重要
          <Tooltip title={`新版本 ${update.latest} 已发布,点开看更新内容`} placement="bottom">
            <Button shape="round" className="update-pill" onClick={() => navigate('about')}>
              新版本 {update.latest}
            </Button>
          </Tooltip>
        ) : null}
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
