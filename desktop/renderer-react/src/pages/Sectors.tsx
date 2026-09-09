import { useEffect, useRef, useState } from 'react';
import { Button, Card, Input, InputNumber, Space, Tag, Tooltip } from 'antd';
import { fmtMoney, fmtTime, fmtTimeShort } from '../lib/format';
import { LevelStrip } from '../lib/LevelStrip';
import {
  ALERT_SOURCE_LABEL,
  createWatch,
  deleteWatch,
  loadAlerts,
  playAlertTone,
  refreshWatch,
  setSoundEnabled,
  useAlerts,
  useSoundEnabled,
  type AlertEvent,
  type AlertLevel,
  type Watch,
} from '../store/alerts';
import { showBanner } from '../store/banner';
import {
  addSector,
  addStock,
  deleteSector,
  loadSectors,
  pickSector,
  refreshQuotes,
  removeStock,
  setTag,
  useQuotes,
  useSectors,
  type Sector,
  type SectorStock,
} from '../store/sectors';
import { useStatus } from '../store/status';
import { EmptyState, Feed, Group, Meta, PageHead, Primer, SectionTitle, SwitchRow } from '../ui/kit';

export function SectorsPage() {
  const sectors = useSectors();
  const status = useStatus();
  const connected = Boolean(status?.broker_connected);
  const [name, setName] = useState('');
  const [step, setStep] = useState<number | null>(5);

  // 进页即刷板块、行情与提醒;停留期间行情每 30 秒一轮(需已连券商)
  useEffect(() => {
    void loadSectors().then(() => refreshQuotes());
    void loadAlerts();
    const t = setInterval(() => {
      if (connected) void refreshQuotes();
    }, 30_000);
    return () => clearInterval(t);
  }, [connected]);

  async function create() {
    const n = name.trim();
    if (!n) return;
    if (await addSector(n)) setName('');
  }

  return (
    <section className="tab-panel active" id="page-sectors">
      <PageHead
        title="板块"
        extra={
          <Button size="small" type="text" onClick={() => void refreshQuotes()}>
            刷新行情
          </Button>
        }
      />
      <div className="row tight">
        <Input className="grow" placeholder="自定义板块,例:AI 算力、减肥药、光模块" maxLength={50} value={name} onChange={(e) => setName(e.target.value)} onPressEnter={() => void create()} />
        <Button type="primary" onClick={() => void create()}>
          新建板块
        </Button>
      </div>
      <Primer id="intro-sectors" intro summary="选股与行情从哪来">
        <p className="hint">
          「AI 选股」由大模型给出板块代表性美股,<strong>仅供研究参考</strong>,不会自动交易。
          行情来自 TWS,未订阅标的用 15 分钟延迟数据;本页每 30 秒自动刷新。
        </p>
      </Primer>
      <div className="sector-grid" id="sectors-list">
        {!sectors.length ? <EmptyState>还没有板块。输入一个主题试试,比如「AI 算力」。</EmptyState> : sectors.map((s) => <SectorCard key={s.id} sector={s} step={step || 5} />)}
      </div>

      {/* 价位提醒住在板块页:盯的就是板块里的股,墙 / 均线 / 关口按股显示在成分股行下面,这里管盯谁、响不响 */}
      <AlertsSection step={step} onStep={setStep} />
    </section>
  );
}

// ---- 一个板块 ----------------------------------------------------------------------

