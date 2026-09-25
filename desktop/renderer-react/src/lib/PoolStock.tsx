/**
 * 股票池里的一只股 = 一行 + (盯价位时)行下面的价位条。
 *
 * 一只股登记一次(板块成分股 = 股票池),「价位」「异动」是它身上的两个开关:
 * 拨开 = 引擎里建对应的行,拨回 = 删掉它(store/pool.ts 走 `pool.set_watch`,上限如实回报)。
 * 所以这一行上没有"加入追踪"这类第二处登记入口——原来的「盯」与 ☆ 两个按钮就是被这两个开关取代的。
 *
 * 数字口径:现价 / 涨跌 / 两列量比优先用异动循环那一轮的指标(5 秒一轮,还带延迟行情标记),
 * 没有(异动没开、或这一轮没取到)才退回板块行情(30 秒一轮)。量比两列只有开着「异动」才有数——
 * 关着的时候引擎根本没在给这只算,显示「—」而不是留白。
 */
import { DeltaBar, MeterBar } from '../ui/graphics';
import { useRef, useState } from 'react';
import { Button, Input, Switch, Tag, Tooltip } from 'antd';
import type { QualityConfig, QualityMetrics, QualityStock } from '../bridge';
import { burstVerdict } from './alertRules';
import { fmtPrice, fmtSigned, fmtWhen, lastEvent, shortTitle } from './anomalyFormat';
import { LevelStrip } from './LevelStrip';
import { setPoolWatch } from '../store/pool';
import { toggleQuality } from '../store/quality';
import { refreshWatch, useAlerts, type Watch } from '../store/alerts';
import { removeStock, setTag, type Quote, type SectorStock } from '../store/sectors';
import { Meta, cx } from '../ui/kit';

export interface PoolStockProps {
  sectorId: string;
  stock: SectorStock;
  quote: Quote | undefined;
  /** 价位提醒里的那一行(有 = 「价位」开着) */
  watch: Watch | undefined;
  /** 异动监控里的那一行(有 = 「异动」开着) */
  quality: QualityStock | undefined;
  config: QualityConfig | null;
  /** 这只的价位正在重算(store/alerts 的 busy) */
  computing: boolean;
  /** 弹窗「查看」跳过来要指认的就是这一只 */
  focused: boolean;
}

