/**
 * 异动监控的心跳一行。原来在 pages/Quality.tsx 里,那一页并进板块页(股票池)之后搬到这里——
 * 整段照搬,一个判断都没改:静默停摆比慢更危险,这一行是唯一能看出来的地方。
 */
import { useEffect, useState } from 'react';
import { Badge, Button } from 'antd';
import type { QualityMonitor } from '../bridge';
import { fmtWhen, toMs } from './anomalyFormat';
import { navigate } from '../store/nav';
import { Meta } from '../ui/kit';

/** 每 ms 跳一次,只为把"已经多少秒没跳了"这种随时间变的判断重新算一遍。 */
export function useNowTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** 引擎那条 5 秒循环的心跳:停了、慢了、报错了、不在时段里,都得在这一行看出来——静默停摆比慢更危险。 */
export function MonitorLine({
  monitor,
  error,
  loadedAt,
  connected,
  enabledCount,
  gateway,
  futu,
}: {
  monitor: QualityMonitor | null;
  error: string;
  loadedAt: number;
  connected: boolean;
  enabledCount: number;
  gateway: string;
  futu: boolean;
}) {
  // "多久没跳了"是随时间变的:引擎真的停了就不会再有任何回执来触发重画,这一行得自己走,
  // 否则它会永远停在最后那一眼的"监控中",而那正是最危险的情形
  const now = useNowTick(1000);
  // 列表都读不回来(引擎挂了、quality.list 一直报错):手上这份 monitor 已经不作数,先说读不到
  if (error) {
    const ago = loadedAt > 0 ? Math.round((now - loadedAt) / 1000) : null;
    return (
      <Meta
        className="quality-monitor"
        items={[
          <Badge status="error" text={`读不到异动监控:${error}`} />,
          <span className="warn-text">{ago != null ? `已经 ${ago} 秒没读到引擎的回执,期间报没报过异动都不知道` : '一次都没读到过'}</span>,
          loadedAt > 0 ? `上次读到 ${fmtWhen(loadedAt)}` : null,
        ]}
      />
    );
  }
  if (!monitor) return <div className="hint quality-monitor">异动监控:等第一轮结果…</div>;
  const lastMs = toMs(monitor.last_at);
  const interval = Math.max(1000, Number(monitor.interval_ms) || 5000);
  const age = lastMs != null ? now - lastMs : null;
  const stale = monitor.running && age != null && age > Math.max(interval * 4, 20_000);
  const seconds = Math.round(interval / 100) / 10;

  let dot: 'success' | 'warning' | 'error' | 'default' = 'default';
  let text: string;
  let extra: string | null = null;
  if (!connected) {
    text = monitor.note || '未连接券商';
    extra = `连接 ${gateway} 之后才开始检测`;
  } else if (!monitor.supported) {
    dot = 'warning';
    text = monitor.note || '当前券商暂不支持异动监控';
  } else if (!monitor.running) {
    dot = 'error';
    text = '异动监控没在跑:放量、急涨急跌都不会再报';
  } else if (monitor.last_error) {
    dot = 'error';
    text = `这一轮没做成:${monitor.last_error}`;
  } else if (stale) {
    dot = 'error';
    text = `异动监控已经 ${Math.round((age || 0) / 1000)} 秒没跳了`;
  } else if (!enabledCount) {
    text = '没有开着「异动」的股:把池子里哪只的「异动」拨开就开始检测';
  } else if (monitor.session === 'rth') {
    dot = 'success';
    text = `监控中 · 每 ${seconds} 秒一轮`;
    // 盘中的 note 只剩"延迟行情"这类提醒,要跟在后面说出来
    extra = monitor.note || null;
  } else {
    dot = 'warning';
    text = monitor.note || '非交易时段:开盘后开始检测';
  }
  return (
    <Meta
      className="quality-monitor"
      items={[
        <Badge status={dot} text={text} />,
        extra ? <span className={dot === 'success' ? 'warn-text' : undefined}>{extra}</span> : null,
        lastMs != null && connected ? `上次 ${fmtWhen(lastMs)}` : null,
        monitor.last_ms != null && connected && monitor.running ? `用时 ${monitor.last_ms} ms` : null,
        !connected ? (
          <Button size="small" type="link" className="inline-link" onClick={() => navigate(futu ? 'futu' : 'tws')}>
            去「接入」连接
          </Button>
        ) : null,
      ]}
    />
  );
}
