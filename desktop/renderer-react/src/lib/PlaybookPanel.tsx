/**
 * SPX 日内剧本:预期波动区间(三条取价的与拼出来的今日区间)、此刻的剧本状态、两条触发线离现价多远、期权墙上的加速档、今天报过的事件。
 *
 * 只看不下单。区间与状态是引擎里的循环算的(切走页面照常算、照常提醒),这里只显示;口径见 docs/features/playbook.md。
 */
import { useEffect } from 'react';
import { Switch, Tag } from 'antd';
import { bandRows, coverageText, etTime, eventTitle, fmtGap, fmtLevel, GEX_ASSUMPTION, GEX_ASSUMPTION_HINT, gexText, rearmText, STATE_HINT, STATE_LABEL } from './playbookFormat';
import type { PlaybookSnapshot } from '../bridge';
import { showBanner } from '../store/banner';
import { setPlaybookAlert, setPlaybookEnabled, setPlaybookVisible, usePlaybook } from '../store/playbook';
import { gatewayName, useStatus } from '../store/status';
import { cx, EmptyState, Primer } from '../ui/kit';

function Line({ label, level, price, hint }: { label: string; level: number | null; price: number | null; hint: string }) {
  return (
    <span className="pb-line" title={hint}>
      <span className="muted">{label}</span>
      <span className="pb-num">{fmtLevel(level)}</span>
      {level !== null && price !== null ? <span className="fly-spot-gap">{fmtGap(level, price)}</span> : null}
    </span>
  );
}