function SectorCard({ sector, step }: { sector: Sector; step: number }) {
  const [picking, setPicking] = useState(false);
  const [symbol, setSymbol] = useState('');
  const [tag, setTagText] = useState('');

  async function pick() {
    setPicking(true);
    try {
      await pickSector(sector.id);
    } finally {
      setPicking(false);
    }
  }

  async function add() {
    const s = symbol.trim().toUpperCase();
    if (!s) return;
    if (await addStock(sector.id, s, tag.trim())) {
      setSymbol('');
      setTagText('');
    }
  }

  return (
    <Card
      size="small"
      className="sector-card"
      title={<span className="record-sym">{`${sector.name}(${sector.stocks.length})`}</span>}
      extra={
        <Space size={4}>
          <Button size="small" loading={picking} onClick={() => void pick()}>
            {picking ? '选股中…' : sector.stocks.length ? 'AI 重新选股' : 'AI 选股'}
          </Button>
          <Button size="small" type="text" onClick={() => void deleteSector(sector.id, sector.name)}>
            删除
          </Button>
        </Space>
      }
    >
      {!sector.stocks.length ? (
        <p className="muted">还没有成分股:点「AI 选股」生成,或在下面手动添加。</p>
      ) : (
        <>
          {/* 卡片内滚动:股票多时不撑破卡片,滚动查看 */}
          <div className="sector-stocks">
            {sector.stocks.map((stock) => (
              <StockBlock key={stock.symbol} sectorId={sector.id} stock={stock} step={step} />
            ))}
          </div>
          <Meta title={fmtTime(sector.updated_at)} items={[`更新于 ${fmtTimeShort(sector.updated_at)} · AI 结果仅供参考`]} />
        </>
      )}
      <div className="row tight">
        <Input className="grow" placeholder="手动添加,如 NVDA" maxLength={12} value={symbol} onChange={(e) => setSymbol(e.target.value)} onPressEnter={() => void add()} />
        <Tooltip title="业务标签(如 芯片 / 数据中心),RS 强度按它汇总">
          <Input className="narrow" placeholder="业务标签" maxLength={12} value={tag} onChange={(e) => setTagText(e.target.value)} onPressEnter={() => void add()} />
        </Tooltip>
        <Button size="small" onClick={() => void add()}>
          添加
        </Button>
      </div>
    </Card>
  );
}

/** 一只股 = 行 + 价位条,包成一个块:块内不画分隔线,块之间才画 */
function StockBlock({ sectorId, stock, step }: { sectorId: string; stock: SectorStock; step: number }) {
  const quotes = useQuotes();
  const { watches, busy } = useAlerts();
  const [watching, setWatching] = useState(false);
  const quote = quotes[stock.symbol];
  const watch = watches.find((w) => w.symbol === stock.symbol);
  // 行内只放核心竞争点(简短);公司名进悬停提示,不占行宽
  const core = stock.reason !== '手动添加' ? stock.reason : '';
  const tip = [stock.company, core].filter(Boolean).join('\n');

  async function watchIt() {
    setWatching(true);
    const ok = await createWatch(stock.symbol, step);
    if (!ok) setWatching(false);
  }

  return (
    <div className="stock-block">
      <div className="stock-row">
        <span className="stock-sym">{stock.symbol}</span>
        <Tooltip title={tip || undefined} placement="topLeft">
          <span className="stock-sub">{core || stock.company || ''}</span>
        </Tooltip>
        <TagChip sectorId={sectorId} stock={stock} />
        {quote && quote.last != null ? (
          <>
            <span className="stock-price">{fmtMoney(quote.last)}</span>
            {quote.change_pct != null ? (
              <span className={`status ${quote.change_pct >= 0 ? 'filled' : 'rejected'}`}>{`${quote.change_pct >= 0 ? '+' : ''}${quote.change_pct.toFixed(2)}%`}</span>
            ) : null}
          </>
        ) : (
          <span className="muted">—</span>
        )}
        {!watch ? (
          <Tooltip title="算这只股的期权墙 / 均线 / 整数关口,并在穿越时提醒">
            <Button size="small" type="text" disabled={watching} onClick={() => void watchIt()}>
              盯
            </Button>
          </Tooltip>
        ) : null}
        <Button size="small" type="text" onClick={() => void removeStock(sectorId, stock.symbol)}>
          移除
        </Button>
      </div>
      {watch && (watch.levels || []).length ? (
        <div className="stock-levels">
          <LevelStrip levels={watch.levels || []} spot={watch.last_price != null ? watch.last_price : quote?.last} />
        </div>
      ) : watch ? (
        <div className="stock-levels muted">{busy.includes(watch.id) ? '正在算价位…' : '价位还没算出来:到下面「价位提醒」点「重算墙」。'}</div>
      ) : null}
    </div>
  );
}

