/**
 * 蝴蝶测算的盈亏曲线:横轴是标的点位,纵轴是这只蝶每份的净价。三条线——现在就到、目标时刻到、到期时停在那儿。
 *
 * 点位全部来自引擎给的 curve,这里不重算:图上画的和瓦片里写的必须是同一批数。
 * SVG 按 preserveAspectRatio=none 拉伸,字放进去会被压扁,所以标签用 HTML 叠在上面(和到期损益图同一个做法)。
 */
import type { FlyPlanResult } from '../bridge';

const W = 600;
const H = 190;
const PAD_T = 12;
const PAD_B = 24;

export function FlyPlanChart({ r }: { r: FlyPlanResult }) {
  const pts = r.curve;
  if (pts.length < 2) return null;
  const xMin = pts[0].spot;
  const xMax = pts[pts.length - 1].spot;
  const vMax = Math.max(r.width * 0.4, r.cost * 1.3, ...pts.map((p) => Math.max(p.now, p.target, p.expiry))) * 1.06;
  const X = (s: number) => ((s - xMin) / (xMax - xMin)) * W;
  const Y = (v: number) => PAD_T + (1 - v / vMax) * (H - PAD_T - PAD_B);
  const path = (key: 'now' | 'target' | 'expiry') => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.spot).toFixed(1)} ${Y(p[key]).toFixed(1)}`).join(' ');
  const costY = Y(r.cost);
  const target = path('target');
  const area = `${target} L${W} ${costY.toFixed(1)} L0 ${costY.toFixed(1)} Z`;
  const id = `fly-${r.lower}-${r.upper}-${Math.round(r.cost * 100)}`.replace(/[^\w-]/g, '_');
  const left = (s: number) => `${(((s - xMin) / (xMax - xMin)) * 100).toFixed(2)}%`;
  const inRange = (s: number) => s >= xMin && s <= xMax;
  const near = Math.abs(X(r.spot) - X(r.target.spot)) < 70;

  return (
    <div className="fly-chart">
      <div className="fly-chart-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="蝴蝶盈亏曲线">
          <defs>
            <clipPath id={`${id}-up`}>
              <rect x={0} y={0} width={W} height={costY} />
            </clipPath>
            <clipPath id={`${id}-dn`}>
              <rect x={0} y={costY} width={W} height={H - costY} />
            </clipPath>
          </defs>
          <path d={area} fill="var(--up)" opacity={0.16} clipPath={`url(#${id}-up)`} />
          <path d={area} fill="var(--down)" opacity={0.12} clipPath={`url(#${id}-dn)`} />
          <line x1={0} y1={costY} x2={W} y2={costY} stroke="var(--label-tertiary)" strokeWidth={1} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
          {[r.lower, r.center, r.upper].map((k) => (
            <line key={k} x1={X(k)} y1={PAD_T} x2={X(k)} y2={H - PAD_B + 5} stroke="var(--separator)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          <path d={path('expiry')} fill="none" stroke="var(--label-tertiary)" strokeWidth={1.3} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={path('now')} fill="none" stroke="var(--orange)" strokeWidth={1.5} strokeDasharray="5 4" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={target} fill="none" stroke="var(--blue)" strokeWidth={2.4} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {inRange(r.spot) ? <line x1={X(r.spot)} y1={4} x2={X(r.spot)} y2={H - PAD_B + 2} stroke="var(--label-secondary)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" /> : null}
          {inRange(r.target.spot) ? (
            <line x1={X(r.target.spot)} y1={4} x2={X(r.target.spot)} y2={H - PAD_B + 2} stroke="var(--blue)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
          ) : null}
        </svg>
        <div className="fly-chart-labels" aria-hidden="true">
          {[r.lower, r.center, r.upper].map((k) => (
            <span key={k} className="strike" style={{ left: left(k) }}>
              {k}
            </span>
          ))}
          {inRange(r.spot) ? (
            <span className="mark spot" style={{ left: left(r.spot), top: near ? 16 : -4 }}>
              现价 {r.spot.toFixed(1)}
            </span>
          ) : null}
          {inRange(r.target.spot) ? (
            <span className="mark target" style={{ left: left(r.target.spot) }}>
              目标 {r.target.spot}
            </span>
          ) : null}
          <span className="cost" style={{ top: `${((costY / H) * 100).toFixed(2)}%` }}>
            成本 {r.cost}
          </span>
        </div>
      </div>
      <div className="fly-chart-legend">
        <span>
          <i className="line target" />
          {`${r.target.at.slice(11)} 到`}
        </span>
        <span>
          <i className="line now" />
          现在就到
        </span>
        <span>
          <i className="line expiry" />
          到期时停在那儿
        </span>
        <span className="muted">纵轴:每份净价(点);虚线以上是赚</span>
      </div>
    </div>
  );
}