function Bands({ snap }: { snap: PlaybookSnapshot }) {
  return (
    <div className="pb-scroll">
    <table className="pb-table">
      <thead>
        <tr>
          <th>口径</th><th>取价</th><th>锚</th><th>跨式(涨 + 跌)</th><th>预期波动</th><th>区间</th>
        </tr>
      </thead>
      <tbody>
        {bandRows(snap).map(({ key, label, when, band, derived }) => (
          <tr key={key} className={cx(!band && 'dim')}>
            <td>{label}</td>
            <td className="muted">
              {band && !derived ? `${etTime(band.at)} · ${band.strike}` : when}
              {band?.source === 'backfill' ? <span className="fly-spot-note warn" title="软件当时没开着,这一条(或拼出它的那一条)是事后拿那一分钟的历史中间价补的"> 补</span> : null}
            </td>
            <td>{fmtLevel(band?.anchor)}</td>
            <td>{band && !derived ? `${band.call.toFixed(2)} + ${band.put.toFixed(2)}` : '—'}</td>
            <td>{band ? `±${band.em.toFixed(2)}` : '—'}</td>
            <td>{band ? `${fmtLevel(band.lower)} – ${fmtLevel(band.upper)}` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

function Wall({ snap }: { snap: PlaybookSnapshot }) {
  const { wall, accel } = snap;
  if (!wall) return null;
  return (
    <div className="pb-wall">
      <span title="现价上方未平仓量最大的看涨行权价">{`看涨墙 ${wall.call_wall ? wall.call_wall.strike : '—'}`}</span>
      <span title="现价下方未平仓量最大的看跌行权价">{`看跌墙 ${wall.put_wall ? wall.put_wall.strike : '—'}`}</span>
      <span title="净 gamma 变号的价位里离现价最近的那个:越过它,正负 gamma 换边。取到的行权价范围里不变号、或推算它的那条曲线在现价处的正负和净 gamma 对不上,就不给">{`Gamma 翻转 ${wall.gamma_flip === null ? '—' : fmtLevel(wall.gamma_flip)}`}</span>
      <span title={GEX_ASSUMPTION_HINT}>{`${gexText(wall)} · ${GEX_ASSUMPTION}`}</span>
      <span title="当前剩余区间(现价 ± 剩余预期波动)里负 gamma 最大的行权价:穿过它时走势容易加速">{`加速档 ${accel ? accel.strike : '—'}`}</span>
      <span className="muted" title="行情线路有限:要盖住剧本的每一条线,远处的行权价只取整数档">{`期权墙取于美东 ${etTime(wall.at)} · ${coverageText(wall.coverage, wall.oi_missing)}`}</span>
    </div>
  );
}

export function PlaybookPanel() {
  const { snap, failure, alertOn } = usePlaybook();
  const status = useStatus();

  useEffect(() => {
    setPlaybookVisible(true);
    return () => setPlaybookVisible(false);
  }, []);

  async function toggle(on: boolean) {
    const failed = await setPlaybookEnabled(on);
    if (failed) showBanner(`没改成:${failed}`, false);
  }

  if (!snap) return <EmptyState>{failure ?? '正在读日内剧本…'}</EmptyState>;

  const why = !status?.broker_connected ? `连上 ${gatewayName(status)} 之后开始` : snap.idle_reason;
  const active = snap.state === 'B2' || snap.state === 'B3';
  const events = [...snap.events].reverse();

  return (
    <div className="pb-panel">
      <div className="fly-spot">
        <span className="fly-spot-quote">
          <span className="fly-spot-symbol">{snap.symbol}</span>
          <span className={cx('fly-spot-price', snap.price !== null && !why ? 'live' : 'dim')}>{fmtLevel(snap.price)}</span>
          <Tag bordered={false} color={snap.state === 'B2' ? 'green' : snap.state === 'B3' ? 'red' : undefined} title={STATE_HINT[snap.state]}>
            {STATE_LABEL[snap.state]}
          </Tag>
          {active && snap.since !== null ? <span className="muted">{`美东 ${etTime(snap.since)} 起`}</span> : null}
          {why ? <span className="muted">{why}</span> : null}
        </span>
        <span className="fly-auto fly-spot-alert" title="进入 / 失效 B2、B3,或穿过加速档时弹窗并响一声,不在这一页也提醒。弹窗与提示音的开关在板块页的「提醒方式」">
          <Switch size="small" checked={alertOn} onChange={setPlaybookAlert} />
          <span className="muted">过线时提醒</span>
        </span>
      </div>

      <div className="pb-lines">
        {active ? (
          <>
            <Line label="触发线" level={snap.trigger} price={snap.price} hint={snap.state === 'B2' ? '进入时的那条线:取到新一格(每 5 分钟)时现价在它下方就失效;格子中间刺下去又回来不算' : '进入时的那条线:现价收回它上方就失效'} />
            <Line label="T1" level={snap.t1} price={snap.price} hint="盘初区间的边:B2 是上沿,B3 是下沿" />
            <Line label="T2" level={snap.t2} price={snap.price} hint="B2:T1 上方最近的正 gamma 行权价;B3:T1 下方的下一档行权价" />
          </>
        ) : (
          <>
            <Line label="B2 触发:站上" level={snap.lines.b2} price={snap.price} hint="今日区间的上沿:09:35 的锚 + 当前剩余的预期波动。锚整天不动,半宽每 5 分钟按最新的跨式重取;B2 也是每次取到新一格时判一次(那一刻现价在它之上才算),格子中间刺上去又回来不算" />
            <Line label="B3 触发:跌破" level={snap.lines.b3} price={snap.price} hint="昨日定价区间的下沿:每一笔现价都判" />
            {snap.b2_lost != null ? <span className="muted" title="今日区间随剩余时间收窄,B2 失效的那一格现价多半还在新的上沿之上">{rearmText(snap.b2_lost)}</span> : null}
          </>
        )}
      </div>

      <Bands snap={snap} />
      <Wall snap={snap} />

      {snap.notes.length || snap.last_error ? (
        <ul className="hint-list pb-notes">
          {snap.notes.map((note) => <li key={note}>{note}</li>)}
          {snap.last_error ? <li>{`上一轮出错:${snap.last_error}`}</li> : null}
        </ul>
      ) : null}

      <div className="pb-events">
        {events.length ? events.map((e) => (
          <div key={`${e.at}:${e.kind}:${e.level}`} className="pb-event">
            <span className="muted pb-num">{etTime(e.at)}</span>
            <span>{eventTitle(snap.symbol, e)}</span>
            <span className="muted pb-num">{fmtLevel(e.price)}</span>
          </div>
        )) : <span className="muted">今天还没有报过事件。</span>}
      </div>

      <Primer id="playbook" summary="区间怎么算、状态怎么判、哪些还没做">
        <ul className="hint-list">
          <li>预期波动 = 平值跨式(看涨 + 看跌的中间价)× √(π/2);区间 = 锚 ± 预期波动。</li>
          <li>昨日定价在上一个收盘后 10 分钟取,盘初定价在 09:35 取,当前剩余每 5 分钟重取。软件当时没开着的那一条,拿那一分钟的历史中间价补,标「补」。</li>
          <li>今日区间 = 09:35 的指数价 ± 当前剩余的预期波动:锚整天不动,半宽是期权市场此刻给剩下这段时间定的价,所以越到尾盘越窄。</li>
          <li>站上今日区间上沿 = B2(现价高出 09:35 那个价的幅度超过了剩余的预期波动),每 5 分钟取到新一格时判一次,格子中间刺上去、刺下来又回来的不算。跌破昨日区间下沿 = B3,每一笔现价都判,而且压过 B2。</li>
          <li>进去之后记住的是当时那条线,回到线的另一侧才失效。尾盘区间很窄,那时的 B2 只说明收盘多半在 09:35 那个价上方。</li>
          <li>止损位与概率分流还没有:没有能反推出算法的样本,不编数。</li>
          <li>只读行情、只提醒,不下单。</li>
        </ul>
        <span className="fly-auto">
          <Switch size="small" checked={snap.enabled} onChange={(on) => void toggle(on)} />
          <span className="muted">后台计算日内剧本(关掉之后不取期权行情,也不提醒)</span>
        </span>
      </Primer>
    </div>
  );
}