/** 成分股的业务标签胶囊:点一下变成输入框,回车 / 失焦提交,Esc 取消。空串 = 清掉。 */
function TagChip({ sectorId, stock }: { sectorId: string; stock: SectorStock }) {
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

// ---- 价位提醒(期权墙 · 均线 · 整数关口)----------------------------------------------

function AlertsSection({ step, onStep }: { step: number | null; onStep: (v: number | null) => void }) {
  const { watches, feed, lastCheck } = useAlerts();
  const sound = useSoundEnabled();
  const [symbol, setSymbol] = useState('');

  async function add() {
    const s = symbol.trim().toUpperCase();
    if (!s) {
      showBanner('先填一个标的代码', true);
      return;
    }
    if (await createWatch(s, step || 5)) setSymbol('');
  }

  const history: AlertEvent[] = feed.length ? feed : watches.flatMap((w) => (w.events || []).map((e) => ({ ...e, symbol: w.symbol })));
  const feedItems = history.slice(0, 30).map((event) => {
    const when = event.at ? new Date(event.at * 1000) : null;
    return { at: when ? when.toLocaleTimeString('zh-CN', { hour12: false }) : '—', text: `${event.symbol || ''} ${event.text || ''}` };
  });

  return (
    <div className="page-section" id="section-alerts">
      <SectionTitle>价位提醒(期权墙 · 均线 · 整数关口)</SectionTitle>
      <div className="sub-head">
        <span className="muted">{lastCheck}</span>
      </div>
      <div className="row tight">
        <Input className="grow" placeholder="标的,如 IREN、SPY、SPX" maxLength={12} value={symbol} onChange={(e) => setSymbol(e.target.value)} onPressEnter={() => void add()} />
        <Tooltip title="整数关口步长">
          <InputNumber className="narrow" min={0.1} max={1000} step={0.5} value={step} onChange={(v) => onStep(v == null ? null : Number(v))} aria-label="整数关口步长" />
        </Tooltip>
        <Button type="primary" onClick={() => void add()}>
          开始盯
        </Button>
      </div>
      <Group>
        <SwitchRow
          label="触发时播放提示音"
          sub="上穿升调、下破降调,并弹系统通知"
          checked={sound}
          onChange={setSoundEnabled}
          before={
            <Button
              size="small"
              onClick={(e) => {
                e.preventDefault();
                playAlertTone('down');
                setTimeout(() => playAlertTone('up'), 500);
              }}
            >
              试听
            </Button>
          }
        />
      </Group>
      <Primer id="intro-alerts" intro summary="价位从哪来、什么时候报">
        <p className="hint">
          价位来自<strong>当天期权墙</strong>(持仓墙 / 成交墙 / 最大痛点 / Gamma 翻转)和<strong>整数关口</strong>
          (现价附近的步长整数倍:41 块、步长 5 → 40 和 45)。穿越报一次,离开足够远并过冷却后才再报,不会刷屏。
          <strong>OI 是隔夜存量</strong>,当日到期以成交墙为准。任何页面都会检查(需已连 TWS)。
          <strong>只通知,不下单。</strong>
        </p>
      </Primer>
      <div id="alerts-list" className="sector-grid">
        {!watches.length ? <EmptyState>还没有在盯的标的。</EmptyState> : watches.map((w) => <AlertCard key={w.id} watch={w} />)}
      </div>

      <SectionTitle>最近触发</SectionTitle>
      <Feed items={feedItems} empty="还没有触发记录。" />
    </div>
  );
}

function AlertCard({ watch }: { watch: Watch }) {
  const { busy } = useAlerts();
  const working = busy.includes(watch.id);
  const wall = watch.wall;
  const levels = watch.levels || [];
  return (
    <Card
      size="small"
      className="sector-card"
      title={<span className="record-sym">{watch.symbol}</span>}
      extra={
        <Space size={4}>
          <Button size="small" loading={working} onClick={() => void refreshWatch(watch.id)}>
            {working ? '计算中…' : '重算墙'}
          </Button>
          <Button size="small" type="text" onClick={() => void deleteWatch(watch.id, watch.symbol)}>
            移除
          </Button>
        </Space>
      }
    >
      <Meta items={[watch.last_price != null ? `现价 ${watch.last_price}` : null, `整数关口步长 ${watch.step}`, watch.expiry ? `到期 ${watch.expiry}` : null, `${levels.length} 个价位`]} />
      {wall ? (
        <>
          <Meta
            items={[
              `净 GEX ${wall.net_gex >= 0 ? '正' : '负'}`,
              wall.regime === 'positive' ? '做市商多头 gamma,压波动' : '做市商空头 gamma,放大波动',
              wall.max_pain ? `最大痛点 ${wall.max_pain.strike}` : null,
              // 富途拿不到指数现价,这个价是从期权链用平价关系算出来的。不标出来的话,用户会以为它和真实报价是一回事。
              wall.spot_source === 'parity' ? (
                <Tooltip title="券商未提供现价,此处由期权链的看跌看涨平价反推;报价不干净时引擎会拒绝计算,而非给出错价。">
                  <span>现价由期权链反推</span>
                </Tooltip>
              ) : null,
              wall.pc_ratio_oi != null ? `P/C ${wall.pc_ratio_oi}` : null,
            ]}
          />
          {(wall.days_to_expiry ?? 99) <= 1 ? <div className="stock-sub">当天到期:OI 是隔夜存量,请以成交墙为准。</div> : null}
        </>
      ) : null}
      {!levels.length ? <p className="muted">还没算价位。点「重算墙」。</p> : <Ladder levels={levels} spot={watch.last_price} />}
    </Card>
  );
}

/**
 * 价位梯子:把墙、关口、现价按价格摆到一根竖轴上,离现价多远一眼可见——一列数字要一个个读,位置不用读。
 * 挤在一起的行按和图表轴上标签同一套逻辑推开;行高 22px,整体高度随价位数走。
 */
function Ladder({ levels, spot }: { levels: AlertLevel[]; spot: number | null | undefined }) {
  interface Row {
    price: number;
    level?: AlertLevel;
    spot?: boolean;
    pinned?: boolean;
    y: number;
    ly: number;
  }
  const rows: Row[] = levels.map((l) => ({ price: l.price, level: l, y: 0, ly: 0 }));
  if (spot != null) rows.push({ price: spot, spot: true, pinned: true, y: 0, ly: 0 });
  const prices = rows.map((r) => r.price);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.005 || 1;
  lo -= pad;
  hi += pad;
  const ROW = 22;
  const H = Math.max(120, rows.length * ROW + 16);
  for (const r of rows) r.y = 8 + (1 - (r.price - lo) / (hi - lo)) * (H - 16);
  const sorted = rows.slice().sort((a, b) => a.y - b.y);
  for (const r of sorted) r.ly = r.y;
  for (let pass = 0; pass < 8; pass += 1) {
    let moved = false;
    for (let i = 1; i < sorted.length; i += 1) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const overlap = a.ly + ROW - b.ly;
      if (overlap > 0) {
        moved = true;
        if (a.pinned) b.ly += overlap;
        else if (b.pinned) a.ly -= overlap;
        else {
          a.ly -= overlap / 2;
          b.ly += overlap / 2;
        }
      }
    }
    for (const r of sorted) if (!r.pinned) r.ly = Math.min(H - ROW / 2, Math.max(ROW / 2, r.ly));
    if (!moved) break;
  }
  return (
    <div className="ladder" style={{ height: H }}>
      <div className="ladder-axis" />
      {sorted.map((r, i) => {
        const kind = r.spot ? 'spot' : r.level?.kind === 'resistance' ? 'resistance' : r.level?.kind === 'support' ? 'support' : 'neutral';
        const gap = !r.spot && spot ? ((r.price / spot - 1) * 100).toFixed(2) : null;
        return (
          <div className={`ladder-row ${kind}`} style={{ top: r.ly }} key={i} title={r.spot ? undefined : r.level?.label || ''}>
            <span className="ladder-src">{r.spot ? '现价' : ALERT_SOURCE_LABEL[r.level?.source || ''] || '价位'}</span>
            <i className="ladder-tick" />
            <span className="ladder-price">{String(r.price)}</span>
            {!r.spot ? <span className="ladder-dist">{gap != null ? `${Number(gap) > 0 ? '+' : ''}${gap}%` : ''}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
