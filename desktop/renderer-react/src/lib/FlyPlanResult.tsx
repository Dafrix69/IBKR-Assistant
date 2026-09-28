/**
 * 蝴蝶测算的结果:主结果瓦片、这一段走势急不急与 IV 怎么变、各档 IV 下的结果、盈亏曲线、早到晚到各值多少。
 *
 * 只摆引擎给的数,不在界面上再算一遍。到时的 IV 是按历史数据校准的模型估的,模型只解释得了 IV 变化的三成左右,
 * 所以主结果旁边摆着「半数情况下」的区间与「IV 不变」的那个数,下面是各档 IV 的表,再下面写明校准用的是什么数据。
 */
import { fmtNum } from './format';
import { COST_SOURCE_LABEL, IV_SOURCE_LABEL, PACE_LABEL, pct, signedPct, signedUsd } from './flyPlanForm';
import { FlyPlanChart } from './FlyPlanChart';
import type { FlyPlanResult, FlyPlanValue } from '../bridge';
import { Meta, SectionTitle, StatTile, StatusCard, cx } from '../ui/kit';

const tone = (v: number): 'pos' | 'neg' | '' => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

function localTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function Pnl({ v }: { v: FlyPlanValue }) {
  return <span className={cx('fly-pnl', tone(v.pnl))}>{`${signedUsd(v.pnl)} · ${signedPct(v.pnl_pct, 0)}`}</span>;
}

