/**
 * 蝴蝶测算面板顶上的那一行:实时 SPX、上下最近的两个关口(25 的整数倍)、走到关口时提醒的开关。
 *
 * 现价与提醒的轮询在 store/spot(切走页面照常提醒);这里只显示,并告诉 store 面板看不看得见。
 * 点关口 = 把它填进「中心行权价」:蝶的中心就落在这些位置上。
 */
import { useEffect } from 'react';
import { Switch, Tag } from 'antd';
import { LEVEL_STEP, nearLevels } from './spotLevels';
import { patchFlyForm } from '../store/flyPlan';
import { setSpotAlert, setSpotVisible, SPOT_REFRESH_MS, SPOT_SYMBOL, useSpot } from '../store/spot';
import { gatewayName, useStatus } from '../store/status';
import { cx } from '../ui/kit';

function signed(points: number): string {
  return `${points > 0 ? '+' : points < 0 ? '−' : ''}${Math.abs(points).toFixed(1)}`;
}

export function FlySpotLine() {
  const { quote, failure, alertOn, lastHit } = useSpot();
  const status = useStatus();

  useEffect(() => {
    setSpotVisible(true);
    return () => setSpotVisible(false);
  }, []);

  const price = quote?.price ?? null;
  // 会动的价才算现价:昨收、断线前的最后一笔照样显示,但压暗并说明
  const live = quote !== null && price !== null && (quote.source === 'quote' || quote.source === 'futures');
  const levels = price !== null ? nearLevels(price) : null;
  const why = !status?.broker_connected
    ? `连上 ${gatewayName(status)} 之后显示`
    : failure ?? (quote && price === null ? quote.note : quote ? '' : '正在取现价…');

  return (
    <div className="fly-spot">
      <span className="fly-spot-quote" title={quote?.note || `和测算用的是同一个现价,每 ${SPOT_REFRESH_MS / 1000} 秒读一次`}>
        <span className="fly-spot-symbol">{SPOT_SYMBOL}</span>
        <span className={cx('fly-spot-price', live && 'live', !live && 'dim')}>{price !== null ? price.toFixed(2) : '—'}</span>
        {quote?.source === 'futures' ? <span className="fly-spot-note">期货推算</span> : null}
        {quote?.source === 'stale' ? <span className="fly-spot-note warn">不是现价</span> : null}
        {why ? <span className="muted">{why}</span> : null}
      </span>
      {levels && live && price !== null ? (
        <span className="fly-spot-levels">
          {([['下', levels.below], ['上', levels.above]] as const).map(([side, level]) => (
            <Tag key={side} bordered={false} className="chip-tag" title="点一下填进中心行权价" onClick={() => patchFlyForm({ center: String(level) })}>
              {`${side} ${level}`}
              <span className="fly-spot-gap">{signed(level - price)}</span>
            </Tag>
          ))}
        </span>
      ) : null}
      <span
        className="fly-auto fly-spot-alert"
        title={`${SPOT_SYMBOL} 走到 ${LEVEL_STEP} 的整数倍时弹窗并响一声,不在这一页也提醒;在关口上来回蹭只报一次。弹窗与提示音的开关在板块页的「提醒方式」`}
      >
        <Switch size="small" checked={alertOn} onChange={setSpotAlert} />
        <span className="muted">{`到 ${LEVEL_STEP} 的整数倍时提醒`}</span>
        {alertOn && lastHit ? (
          <span className="muted">
            {`· ${new Date(lastHit.at).toLocaleTimeString([], { hour12: false })} ${lastHit.direction === 'up' ? '上穿' : '下破'} ${lastHit.level}`}
          </span>
        ) : null}
      </span>
    </div>
  );
}
