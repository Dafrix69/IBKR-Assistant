/** 「K线 PA」结果里讲"判断怎么来的"那几块:三个子分并排、正在形成的那一根、按子分分组的判断依据。
 *
 * 全部照引擎给的字段摆(sub_scores / forming / evidence / agreement):界面不自己算分,
 * 也不替引擎判断哪一根收没收盘。
 */
import type { PaAnalyzeResult } from '../bridge';
import { Meta, Notice, StatTile, StatusCard } from '../ui/kit';

type Evidence = PaAnalyzeResult['evidence'][number];

const signed = (n: number): string => `${n > 0 ? '+' : ''}${n}`;
const side = (n: number): 'up' | 'down' | 'flat' => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const tone = (n: number): 'pos' | 'neg' | '' => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const AGREEMENT: Record<string, string> = { aligned: '与本周期同向', conflict: '与本周期相反', unclear: '谈不上顺逆' };
const BIAS_SIGN: Record<string, number> = { bullish: 1, lean_bull: 1, bearish: -1, lean_bear: -1 };

/** 三个子分 + 高周期,四格并排。各管各的:位置好抵不掉结构坏,所以不合成一个数给人看。 */
export function SubScores({ r }: { r: PaAnalyzeResult }) {
  const subs = r.sub_scores || [];
  if (!subs.length) return null;
  const htf = r.htf;
  return (
    <>
      <div className="stat-grid pa-subs">
        {subs.map((s) => (
          <StatTile key={s.key} mono label={s.mixed ? `${s.label} · 组内多空都有` : s.label} value={`${signed(s.score)} / ${s.max}`} tone={tone(s.score)} />
        ))}
        <StatTile
          mono
          label={htf ? `高周期 ${htf.timeframe_label} · ${AGREEMENT[r.agreement?.state] || '—'}` : '高周期'}
          value={htf ? htf.bias_label : '没有可对照的'}
          tone={tone(htf ? BIAS_SIGN[htf.bias] || 0 : 0)}
        />
      </div>
      <Meta items={['结构 = 摆动结构 + 最近一次突破 + 均线排列;位置 = 区间位置 + 贴近关键位;确认 = 扫单 + 形态 + 量能。三个数各自相加、互不抵消;总分是它们的和、再夹在 ±100 之内;高周期只并排看,不进总分。']} />
    </>
  );
}

/** 引擎说"钟点到了、数据未必到齐"的两种原因(延迟档晚 15–20 分钟是券商的口径) */
const WAITING: Record<string, string> = {
  delayed: '行情是延迟的(晚 15–20 分钟),它的数据可能还没到齐',
  unknown: '还说不准这个标的的行情是不是延迟的,先按延迟对待',
};

/** 最后一根还没走完(或钟点到了、数据还没到齐):明说它不进判定,并把"若此刻收盘会成立"的事列成未确认。 */
export function FormingNote({ r }: { r: PaAnalyzeResult }) {
  const f = r.forming;
  if (!f) return null;
  const at = f.closes_at ? f.closes_at.slice(11) || f.closes_at : '';
  const title = f.waiting
    ? `数据未到齐:${f.time} 那根按钟点 ${at} 已经走完,${WAITING[f.waiting] || ''};现价 ${f.close}`
    : `正在形成:${f.time} 那根(${at ? `${at} 收盘` : '还没收盘'}),现价 ${f.close}`;
  return (
    <Notice tone="warn" className="pa-forming" title={title}>
      {`下面的分数、结构事件、扫单与形态只算到 ${r.closed_bar} 那根收盘;这一根${f.waiting ? '数据到齐' : '走完'}之前不进判定。`}
      {(f.hints || []).map((h, i) => (
        <div key={i}>{`未确认 · ${h}`}</div>
      ))}
    </Notice>
  );
}

function EvidenceRow({ item }: { item: Evidence }) {
  return (
    <div className="pa-ev">
      <span className="pa-ev-label">{item.label}</span>
      <span className="pa-ev-detail">{item.detail}</span>
      <span className={`pa-ev-w ${side(item.weight)}`}>{signed(item.weight)}</span>
    </div>
  );
}

/** 判断依据:按子分分组,每组一个小计。 */
export function EvidenceCard({ r }: { r: PaAnalyzeResult }) {
  const evidence = r.evidence || [];
  const subs = r.sub_scores || [];
  return (
    <StatusCard title="判断依据(正 = 看涨)">
      {subs.length
        ? subs.map((s) => (
            <div className="pa-ev-group" key={s.key}>
              <div className="pa-ev-head">
                <span>{s.label}</span>
                {s.mixed ? <span className="muted">这一组里多空都有</span> : null}
                <span className={`pa-ev-w ${side(s.score)}`}>{`${signed(s.score)} / ${s.max}`}</span>
              </div>
              {evidence.filter((e) => e.group === s.key).map((item, i) => <EvidenceRow item={item} key={i} />)}
            </div>
          ))
        : evidence.map((item, i) => <EvidenceRow item={item} key={i} />)}
      <div className="reason">权重是手定的、固定在引擎里,没有按历史表现校过;不认同某条,可以从它那一组里减去再看。</div>
    </StatusCard>
  );
}
