/**
 * 一只标的的档案(抽屉,全站共用,由 shell/DossierHost 挂):此刻的价、持仓与追踪、在途单、价位与异动、板块、想法、接下来的事件、
 * 各来源的信号条数,下面是它的时间线——消息、信号、事件、单子、想法串在一起。只读;「写指令」只往指令框里写一个开头。
 */
import { Button, Drawer, Space, Tag } from 'antd';
import type { IntelDossier } from '../bridge';
import { fmtMoney } from './format';
import { IntelTimeline } from './IntelTimeline';
import { relTime } from './intelRules';
import { legLabel, Pnl } from './TrackCard';
import { closeDossier, refreshDossier, useIntel } from '../store/intel';
import { navigate, navigateTo } from '../store/nav';
import { setInstruction, setTradePane } from '../store/trade';
import { Pill } from '../ui/graphics';
import { LoadingBlock, Notice, SectionTitle } from '../ui/kit';

const SIGNAL_LABEL: Record<string, string> = {
  cross: '价位穿越', touch: '碰均线', spike: '急涨急跌', day_move: '大涨大跌', rvol: '全天放量', burst: '窗口放量', leaders: '强势股', pa: 'K线 PA',
};
const QUOTE_SOURCE: Record<string, string> = { index: '指数', futures: '期货推算', index_stale: '上一个收盘', quote: '实时', daily_close: '日线收盘' };

