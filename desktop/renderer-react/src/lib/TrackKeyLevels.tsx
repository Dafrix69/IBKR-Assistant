/**
 * 持仓追踪里的「关键价位」:追踪卡片上的一块(期权墙 / 均线 / 整数关口 + 自己设的线摆在一根轴上,止损贴着哪堵墙),
 * 以及新建追踪表单里的一排(点一个价位就填进止损或目标)。
 *
 * 价位就是「板块」页盯价位的那一份(引擎的 alert_watches,store/alerts):建追踪时引擎给标的建一条盯单(origin = tracker),
 * 穿越照常弹窗——同一套状态机、同一扇窗。这里只摆;怎么说在 trackLevels.ts(纯函数),口径见 docs/features/tracker.md「关键价位」。
 */
import { Button, Tooltip } from 'antd';
import type { WatchLevel } from '../bridge';
import { LevelStrip } from './LevelStrip';
import { GEX_ASSUMPTION_HINT, gexText } from './playbookFormat';
import { fmtGap, fmtLevel, levelName, levelSummary, lineContext, ownLines, pickSides, type LiveBits, type PickMode } from './trackLevels';
import { ALERT_SOURCE_SHORT, createWatch, refreshWatch, useAlerts, type Watch } from '../store/alerts';
import type { Position, Track } from '../store/tracker';
import { Meta } from '../ui/kit';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** 这只标的的盯单;没有是 undefined */
function useWatchOf(symbol: string): { watch: Watch | undefined; computing: boolean } {
  const { watches, busy } = useAlerts();
  const watch = watches.find((w) => w.symbol === symbol.toUpperCase());
  return { watch, computing: Boolean(watch && busy.includes(watch.id)) };
}

/** 还没有盯单 / 还没算出价位时的那一行:说清楚为什么空着,给一个按钮 */
function Pending({ symbol, watch, computing }: { symbol: string; watch: Watch | undefined; computing: boolean }) {
  if (!watch) {
    return (
      <div className="track-levels muted">
        <span>{`${symbol} 还没在盯价位(期权墙、均线、整数关口)。`}</span>
        <Button size="small" type="text" className="inline-link" onClick={() => void createWatch(symbol, 0, 'tracker')}>
          算关键价位
        </Button>
      </div>
    );
  }
  return (
    <div className="track-levels muted">
      <Tooltip title="引擎在异动那条 5 秒循环里捎带算价位,每轮最多一只(期权链请求很贵),连着券商、在开盘前后的时段内才做">
        <span>{computing ? '正在算关键价位…' : `${symbol} 的关键价位还没算出来`}</span>
      </Tooltip>
      <Button size="small" type="text" className="inline-link" loading={computing} onClick={() => void refreshWatch(watch.id)}>
        立刻算
      </Button>
    </div>
  );
}

/** 追踪卡片上的那一块。spot = 标的现价(正股是自己的现价,期权与组合是标的的) */
export function TrackLevelsPanel({ t, live }: { t: Track; live: LiveBits }) {
  const { watch, computing } = useWatchOf(t.symbol);
  const levels: WatchLevel[] = watch?.levels || [];
  if (!watch || !levels.length) return <Pending symbol={t.symbol} watch={watch} computing={computing} />;
  const spot = t.sec_type === 'STK'
    ? num(live.price) ?? num(watch.last_price)
    : num(live.spot_stop?.spot) ?? num(live.spot_target?.spot) ?? num(watch.last_price);
  const own = ownLines(t.sec_type, t.targets || {}, live);
  const notes = spot === null ? [] : own.map((line) => lineContext(line, levels, spot, ALERT_SOURCE_SHORT)).filter((s): s is string => Boolean(s));
  const wall = watch.wall;
  return (
    <div className="track-levels">
      <div className="track-levels-head">
        <span className="strong">关键价位</span>
        {spot !== null ? <span className="muted">{levelSummary(levels, spot, ALERT_SOURCE_SHORT)}</span> : null}
      </div>
      <LevelStrip levels={[...levels, ...own]} spot={spot} />
      {notes.map((n) => (
        <div className="hint" key={n}>{n}</div>
      ))}
      <Meta
        className="pool-wall"
        items={[
          wall ? <Tooltip title={GEX_ASSUMPTION_HINT}><span>{gexText(wall)}</span></Tooltip> : null,
          wall?.max_pain ? `最大痛点 ${wall.max_pain.strike}` : null,
          watch.expiry ? `墙按 ${watch.expiry} 到期` : null,
          (wall?.days_to_expiry ?? 99) <= 1 ? '当天到期:以成交墙为准' : null,
          <span className="muted">穿越时弹窗(和板块页的价位提醒同一套)</span>,
          <Button size="small" type="text" className="inline-link" loading={computing} onClick={() => void refreshWatch(watch.id)}>
            {computing ? '计算中…' : '重算墙'}
          </Button>,
        ]}
      />
    </div>
  );
}

/** 新建追踪表单里的那一排:点一个价位填进止损或目标。正股只给方向对的那一侧 */
export function TrackLevelPicker({
  p, long, derivative, onStop, onTarget,
}: {
  p: Position;
  long: boolean;
  derivative: boolean;
  onStop: (price: number, side: 'below' | 'above') => void;
  onTarget: (price: number) => void;
}) {
  const { watch, computing } = useWatchOf(p.symbol);
  const levels: WatchLevel[] = watch?.levels || [];
  if (!watch || !levels.length) return <Pending symbol={p.symbol} watch={watch} computing={computing} />;
  const spot = derivative ? num(watch.last_price) : num(p.market_price) ?? num(watch.last_price);
  if (spot === null) return null;
  const chips = (mode: PickMode) => {
    const { below, above } = pickSides(levels, spot, mode, long, derivative);
    const one = (l: WatchLevel, side: 'below' | 'above') => (
      <Tooltip key={`${mode}${side}${l.price}`} title={`${l.label} · 距现价 ${fmtGap((l.price / spot - 1) * 100)}`}>
        <Button size="small" className="level-chip" onClick={() => (mode === 'stop' ? onStop(l.price, side) : onTarget(l.price))}>
          {`${levelName(l, ALERT_SOURCE_SHORT)} ${fmtLevel(l.price)}`}
        </Button>
      </Tooltip>
    );
    return [...below.slice(0, 3).map((l) => one(l, 'below')), ...above.slice(0, 3).map((l) => one(l, 'above'))];
  };
  const stopLabel = derivative ? `点一下填进标的止损(${p.symbol} 跌到 / 涨到)` : '点一下填进止损价';
  const targetLabel = derivative ? `点一下填进标的目标价` : '点一下填进止盈价';
  return (
    <div className="track-levels">
      <div className="track-levels-head">
        <span className="strong">{`${p.symbol} 的关键价位`}</span>
        <span className="muted">{levelSummary(levels, spot, ALERT_SOURCE_SHORT)}</span>
      </div>
      <LevelStrip levels={levels} spot={spot} />
      <div className="level-picks">
        <span className="muted">{stopLabel}</span>
        {chips('stop')}
      </div>
      <div className="level-picks">
        <span className="muted">{targetLabel}</span>
        {chips('target')}
      </div>
      <div className="hint">
        建好之后,卡片上会写出每条线和最近那个价位的位置关系。止损在支撑之上(空头:在阻力之下)时,价格还没碰到那个价位就会先止损。
      </div>
    </div>
  );
}
