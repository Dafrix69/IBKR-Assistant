/** 回测结果那一节:总览、净值曲线、成交明细。
 *
 * 2026-09-21 从 pages/Backtest.tsx 搬出来(函数体逐字未改)。
 * 数字全是引擎算的(backtest.ts,黄金基线钉着),这里只负责摆——尤其是「跑赢买入持有多少」
 * 那一项:界面不自己减,减法也在引擎那边。
 */
import { useMemo } from 'react';
import { List } from 'antd';
import type { BacktestCurvePoint, BacktestRunResult, BacktestTrade } from '../bridge';
import { CanvasChart, type ChartSpec } from './Chart';
import type { SpecMarker } from './chart/spec';
import { fmtMoney } from './format';
import { BT_INST_LABELS } from './labels';
import { fmtCond } from './RuleBuilder';
import { Meta, StatTile, StatusCard } from '../ui/kit';

export function BacktestResult({ r, strategyLabel }: { r: BacktestRunResult; strategyLabel?: string }) {
  const beat = r.total_return_pct - r.buy_hold_return_pct;
  const instLabel = r.instrument && r.instrument.type !== 'stock' ? ` · ${BT_INST_LABELS[r.instrument.type] || r.instrument.type}(DTE ${r.instrument.dte},投入 ${r.instrument.risk_pct}%)` : '';
  // 兜底的空数组也要稳定:图表按 spec 的引用决定要不要重新灌数据
  const curve = useMemo((): BacktestCurvePoint[] => r.curve || [], [r.curve]);
  const trades = useMemo((): BacktestTrade[] => r.trade_list || [], [r.trade_list]);

  // 换了标的 / 策略 / 品种再跑一次,视图重新铺满,不沿用上一次的缩放
  const viewKey = `${r.symbol}|${r.strategy}|${r.instrument?.type ?? 'stock'}|${r.start}|${r.end}`;
  const chart = useMemo((): ChartSpec | null => {
    if (curve.length < 2) return null;
    const times = curve.map((pt) => pt.date);
    const at = new Map(times.map((t, i) => [t, i]));
    const markers: SpecMarker[] = [];
    for (const t of trades) {
      if (at.has(t.entry_date)) markers.push({ time: t.entry_date, price: curve[at.get(t.entry_date)!].equity, shape: 'tri-up', color: 'up', fit: false });
      if (t.exit_date && at.has(t.exit_date)) markers.push({ time: t.exit_date, price: curve[at.get(t.exit_date)!].equity, shape: 'tri-down', color: 'down', fit: false });
    }
    return {
      ariaLabel: '净值曲线',
      viewKey,
      times,
      lines: [
        { values: curve.map((pt) => pt.bench), color: 'label2', alpha: 0.6, label: '买入持有' },
        { values: curve.map((pt) => pt.equity), color: 'blue', width: 1.5, label: '策略' },
      ],
      hlines: [{ price: 1, color: 'label', dash: [3, 3], alpha: 0.25, tag: false }],
      markers,
      legend: [['—', 'blue', '策略'], ['—', 'label2', '买入持有'], ['▲', 'up', '买入'], ['▼', 'down', '卖出'], ['╌', 'label2', '起点 1.0']],
      decimals: 3,
    };
  }, [curve, trades, viewKey]);

  const sign = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

  return (
    <>
      <StatusCard tone={beat >= 0 ? 'ok' : 'warn'} title={`${r.symbol} · ${strategyLabel || r.strategy}${instLabel} · ${r.start} ~ ${r.end}(${r.bars} 根日线)`}>
        <div className="stat-grid">
          <StatTile label="策略收益" value={`${r.total_return_pct}%`} tone={sign(r.total_return_pct)} />
          <StatTile label="买入持有" value={`${r.buy_hold_return_pct}%`} tone={sign(r.buy_hold_return_pct)} />
          <StatTile label="超额" value={`${beat >= 0 ? '+' : ''}${beat.toFixed(2)}%`} tone={sign(beat)} />
          <StatTile label="年化" value={`${r.annualized_pct}%`} />
          <StatTile label="最大回撤" value={`${r.max_drawdown_pct}%`} tone="neg" />
          <StatTile label="交易次数" value={String(r.trades)} />
          {r.win_rate_pct != null ? <StatTile label="胜率" value={`${r.win_rate_pct}%`} /> : null}
          <StatTile label="持仓时间占比" value={`${r.exposure_pct}%`} />
        </div>
      </StatusCard>
      {r.rules ? (
        <StatusCard title="本次使用的条件">
          <div>{`入场:${r.rules.entry.map(fmtCond).join(' 且 ')}`}</div>
          <div>{r.rules.exit.length ? `出场:${r.rules.exit.map(fmtCond).join(' 且 ')}` : '出场:持有到区间结束'}</div>
        </StatusCard>
      ) : null}
      <StatusCard title="净值曲线(起点 = 1.0)">
        {chart ? (
          <>
            <CanvasChart size="short" spec={chart} />
            <Meta items={[`${curve[0].date} → ${curve[curve.length - 1].date} · 期末净值 策略 ${curve[curve.length - 1].equity} / 基准 ${curve[curve.length - 1].bench}`, r.cost_pct ? `已扣每边成交成本 ${r.cost_pct}%` : '未扣成交成本']} />
          </>
        ) : null}
      </StatusCard>
      {trades.length && r.strategy !== 'buy_hold' ? (
        <StatusCard title={`交易明细(${trades.length})`}>
          <List
            size="small"
            className="trade-list"
            dataSource={trades}
            renderItem={(t, i) => (
              <List.Item key={i} className="stock-row">
                <span className="stock-sub">{`${t.entry_date} → ${t.exit_date || '持有中'}`}</span>
                <span className="stock-price">{`${fmtMoney(t.entry_price)} → ${fmtMoney(t.exit_price)}`}</span>
                <span className={`status ${t.return_pct >= 0 ? 'filled' : 'rejected'}`}>{`${t.return_pct >= 0 ? '+' : ''}${t.return_pct}%`}</span>
              </List.Item>
            )}
          />
        </StatusCard>
      ) : null}
      <StatusCard tone="warn" title="注意">
        <div>收盘价成交、未计滑点与成本、单标的全仓。历史收益不代表未来;参数越漂亮越要怀疑过拟合。</div>
      </StatusCard>
    </>
  );
}