function Facts({ d }: { d: IntelDossier }) {
  const now = d.at;
  return (
    <div className="dossier-facts">
      {d.positions.length ? (
        <>
          <SectionTitle count={d.positions.length}>持仓</SectionTitle>
          <ul className="dossier-list">
            {d.positions.map((p) => (
              <li key={p.key}>
                <span className="dossier-k">{p.label || legLabel(p.symbol, p.sec_type, p.contract)}</span>
                <span className="dossier-v">{p.quantity > 0 ? '多' : '空'} {Math.abs(p.quantity)} · 均价 {fmtMoney(p.sec_type === 'STK' ? p.avg_cost : p.avg_cost / (p.multiplier || 1))} · <Pnl value={p.unrealized_pnl} pct={p.unrealized_pct == null ? null : p.unrealized_pct.toFixed(2)} /></span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {d.tracks.length ? (
        <>
          <SectionTitle count={d.tracks.length}>追踪</SectionTitle>
          <ul className="dossier-list">
            {d.tracks.map((t) => (
              <li key={t.id}>
                <span className="dossier-k">{legLabel(t.symbol, t.sec_type, t.contract)} · {t.account}</span>
                <span className="dossier-v">{t.fired_state ? `已触发 ${t.fired_state}` : t.enabled ? (t.auto_close.enabled ? '盯着,到价自动平' : '盯着,只提醒') : '暂停'}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {d.working.length ? (
        <>
          <SectionTitle count={d.working.length}>在途单</SectionTitle>
          <ul className="dossier-list">
            {d.working.map((w) => (
              <li key={w.id}><span className="dossier-k">{w.summary || w.id}</span><span className="dossier-v">{w.status} · {w.account}</span></li>
            ))}
          </ul>
        </>
      ) : null}
      {d.events.length ? (
        <>
          <SectionTitle count={d.events.length}>接下来的事</SectionTitle>
          <ul className="dossier-list">
            {d.events.slice(0, 6).map((e) => (
              <li key={e.id} className={e.impact}><span className="dossier-k">{e.title}</span><span className="dossier-v">美东 {e.date_et.slice(5)} {e.time_et} · {relTime(e.at, now)}</span></li>
            ))}
          </ul>
        </>
      ) : null}
      {d.watch && d.watch.levels.length ? (
        <>
          <SectionTitle count={d.watch.levels.length}>价位</SectionTitle>
          <div className="dossier-levels">
            {[...d.watch.levels].sort((a, b) => b.price - a.price).slice(0, 10).map((l) => (
              <Tag key={`${l.source}@${l.price}`} bordered={false} className={`chip-tag level-${l.kind}`} title={l.label}>{l.label} {l.price}</Tag>
            ))}
          </div>
        </>
      ) : null}
      {d.quality && d.quality.events.length ? (
        <>
          <SectionTitle count={d.quality.events.length}>最近异动</SectionTitle>
          <ul className="dossier-list">
            {[...d.quality.events].reverse().slice(0, 5).map((e) => (
              <li key={e.id}><span className="dossier-k">{e.title}</span><span className="dossier-v">{relTime(e.at * 1000, now)}</span></li>
            ))}
          </ul>
        </>
      ) : null}
      {d.ideas.length ? (
        <>
          <SectionTitle count={d.ideas.length}>想法</SectionTitle>
          <ul className="dossier-list">
            {d.ideas.slice(0, 5).map((i) => <li key={i.id}><span className="dossier-k wrap">{i.text}</span></li>)}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function Head({ d }: { d: IntelDossier }) {
  const q = d.quote;
  const dir = q?.change_pct == null || q.change_pct === 0 ? '' : q.change_pct > 0 ? 'up' : 'down';
  return (
    <div className="dossier-head">
      <div className="dossier-price">
        <span className={`hero-num ${dir}`}>{q ? q.price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}</span>
        {q?.change_pct != null ? <span className={`dossier-chg ${dir}`}>{q.change_pct > 0 ? '+' : ''}{q.change_pct.toFixed(2)}%</span> : null}
        <span className="dossier-src">{q ? QUOTE_SOURCE[q.source] ?? q.source : d.connected ? '没有在订这只的行情' : '没连券商'}</span>
      </div>
      <div className="dossier-tags">
        {d.held ? <Pill tint="blue" dot>持仓中</Pill> : null}
        {d.sectors.map((s) => <Pill key={s} tint="gray">{s}</Pill>)}
        {d.watch?.enabled ? <Pill tint="teal">盯价位</Pill> : null}
        {d.quality?.enabled ? <Pill tint="orange">盯异动</Pill> : null}
        {d.mentions_7d ? <Pill tint="purple">7 天被提到 {d.mentions_7d} 次</Pill> : null}
        {d.signals.map((s) => <Pill key={s.source} tint="gray" title={`最近 90 天;最近一条 ${new Date(s.last_at).toLocaleString('zh-CN', { hour12: false })}`}>{SIGNAL_LABEL[s.source] ?? s.source} ×{s.n}</Pill>)}
      </div>
    </div>
  );
}

export function SymbolDossier() {
  const { dossier } = useIntel();
  if (!dossier) return null;
  const d = dossier.data;
  const symbol = dossier.symbol;
  const goMarket = () => {
    closeDossier();
    navigateTo('market', symbol);
  };
  const write = () => {
    setInstruction(`${symbol} `);
    setTradePane('result');
    closeDossier();
    navigate('trade');
  };
  return (
    <Drawer
      open
      width={560}
      onClose={closeDossier}
      destroyOnHidden
      title={<span className="dossier-title">{symbol}<span className="dossier-sub">档案</span></span>}
      extra={(
        <Space size={6}>
          <Button size="small" onClick={refreshDossier} loading={dossier.loading}>刷新</Button>
          <Button size="small" onClick={goMarket}>K 线</Button>
          <Button size="small" type="primary" onClick={write}>写指令</Button>
        </Space>
      )}
    >
      {dossier.error ? <Notice tone="warn" title="没读到档案">{dossier.error}</Notice> : null}
      {!d ? <LoadingBlock /> : (
        <div className="dossier">
          <Head d={d} />
          <Facts d={d} />
          <SectionTitle count={d.timeline.length}>时间线</SectionTitle>
          <IntelTimeline items={d.timeline} now={d.at} current={symbol} empty={`还没有关于 ${symbol} 的消息、信号或单子`} />
        </div>
      )}
    </Drawer>
  );
}
