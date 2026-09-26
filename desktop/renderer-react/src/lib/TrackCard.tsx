/** 已有追踪怎么显示:进度环、目标与现价的关系、那张卡片。
 *
 * 2026-09-20 从 pages/Tracker.tsx 搬出来(函数体逐字未改)。页面剩下的只是「取数 + 列出来」。
 * Pnl / legLabel 两个小助手页面那头也要用,所以从这里转出去(page → lib 是允许的方向)。
 */
import { useState } from 'react';
import { Alert, Button, Space } from 'antd';
import { dafri, errorMessage } from '../bridge';
import { fmtMoney, fmtNum } from './format';
import { TRACK_STATE_LABEL } from './labels';
import { showBanner } from '../store/banner';
import { loadRecords } from '../store/records';
import { gatewayName, useStatus } from '../store/status';
import { loadTracker, type LiveRow, type Track, type TrackTargets } from '../store/tracker';
import { Pill, PriceRail, Ring, type Tint } from '../ui/graphics';
import { Meta, StatusCard, type Tone } from '../ui/kit';
/** 盈亏的颜色和符号。0 不着色——把 0 画成绿色会让人以为赚了。 */
export function Pnl({ value, pct }: { value: number | null | undefined; pct?: number | string | null }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  const up = value > 0;
  const cls = value === 0 ? 'muted' : up ? 'pnl-up' : 'pnl-down';
  const sign = up ? '+' : '';
  return (
    <span className={cls}>
      {`${sign}${fmtMoney(value)}`}
      {pct !== null && pct !== undefined ? <span className="pnl-pct">{` ${sign}${pct}%`}</span> : null}
    </span>
  );
}

/** 期权腿显示成票面样子:SPX 7615P 2026-09-01;组合用引擎给的组合名。 */
export function legLabel(symbol: string, secType: string, contract?: Record<string, unknown>): string {
  const c = contract || {};
  if (secType === 'BAG') return c.label ? `${symbol} · ${c.label}` : `${symbol} 组合`;
  if (secType !== 'OPT' && secType !== 'FOP') return symbol;
  let expiry = String(c.lastTradeDateOrContractMonth || '').slice(0, 8);
  if (expiry.length === 8) expiry = `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6)}`;
  const strike = c.strike != null ? String(Number(c.strike)) : '';
  const right = String(c.right || '').slice(0, 1).toUpperCase();
  return [symbol, strike + right, expiry].filter((s) => s.trim()).join(' ');
}

// ---- 正在追踪的一条 ------------------------------------------------------------------------

const GAUGE_TINT: Record<'ok' | 'warn' | 'bad', Tint> = { ok: 'green', warn: 'orange', bad: 'red' };