export function FlyPlanResultView({ r, stale }: { r: FlyPlanResult; stale: boolean }) {
  const side = r.right === 'C' ? '看涨' : '看跌';
  const ivMoved = Math.abs(r.iv.change_pct) >= 0.05;
  // 到时的 IV 为什么变:自动档拆成时段与走势两份,让人看得出哪一份在起作用
  const ivWhy = r.iv.mode === 'auto'
    ? [Math.abs(r.iv.seasonal_pct) >= 0.05 ? `时段 ${signedPct(r.iv.seasonal_pct, 0)}` : '', Math.abs(r.iv.move_pct) >= 0.05 ? `走势 ${signedPct(r.iv.move_pct, 0)}` : ''].filter(Boolean).join('、')
    : '你填的';
  const range = r.target_range;
  const model = r.iv.model;
  const m = r.move;
  const arrow = m.direction === 'up' ? '涨' : m.direction === 'down' ? '跌' : '不动';
  const be = r.breakeven;
  const beText = be.low === null && be.high === null
    ? (r.peak.value > r.cost ? '图的范围内都在成本之上' : '这个时刻怎么走都不赚')
    : `${be.low ?? '…'} – ${be.high ?? '…'}`;

  return (
    <div className={cx('fly-result', stale && 'stale')}>
      <StatusCard
        tone={r.target.pnl > 0 ? 'ok' : r.target.pnl < 0 ? 'bad' : 'info'}
        title={`${r.symbol} ${r.lower}/${r.center}/${r.upper} ${side}蝶 × ${r.quantity} · 美东 ${r.target.at.slice(11)} 到 ${r.target.spot}`}
      >
        <div className="stat-grid">
          <StatTile label="预计盈利" value={`${signedUsd(r.target.pnl)} · ${signedPct(r.target.pnl_pct, 0)}`} tone={tone(r.target.pnl)} />
          <StatTile label={`到时蝶价(成本 ${fmtNum(r.cost)})`} value={fmtNum(r.target.value)} />
          {range ? <StatTile label={<span title="到时的 IV 估不准:按历史上估错的幅度,有一半的情况盈亏落在这个区间里">半数情况下</span>} value={`${signedUsd(range.low.pnl)} ~ ${signedUsd(range.high.pnl)}`} /> : null}
          {ivMoved ? <StatTile label="要是 IV 不变" value={signedUsd(r.target_flat.pnl)} tone={tone(r.target_flat.pnl)} /> : null}
          <StatTile label="到期时停在目标" value={signedUsd(r.at_expiry.pnl)} tone={tone(r.at_expiry.pnl)} />
          <StatTile label="最多赚 / 最多亏" value={`${signedUsd(r.max_profit)} / ${signedUsd(-r.max_loss)}`} />
        </div>
        <Meta
          items={[
            `现价 ${fmtNum(r.spot)}${r.spot_source === 'futures' ? '(期货推算)' : r.spot_source === 'input' ? '(手动)' : ''} → ${r.target.spot}:${m.direction === 'flat' ? '不动' : `${arrow} ${fmtNum(Math.abs(m.points))} 点`},${duration(m.minutes)}`,
            m.direction !== 'flat' ? `走了全天波动(一个标准差 ≈ ${fmtNum(m.day_sigma, 1)} 点)的 ${fmtNum(Math.abs(m.day_sigmas))} 倍` : null,
            m.sigmas !== null ? `按这段时间算是 ${fmtNum(m.sigmas)} 个标准差(${PACE_LABEL[m.pace]})` : null,
            `本地时间 ${localTime(r.target.epoch_ms)} · 到时离到期 ${fmtNum(r.target.hours_left, 1)} 小时`,
          ]}
        />
        <Meta
          items={[
            `IV:${IV_SOURCE_LABEL[r.iv.source]} · 现在 ${pct(r.iv.now)} → 到时 ${pct(r.iv.at_target)}${ivMoved ? `(${signedPct(r.iv.change_pct, 0)}${ivWhy ? `:${ivWhy}` : ''})` : '(不变)'}`,
            r.iv.range ? `半数情况下 ${pct(r.iv.range.low)} ~ ${pct(r.iv.range.high)}` : null,
            `成本:${COST_SOURCE_LABEL[r.cost_source]}`,
            r.market.mid !== null ? `盘口 买 ${fmtNum(r.market.bid)} / 中 ${fmtNum(r.market.mid)} / 卖 ${fmtNum(r.market.ask)}${r.anchored ? ' · 已锚定' : ''}` : '没有盘口',
          ]}
        />
        {r.spot_note ? <div className="hint">{r.spot_note}</div> : null}
      </StatusCard>

      {r.warnings.length ? (
        <StatusCard tone="warn" title="要留意的">
          <ul className="hint-list">
            {r.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </StatusCard>
      ) : null}

      <StatusCard title="盈亏曲线">
        <FlyPlanChart r={r} />
        <Meta
          items={[
            `${r.target.at.slice(11)} 的盈亏平衡:${beText}`,
            `到期的盈亏平衡:${r.expiry_breakeven.low} – ${r.expiry_breakeven.high}`,
            `${r.target.at.slice(11)} 最赚的位置:${r.peak.spot}(${signedUsd(r.peak.pnl)})`,
          ]}
        />
      </StatusCard>

      <StatusCard title="IV 变了会怎样">
        <p className="hint">同一个目标点位与时刻,到时的 IV 不同,这只蝶值的也不同。标出来的那一行是上面用的。</p>
        <table className="fly-table">
          <thead>
            <tr>
              <th>IV 变化</th>
              <th>到时 IV</th>
              <th>蝶价</th>
              <th>盈亏</th>
            </tr>
          </thead>
          <tbody>
            {r.scenarios.map((s) => (
              <tr key={s.iv_change_pct} className={s.current ? 'on' : undefined}>
                <td>{Math.abs(s.iv_change_pct) < 0.05 ? '不变' : signedPct(s.iv_change_pct, 0)}</td>
                <td>{pct(s.iv)}</td>
                <td>{fmtNum(s.value)}</td>
                <td>
                  <Pnl v={s} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </StatusCard>

      {r.timeline.length > 1 ? (
        <StatusCard title={`早到晚到:标的在不同时刻走到 ${r.target.spot}`}>
          <table className="fly-table">
            <thead>
              <tr>
                <th>到达(美东)</th>
                <th>那时的 IV</th>
                <th>蝶价</th>
                <th>盈亏</th>
              </tr>
            </thead>
            <tbody>
              {r.timeline.map((t) => (
                <tr key={t.epoch_ms} className={t.is_target ? 'on' : undefined}>
                  <td>{t.at}</td>
                  {/* 到期那一刻只剩内在价值,谈不上 IV */}
                  <td>{t.epoch_ms >= r.expiry_ms ? '—' : pct(t.iv)}</td>
                  <td>{fmtNum(t.value)}</td>
                  <td>
                    <Pnl v={t} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </StatusCard>
      ) : null}

      <SectionTitle>三条腿</SectionTitle>
      <table className="fly-table legs">
        <thead>
          <tr>
            <th>腿</th>
            <th>买价 / 卖价</th>
            <th>IV</th>
          </tr>
        </thead>
        <tbody>
          {r.legs.map((l) => (
            <tr key={l.strike}>
              <td>{`${l.action === 'BUY' ? '买' : '卖'} ${l.ratio} × ${l.strike}${l.right}`}</td>
              <td>{l.ask !== null ? `${l.bid === null ? '—' : fmtNum(l.bid)} / ${fmtNum(l.ask)}` : '—'}</td>
              <td>{pct(l.iv)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Meta items={[`算于美东 ${r.now_at} · ${r.expiry_at} 到期(${r.trading_class || r.symbol})`, '不计佣金', '只算不下单']} />
      {model ? (
        <p className="hint">
          {`到时的 IV 是按历史数据估的:${model.period} 共 ${model.days} 个交易日,看标的走了一段之后${model.own ? '同一个行权价的 IV' : ` ${model.proxy} `}怎么变。`}
          {`拿没参与拟合的那段数据检验,它解释得了 IV 变化的 ${Math.round(model.r2_out * 100)}%——其余是估不出来的,所以给的是区间。`}
          {model.own ? '用的是软件自己攒下来的当日到期期权 IV。' : `${model.proxy} 是恒定 1 天期的指数,不是这三条腿自己的 IV。`}
          {`校准于 ${model.version}。`}
        </p>
      ) : null}
    </div>
  );
}
