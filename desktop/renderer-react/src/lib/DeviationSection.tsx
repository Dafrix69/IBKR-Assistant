/** 扫描页「单只:极值偏离」那一段:取数的 hook 与它的那一块界面。
 *
 * 2026-09-21 从 pages/Screener.tsx 搬出来(函数体逐字未改)。
 */
import { useMemo, useRef, useState } from 'react';
import { Button, Input, InputNumber, Select, Tooltip } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { dafri, errorMessage } from '../bridge';
import type { DeviationResult } from '../bridge';
import { CanvasChart, type ChartSpec } from './Chart';
import { fmtTimeShort } from './format';
import { num, TF_LABEL, TF_OPTIONS, type PoolStock } from './screenerRows';
import { showBanner } from '../store/banner';
import { EmptyState, Meta, SectionTitle, StatTile, StatusCard } from '../ui/kit';

export function useDeviation() {
  const [symbol, setSymbol] = useState('');
  const [free, setFree] = useState('');
  const [timeframe, setTimeframe] = useState('1d');
  const [period, setPeriod] = useState<number | null>(20);
  const [lookback, setLookback] = useState<number | null>(120);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeviationResult | null>(null);
  const [status, setStatus] = useState('');
  // 连着点几行时只认最后一次:前面的回包到了也不落地
  const seq = useRef(0);
  // 扫描要跑几十秒,它收尾时调进来的 review 是几十秒前那次渲染的;参数从这里读才是现在的
  const latest = useRef({ free, timeframe, period, lookback });
  latest.current = { free, timeframe, period, lookback };

  async function review(target: string) {
    const chosen = target.trim().toUpperCase();
    if (!chosen) {
      showBanner('先选或手输一个标的', true);
      return;
    }
    const now = latest.current;
    const mine = ++seq.current;
    if (chosen !== now.free.trim().toUpperCase()) setFree('');
    setSymbol(chosen);
    setBusy(true);
    setStatus(`正在拉 ${chosen} 的 K 线…`);
    try {
      const r = await dafri.screenerDeviation({ symbol: chosen, timeframe: now.timeframe, period: now.period || 20, lookback: now.lookback || 120 });
      if (mine !== seq.current) return;
      setResult(r);
      setStatus(`${TF_LABEL[r.timeframe] || r.timeframe} · ${r.bars} 根 · ${fmtTimeShort(r.fetched_at)}`);
    } catch (err) {
      if (mine !== seq.current) return;
      // 上一只的数字不能留在新选的这只名下
      setResult(null);
      setStatus('');
      showBanner(`极值偏离失败:${errorMessage(err)}`, false);
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }

  /** 扫描出结果后顺手复盘榜首那只;人已经自己点过就不抢 */
  function reviewIfUntouched(target: string) {
    if (seq.current === 0) void review(target);
  }

  return { symbol, free, setFree, timeframe, setTimeframe, period, setPeriod, lookback, setLookback, busy, result, status, review, reviewIfUntouched };
}

export function DeviationSection({ dev, pool, order, innerRef }: { dev: ReturnType<typeof useDeviation>; pool: PoolStock[]; order: string[]; innerRef: React.Ref<HTMLElement> }) {
  const { result } = dev;
  const current = dev.symbol || order[0] || '';
  const idx = order.indexOf(current);
  const pos = order.length && idx >= 0 ? `第 ${idx + 1} / ${order.length} 只` : '';

  function step(delta: number) {
    if (!order.length) return;
    const i = idx < 0 ? 0 : (idx + delta + order.length) % order.length;
    void dev.review(order[i] || '');
  }

  const charts = useMemo((): { dev: ChartSpec; pressure: ChartSpec } | null => {
    if (!result?.last) return null;
    const times = result.series.map((s: any) => s.time);
    // 翻到下一只或改了参数,两张图重新铺满;不写的话标题和第一根日期都一样,会沿用上一只的缩放
    const viewKey = `${result.symbol}|${result.timeframe}|${result.period}|${result.lookback}`;
    return {
      dev: {
        ariaLabel: '偏离 z 分数',
        viewKey,
        times,
        lines: [{ values: result.series.map((s: any) => s.z), color: 'blue', width: 1.5, label: 'z' }],
        hlines: [
          { price: 0, color: 'label', dash: [3, 3], alpha: 0.3, tag: false },
          { price: result.z_extreme, color: 'down', dash: [2, 3], alpha: 0.6, label: `+${result.z_extreme}σ 上方极值` },
          { price: -result.z_extreme, color: 'up', dash: [2, 3], alpha: 0.6, label: `−${result.z_extreme}σ 下方极值` },
        ],
        legend: [['—', 'blue', 'z 分数'], ['╌', 'down', '上方极值'], ['╌', 'up', '下方极值']],
        decimals: 2,
        volume: false,
      },
      pressure: {
        ariaLabel: '买卖压力',
        viewKey,
        times,
        lines: [
          { values: result.series.map((s: any) => s.pressure), color: 'orange', width: 1.5, label: '压力' },
          { values: result.series.map((s: any) => (s.buy_pct == null ? null : s.buy_pct / 50 - 1)), color: 'label2', alpha: 0.4, label: '单根原始' },
        ],
        hlines: [{ price: 0, color: 'label', dash: [3, 3], alpha: 0.3, tag: false }],
        legend: [['—', 'orange', '修正版压力'], ['—', 'label2', '单根原始位置']],
        decimals: 2,
        volume: false,
      },
    };
  }, [result]);

  const last = result?.last;
  const tone = result?.extreme === 'overbought' ? 'hot' : result?.extreme === 'oversold' ? 'cold' : '';
  const w = result?.window;

  return (
    <section className="scan-detail" id="panel-deviation" ref={innerRef}>
      <div className="scan-detail-head">
        <SectionTitle>
          极值偏离
          {result ? <span className="scan-detail-sym">{result.symbol}</span> : null}
        </SectionTitle>
        <span className="scan-detail-step">
          <span className="muted">{[dev.status, pos].filter(Boolean).join(' · ')}</span>
          <Button size="small" icon={<LeftOutlined />} aria-label="上一只" title="上一只" disabled={!order.length} onClick={() => step(-1)} />
          <Button size="small" icon={<RightOutlined />} aria-label="下一只" title="下一只" disabled={!order.length} onClick={() => step(1)} />
        </span>
      </div>
      <div className="row tight scan-bar">
        <Select
          className="grow"
          value={pool.some((s) => s.symbol === current) ? current : undefined}
          placeholder={dev.symbol || '标的'}
          options={pool.map((s) => ({ value: s.symbol, label: s.company ? `${s.symbol} · ${s.company}` : s.symbol }))}
          onChange={(v) => void dev.review(String(v))}
          aria-label="标的"
        />
        <Input
          className="narrow"
          placeholder="或手输"
          maxLength={12}
          value={dev.free}
          onChange={(e) => dev.setFree(e.target.value)}
          onPressEnter={() => void dev.review(dev.free || current)}
          aria-label="手输标的"
        />
        <Select value={dev.timeframe} options={TF_OPTIONS} onChange={dev.setTimeframe} aria-label="K 线周期" style={{ width: 100 }} />
        <Tooltip title="偏离用的均线周期">
          <InputNumber className="narrow" min={2} max={250} step={1} value={dev.period} onChange={(v) => dev.setPeriod(v == null ? null : Number(v))} aria-label="均线周期" />
        </Tooltip>
        <Tooltip title="折 z 分数用的历史根数">
          <InputNumber className="narrow" min={10} max={500} step={10} value={dev.lookback} onChange={(v) => dev.setLookback(v == null ? null : Number(v))} aria-label="z 分数历史长度" />
        </Tooltip>
        <Button id="btn-dev-run" loading={dev.busy} onClick={() => void dev.review(dev.free || current)}>
          复盘
        </Button>
      </div>
      {!result ? (
        dev.busy ? null : (
          <EmptyState>{order.length ? '点上面表里的一行,或在这里选一只、手输一个代码。' : '股票池是空的:先到「板块」页加成分股,或手输一个代码。'}</EmptyState>
        )
      ) : !last ? (
        <StatusCard tone="warn" title="数据不够">
          <div className="muted">{(result.readout || []).join(' ')}</div>
        </StatusCard>
      ) : (
        <div className="cards">
          <div className="stat-grid">
            <StatTile mono label={`偏离 MA${result.period}`} value={`${num(last.dev_pct, 2, true)}%`} tone={tone} />
            <StatTile mono label={`z 分数(近 ${result.lookback} 根)`} value={last.z == null ? '—' : num(last.z, 2, true)} tone={tone} />
            <StatTile mono label="历史分位" value={last.rank_pct == null ? '—' : `${num(last.rank_pct, 0)}%`} />
            <StatTile mono label="修正版买卖压力" value={num(last.pressure, 3, true)} tone={(last.pressure ?? 0) > 0.3 ? 'cold' : (last.pressure ?? 0) < -0.3 ? 'hot' : ''} />
            <StatTile mono label="收盘在真实区间" value={`${num(last.buy_pct, 0)}%`} />
            <StatTile mono label="相对量" value={last.volume_ratio == null ? '—' : `${num(last.volume_ratio, 2)}×`} />
          </div>
          <StatusCard tone={result.extreme ? 'warn' : 'ok'} title={result.extreme_label}>
            <ul className="dev-readout">
              {(result.readout || []).map((line: string, i: number) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </StatusCard>
          {charts ? (
            <>
              <StatusCard title={`偏离程度(收盘相对 MA${result.period},z 分数)`}>
                <CanvasChart size="short" spec={charts.dev} />
              </StatusCard>
              <StatusCard title="修正版买卖压力(−1 全卖压 … +1 全买压,量加权 + 平滑)">
                <CanvasChart size="short" spec={charts.pressure} />
              </StatusCard>
            </>
          ) : null}
          {w ? (
            <Meta
              items={[
                `本段偏离 最大 ${num(w.dev_max.dev_pct, 2, true)}%(${w.dev_max.time}) · 最小 ${num(w.dev_min.dev_pct, 2, true)}%(${w.dev_min.time}) · ` +
                  `压力 最高 ${num(w.pressure_max.pressure, 2, true)}(${w.pressure_max.time}) · 最低 ${num(w.pressure_min.pressure, 2, true)}(${w.pressure_min.time})`,
              ]}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