/** 一条"离触发还有多远"的量表。没有现价就不画——画一条假的比不画更坏。 */
function Gauge({ live, targets }: { live: LiveRow; targets: TrackTargets }) {
  const price = live.price;
  if (price == null) {
    return (
      <div className="track-gauge">
        <span className="muted">拿不到现价,本轮不判断</span>
      </div>
    );
  }
  const rows: { label: string; target: number; note: string; tone: 'ok' | 'warn' | 'bad' }[] = [];
  const pending: string[] = [];
  const hasTrail = Boolean(targets.profit_drawdown_tiers) || targets.profit_drawdown_pct != null;
  if (live.profit_trail_stop != null) {
    const pct = live.profit_drawdown_threshold;
    rows.push({
      label: pct != null ? `利润回撤 ${fmtNum(pct)}%` : '利润回撤',
      target: live.profit_trail_stop,
      note: live.profit_peak != null ? `峰值利润 ${fmtMoney(live.profit_peak)}` : '',
      tone: 'warn',
    });
  } else if (hasTrail) {
    // 设了回撤、但峰值利润还没越过成本:回撤无从谈起,不是"没设"
    const peak = live.profit_peak;
    const arm = targets.profit_drawdown_arm;
    pending.push(
      peak != null && peak <= 0
        ? `利润回撤已设,但这笔从建仓起还没盈利过(峰值利润 ${fmtMoney(peak)})——先转正才会开始算回撤,在那之前只有止损能保护它。`
        : peak != null && arm != null
          // 蝶式预设的激活线:浮盈只有几毛时,组合中间价晃一下就是 40% 的回撤,先不追
          ? `利润回撤未激活:峰值利润 ${fmtMoney(peak)},现价到过成本的 ${fmtNum(1 + arm)} 倍才开始追回撤;在那之前只有止损能保护它。`
          : '利润回撤已设,等第一次盈利后开始记峰值。',
    );
  }
  const st = live.spot_target;
  if (st?.held) {
    pending.push(st.reason || '还没拿到市场报价,先不挂单。');
  } else if (st?.price != null) {
    // 目标价每轮重算,所以这一行的 target 也每轮变;标签里带上标的位置,
    // 否则界面上只剩一个孤零零的价格,看不出它是怎么来的
    rows.push({
      label: `标的到 ${fmtNum(st.spot_target)}`,
      target: st.price,
      note: st.pnl != null ? `预估收益 ${fmtMoney(st.pnl)}` : '',
      tone: 'ok',
    });
  } else if (targets.spot_target != null) {
    pending.push(st?.reason || `标的目标价 ${fmtNum(targets.spot_target)} 已设,但这一轮算不出对应的价位。`);
  }
  if (targets.take_profit != null && targets.spot_target == null) {
    rows.push({ label: '止盈', target: targets.take_profit, note: '', tone: 'ok' });
  }
  if (live.stop_effective != null) {
    rows.push({
      label: live.trail_stop != null && live.stop_effective === live.trail_stop ? '跟踪止损' : '止损',
      target: live.stop_effective,
      note: '',
      tone: 'bad',
    });
  }
  if (!rows.length && !pending.length) {
    return (
      <div className="track-gauge">
        <span className="muted">没设任何触发条件,只是挂着看</span>
      </div>
    );
  }
  return (
    <div className="track-gauge">
      {pending.map((text) => (
        <div className="muted" key={text}>
          {text}
        </div>
      ))}
      {rows.length ? (
        <div className="gauge-rings">
          {rows.map((r) => {
            const gap = r.target - price;
            const pct = price ? Math.abs(gap / price) * 100 : 0;
            // 距离越近环越满:20% 以外就算"还远",满环 = 已经贴着触发价
            const closeness = Math.max(0.02, Math.min(1, 1 - Math.min(pct, 20) / 20));
            return (
              <div className="gauge-ring" key={r.label}>
                <Ring value={closeness} tint={GAUGE_TINT[r.tone]} size={58} title="环越满 = 离触发越近">
                  {fmtNum(pct, 1)}
                  <small>%</small>
                </Ring>
                <div className="gauge-ring-text">
                  <span className="gauge-label">{r.label}</span>
                  <span className="gauge-value">{fmtMoney(r.target)}</span>
                  <span className="muted">{`还差 ${gap >= 0 ? '+' : ''}${fmtNum(gap, 4)}${r.note ? ` · ${r.note}` : ''}`}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function TrackCard({
  t,
  live,
  hosted,
  delayed,
  connected,
  flash,
}: {
  t: Track;
  live: LiveRow;
  hosted?: { orders: { kind: string; label: string }[] };
  delayed: boolean;
  connected: boolean;
  flash: boolean;
}) {
  const status = useStatus();
  const [busy, setBusy] = useState<'toggle' | 'close' | 'delete' | null>(null);
  const fired = Boolean(t.fired_at);
  const sweeping = String(t.fired_state || '').startsWith('sweep:');
  const kind: Tone = sweeping ? 'warn' : fired ? (t.fired_state === 'take_profit' ? 'ok' : 'bad') : t.enabled ? 'info' : 'warn';
  const targets = t.targets || {};
  const autoClose = t.auto_close || {};
  const ddTiers = targets.profit_drawdown_tiers || null;
  const frac = autoClose.close_fraction_pct;
  const now = live.profit_drawdown_threshold;

  async function toggle() {
    setBusy('toggle');
    try {
      await dafri.updateTracker({ id: t.id, enabled: !t.enabled });
      await loadTracker(false);
    } catch (err) {
      showBanner(errorMessage(err), false);
    } finally {
      setBusy(null);
    }
  }

  async function closeNow() {
    const ok = await dafri.confirm({
      title: '立即平仓',
      message: `马上把 ${t.symbol} 的持仓平掉?`,
      detail: '这会立刻发出一张平仓单,和到价自动平仓走的是同一条路。',
      confirmLabel: '平仓',
    });
    if (!ok) return;
    setBusy('close');
    try {
      const res = await dafri.closePositionNow(t.id);
      showBanner(`平仓单已发出:${res?.fired?.reason ?? ''}`, true);
      await Promise.all([loadTracker(true), loadRecords()]);
    } catch (err) {
      showBanner(errorMessage(err), false);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const ok = await dafri.confirm({
      title: '删除追踪',
      message: `不再追踪 ${t.symbol}?`,
      detail: '只删除追踪设置,不影响持仓本身。',
      confirmLabel: '删除',
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await dafri.deleteTracker(t.id);
      await loadTracker(false);
    } catch (err) {
      showBanner(errorMessage(err), false);
    } finally {
      setBusy(null);
    }
  }

  return (
    <StatusCard
      tone={kind}
      flash={flash}
      title={`${legLabel(t.symbol, t.sec_type, t.contract)} · ${t.account}`}
      extra={
        <Pill dot tint={sweeping ? 'orange' : fired ? (t.fired_state === 'take_profit' ? 'green' : 'red') : t.enabled ? 'blue' : 'gray'}>
          {fired ? TRACK_STATE_LABEL[t.fired_state || ''] || '已触发' : t.enabled ? TRACK_STATE_LABEL[live.state || ''] || '持有中' : '已暂停'}
        </Pill>
      }
    >
      <Meta
        items={[
          targets.take_profit ? `止盈 ${fmtMoney(targets.take_profit)}` : null,
          targets.stop_loss ? `止损 ${fmtMoney(targets.stop_loss)}` : null,
          // 分档时阈值每一轮都可能变,显示当前生效的那一档而不是配置里的静态值
          targets.profit_drawdown_pct || ddTiers
            ? (ddTiers ? `利润回撤 分档${now != null ? ` · 当前 ${now}%` : ''}` : `利润回撤 ${targets.profit_drawdown_pct}%`) + (frac && frac < 100 ? ` → 平 ${frac}%` : '')
            : null,
          ddTiers && live.profit_peak != null ? `峰值利润 ${fmtMoney(live.profit_peak)}` : null,
          targets.trail_pct ? `跟踪 ${targets.trail_pct}%${live.trail_stop ? ` → ${fmtMoney(live.trail_stop)}` : ''}` : null,
          t.peak ? `最有利价 ${fmtMoney(t.peak)}` : null,
          <span className={autoClose.enabled ? 'tag live' : 'tag paper'}>{autoClose.enabled ? '自动平仓已开' : '仅提醒'}</span>,
        ]}
      />

      {autoClose.host_at_broker ? (
        <Meta
          items={[
            <span className="tag live">券商托管</span>,
            ...(hosted?.orders?.length
              ? hosted.orders.map((o) => (o.kind === 'ptrail' ? `${o.label}(秒级调整)` : o.label))
              : [<span className="muted">{connected ? '托管单尚未挂出(对账中,或被闸门拦住——看下方提示)' : `连接${gatewayName(status)}后自动挂出`}</span>]),
            delayed ? <span className="muted">行情可能延迟:动态调整或滞后;触发由券商实时行情决定,不受影响</span> : null,
          ]}
        />
      ) : null}

      {live.unrealized_pnl !== undefined ? (
        <div className="pos-hero compact">
          <div className="pos-hero-main">
            <div className={`hero-num sm ${!live.unrealized_pnl ? '' : live.unrealized_pnl > 0 ? 'up' : 'down'}`}>
              <Pnl value={live.unrealized_pnl} pct={live.unrealized_pct} />
            </div>
            <div className="hero-sub">未实现盈亏</div>
          </div>
        </div>
      ) : null}
      {/* 价位轨:止损 / 现价 / 止盈落在同一根轴上——"现在站在哪、两头各还有多远"一眼看完 */}
      {!fired && live.price != null ? (
        <PriceRail
          marks={[
            { key: 'stop', price: live.stop_effective ?? targets.stop_loss, label: live.trail_stop != null && live.stop_effective === live.trail_stop ? '跟踪止损' : '止损', kind: 'stop' },
            { key: 'ptrail', price: live.profit_trail_stop, label: '回撤线', kind: 'other' },
            { key: 'now', price: live.price, label: '现价', kind: 'now' },
            { key: 'tp', price: live.spot_target?.held ? null : live.spot_target?.price ?? (targets.spot_target == null ? targets.take_profit : null), label: '止盈', kind: 'target' },
          ]}
        />
      ) : null}
      {/* 盯盘条:离触发还有多远。分档回撤的触发价每轮都会跳,所以取引擎算好的那个 */}
      {!fired && t.enabled ? <Gauge live={live} targets={targets} /> : null}
      {live.reason ? <div className="reason">{live.reason}</div> : null}
      {/* 追价平仓:追到哪了。轮 = 秒;挂的价只朝成交方向动,让到「最多让到」为止 */}
      {sweeping && live.chase ? (
        <div className="reason">
          {`追价第 ${live.chase.rounds} 秒:挂 ${fmtMoney(live.chase.limit)}`}
          {live.chase.natural != null ? `,此刻立刻成交价 ${fmtMoney(live.chase.natural)}` : ''}
          {live.chase.floor != null ? `,最多让到 ${fmtMoney(live.chase.floor)}` : ''}
        </div>
      ) : null}
      {live.blocked?.length ? <Alert type="warning" showIcon message="到价了但没有平仓" description={live.blocked.join('、')} style={{ marginTop: 8 }} /> : null}

      <Space size={6} className="card-actions" wrap>
        <Button size="small" loading={busy === 'toggle'} onClick={() => void toggle()}>
          {t.enabled ? '暂停' : '恢复'}
        </Button>
        <Button size="small" className="btn-warn" loading={busy === 'close'} onClick={() => void closeNow()}>
          立即平仓
        </Button>
        <Button size="small" type="text" loading={busy === 'delete'} onClick={() => void remove()}>
          删除
        </Button>
      </Space>
    </StatusCard>
  );
}