export function PoolStock({ sectorId, stock, quote, watch, quality, config, computing, focused }: PoolStockProps) {
  const [busy, setBusy] = useState<'' | 'price' | 'anomaly'>('');
  const priceOn = Boolean(watch);
  // 「异动」开着 = 引擎这一轮真的在给它算。旧库里可能有"行还在、但被停用过"的股:那时引擎并不检测它,
  // 开关就不能显示成开着——拨开它走 quality.update 把那一行重新启用,而不是再建一行。
  const disabledRow = Boolean(quality) && !quality!.enabled;
  const anomalyOn = Boolean(quality) && Boolean(quality!.enabled);
  const metrics: QualityMetrics | null = quality?.metrics ?? null;
  const last = metrics?.last ?? quote?.last ?? null;
  const changePct = metrics?.change_pct ?? quote?.change_pct ?? null;
  const event = quality ? lastEvent(quality) : null;

  // 行内只放核心竞争点(简短);公司名进悬停提示,不占行宽
  const core = stock.reason !== '手动添加' ? stock.reason : '';
  const tip = [stock.company, core].filter(Boolean).join('\n');

  async function toggle(which: 'price' | 'anomaly', on: boolean) {
    setBusy(which);
    try {
      // 旧库里被停用过的那一行:拨开就是把它重新启用,别再建一行
      if (which === 'anomaly' && on && disabledRow) await toggleQuality(quality!.id, true);
      else await setPoolWatch(stock.symbol, which === 'price' ? { price: on } : { anomaly: on });
    } finally {
      setBusy('');
    }
  }

  return (
    <div className={cx('stock-block', focused && 'focus just-added')} data-symbol={stock.symbol}>
      <div className="stock-row">
        <span className="stock-sym">
          {stock.symbol}
          {event ? (
            <Tooltip title={`最近异动:${shortTitle(event, stock.symbol)} · ${fmtWhen(Number(event.at) * 1000)}${event.text ? `\n${event.text}` : ''}`}>
              <i className={`q-dot ${event.direction === 'up' ? 'up' : event.direction === 'down' ? 'down' : 'info'}`} />
            </Tooltip>
          ) : null}
        </span>
        <Tooltip title={tip || undefined} placement="topLeft">
          <span className="stock-sub">{core || stock.company || ''}</span>
        </Tooltip>
        <TagChip sectorId={sectorId} stock={stock} />
        <PriceCell last={last} delayed={Boolean(metrics?.delayed)} error={quality?.quote_error} anomalyOn={anomalyOn} />
        <span className="pool-num chg">
          {changePct != null && Number.isFinite(changePct) ? (
            <>
              <span className={cx('num', changePct > 0 && 'pos', changePct < 0 && 'neg')}>{fmtSigned(changePct)}</span>
              {/* 涨跌幅画成以 0 为中心的小条(±5% 封顶):几十行竖着扫,长短比数字快 */}
              <DeltaBar value={changePct} scale={5} width={52} />
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </span>
        <RvolCell metrics={metrics} config={config} on={anomalyOn} />
        <BurstCell metrics={metrics} config={config} on={anomalyOn} />
        <SwitchCell
          label="价位"
          tip="盯这只的期权墙 / 均线 / 整数关口,穿越时弹窗提醒;开着才会去算价位"
          checked={priceOn}
          loading={busy === 'price'}
          onChange={(v) => void toggle('price', v)}
          symbol={stock.symbol}
        />
        <SwitchCell
          label="异动"
          tip={disabledRow ? '这只在旧版里被停用过:拨开就重新开始检测' : '盘中每 5 秒检测一轮:放量、急涨急跌、大涨大跌时弹窗提醒'}
          checked={anomalyOn}
          loading={busy === 'anomaly'}
          onChange={(v) => void toggle('anomaly', v)}
          symbol={stock.symbol}
        />
        <Button size="small" type="text" className="pool-remove" onClick={() => void removeStock(sectorId, stock.symbol)}>
          移除
        </Button>
      </div>
      {priceOn ? <Levels watch={watch!} quality={quality} spot={last} computing={computing} /> : null}
    </div>
  );
}

// ---- 行里的几个格 ------------------------------------------------------------------

function PriceCell({ last, delayed, error, anomalyOn }: { last: number | null; delayed: boolean; error?: string | null; anomalyOn: boolean }) {
  if (last != null && Number.isFinite(last)) {
    return (
      <span className="pool-num price">
        {delayed ? (
          <Tooltip title="这只拿到的是延迟行情,提醒会晚约 15 分钟">
            <span className="q-delayed">延迟</span>
          </Tooltip>
        ) : null}
        {fmtPrice(last)}
      </span>
    );
  }
  // 取不到行情(代码不对、没有行情权限)要说出来:一整行"—"会被当成"还没开盘"
  if (error && anomalyOn) {
    return (
      <span className="pool-num price">
        <Tooltip title={error}>
          <span className="warn-text">取不到行情</span>
        </Tooltip>
      </span>
    );
  }
  return (
    <span className="pool-num price">
      <span className="muted">—</span>
    </span>
  );
}

/** 关着「异动」时两列量比一律是「—」:引擎没在给这只算,留白会被当成"还没到时候"。 */
function offCell(): JSX.Element {
  return (
    <Tooltip title="「异动」没开:引擎没在给这只算量比">
      <span className="muted">—</span>
    </Tooltip>
  );
}

function RvolCell({ metrics, config, on }: { metrics: QualityMetrics | null; config: QualityConfig | null; on: boolean }) {
  const thr = config?.rvol_tiers?.[0] ?? 2;
  const v = metrics?.rvol;
  return (
    <span className="pool-num rvol">
      {!on ? (
        offCell()
      ) : v == null || !Number.isFinite(v) ? (
        <span className="muted">—</span>
      ) : (
        <Tooltip title="当日成交量 ÷ 同时段常态(90 日日均量 × 开盘到此刻的常态成交占比)">
          <span className="pool-stack">
            <span className={cx('num', v >= thr && 'hot')}>{`${v.toFixed(1)}×`}</span>
            <MeterBar value={v} max={Math.max(thr * 2, 4)} tint={v >= thr ? 'orange' : 'gray'} width={36} />
          </span>
        </Tooltip>
      )}
    </span>
  );
}

/**
 * 窗口量比自成一套:引擎报不报,看的是"去掉窗口里最大的一笔之后还有几倍"(一笔大宗补报不算放量),
 * 着色必须跟它同口径,否则这一格天天橙着、弹窗一次不来,人就不再信它了。判定见 lib/alertRules.ts
 */
function BurstCell({ metrics, config, on }: { metrics: QualityMetrics | null; config: QualityConfig | null; on: boolean }) {
  const verdict = burstVerdict(metrics, config?.burst_ratio ?? 4);
  if (!on) return <span className="pool-num burst">{offCell()}</span>;
  if (verdict.level === 'none') {
    return (
      <span className="pool-num burst">
        <span className="muted">—</span>
      </span>
    );
  }
  const cell = (
    <span className={cx('num', verdict.level === 'hot' && 'hot', (verdict.level === 'muted' || verdict.level === 'reference') && 'soft')}>
      {`${(metrics!.burst as number).toFixed(1)}×`}
      {verdict.level === 'reference' ? <i className="q-ref">参考</i> : null}
    </span>
  );
  const W = config?.window_min || 5;
  const tip = verdict.note || `近 ${W} 分钟成交量 ÷ 同时段常态;橙色是引擎这一轮真会报的那种放量`;
  return (
    <span className="pool-num burst">
      <Tooltip title={tip}>{cell}</Tooltip>
    </span>
  );
}

function SwitchCell({
  label,
  tip,
  checked,
  loading,
  onChange,
  symbol,
}: {
  label: string;
  tip: string;
  checked: boolean;
  loading: boolean;
  onChange: (v: boolean) => void;
  symbol: string;
}) {
  return (
    <Tooltip title={tip}>
      <span className="pool-switch">
        <Switch size="small" checked={checked} loading={loading} onChange={onChange} aria-label={`${symbol} 盯${label}`} />
      </span>
    </Tooltip>
  );
}

// ---- 价位条 ------------------------------------------------------------------------

/** 'error:没有期权行情权限' → '没有期权行情权限';不是错就是 null。 */
function levelsError(status: string | null | undefined): string | null {
  const s = String(status || '');
  return s.startsWith('error:') ? s.slice(6).trim() || '没说原因' : null;
}

/**
 * 「价位」开着时行下面这一层。价位不是用户点出来的:引擎在异动那条 5 秒循环里捎带算,每轮最多一只,
 * 所以还没轮到的时候要说「正在算价位…」(`levels_status`),算砸了要把原因说出来——不能悄悄空着。
 */
function Levels({ watch, quality, spot, computing }: { watch: Watch; quality: QualityStock | undefined; spot: number | null; computing: boolean }) {
  const levels = watch.levels || [];
  const status = quality?.levels_status;
  const err = levelsError(status);
  const wall = watch.wall;
  const { touchConfig } = useAlerts();
  // 碰均线攒到第几次了:底账里(截至上一根完整日线)窗口内已经有 2 段以上的线,写出来——提醒来之前就看得见它在攒
  const touchCounts = touchConfig?.enabled
    ? (watch.touch?.lines || [])
        .filter((l) => touchConfig.periods.includes(l.period) && l.episodes.length >= 2)
        .map((l) => (
          <Tooltip
            key={`touch${l.period}`}
            title={`近 ${touchConfig.window_days} 个交易日碰过 ${l.period} 日线的几段:${l.episodes.map((e) => (e.start === e.end ? e.start.slice(5) : `${e.start.slice(5)}~${e.end.slice(5)}`)).join('、')}。连着几天贴着线算一段;碰出第 ${touchConfig.min_touches} 段时提醒`}
          >
            <span>{`MA${l.period} 近 ${touchConfig.window_days} 日碰过 ${l.episodes.length} 次`}</span>
          </Tooltip>
        ))
    : [];
  const meta = [
    `整数关口步长 ${watch.step}`,
    watch.expiry ? `到期 ${watch.expiry}` : null,
    wall ? `净 GEX ${wall.net_gex >= 0 ? '正' : '负'} · ${wall.regime === 'positive' ? '压波动' : '放大波动'}` : null,
    wall?.max_pain ? `最大痛点 ${wall.max_pain.strike}` : null,
    wall?.pc_ratio_oi != null ? `P/C ${wall.pc_ratio_oi}` : null,
    // 富途拿不到指数现价,这个价是从期权链用平价关系算出来的。不标出来的话,用户会以为它和真实报价是一回事。
    wall?.spot_source === 'parity' ? (
      <Tooltip title="券商未提供现价,此处由期权链的看跌看涨平价反推;报价不干净时引擎会拒绝计算,而非给出错价。">
        <span>现价由期权链反推</span>
      </Tooltip>
    ) : null,
    (wall?.days_to_expiry ?? 99) <= 1 ? '当天到期:OI 是隔夜存量,以成交墙为准' : null,
    ...touchCounts,
    <Button size="small" type="text" className="inline-link" loading={computing} onClick={() => void refreshWatch(watch.id)}>
      {computing ? '计算中…' : '重算墙'}
    </Button>,
  ];

  if (!levels.length) {
    return (
      <div className="stock-levels muted">
        {computing ? (
          '正在算价位…'
        ) : err ? (
          <span className="warn-text">{`价位没算出来:${err}(过一会儿自动重试)`}</span>
        ) : (
          <Tooltip title="引擎在异动那条 5 秒循环里捎带算价位,每轮最多一只(期权链请求很贵),连着券商、在开盘前后的时段内才做">
            <span>正在算价位…</span>
          </Tooltip>
        )}
        <Button size="small" type="text" className="inline-link" loading={computing} onClick={() => void refreshWatch(watch.id)}>
          立刻算
        </Button>
      </div>
    );
  }
  return (
    <div className="stock-levels">
      <LevelStrip levels={levels} spot={watch.last_price != null ? watch.last_price : spot} />
      <Meta className="pool-wall" items={meta} />
      {err ? <div className="hint warn-text">{`上一次重算没成:${err}`}</div> : null}
    </div>
  );
}

// ---- 业务标签 ----------------------------------------------------------------------

/** 成分股的业务标签胶囊:点一下变成输入框,回车 / 失焦提交,Esc 取消。空串 = 清掉。 */
export function TagChip({ sectorId, stock }: { sectorId: string; stock: SectorStock }) {
  const tag = (stock.tag || '').trim();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tag);
  const done = useRef(false);

  async function finish(commit: boolean) {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    if (commit && next !== tag) await setTag(sectorId, stock.symbol, next);
    setEditing(false);
  }

  if (!editing) {
    return (
      <Tooltip title={tag ? `业务标签:${tag}(点击修改)` : '加一个业务标签(如 芯片 / 数据中心),RS 强度按它汇总'}>
        <Tag
          bordered={false}
          className={`stock-tag${tag ? '' : ' none'}`}
          color={tag ? 'processing' : undefined}
          onClick={() => {
            setDraft(tag);
            done.current = false;
            setEditing(true);
          }}
        >
          {tag || '＋标签'}
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Input
      size="small"
      className="stock-tag-input"
      maxLength={12}
      placeholder="业务标签"
      value={draft}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void finish(true);
        else if (e.key === 'Escape') void finish(false);
      }}
      onBlur={() => void finish(true)}
    />
  );
}
