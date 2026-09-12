import { useEffect, useState } from 'react';
import { Button, Card, Input, Space, Tooltip } from 'antd';
import { AlertMethods } from '../lib/AlertMethods';
import { fmtWhen } from '../lib/anomalyFormat';
import { Conditions } from '../lib/Conditions';
import { fmtTime, fmtTimeShort } from '../lib/format';
import { MonitorLine } from '../lib/MonitorLine';
import { PoolStock } from '../lib/PoolStock';
import { loadAlerts, useAlerts, type AlertEvent } from '../store/alerts';
import { clearNavFocus, clearNavFocusFor, useNavFocus } from '../store/nav';
import { loadQuality, markQualitySeen, useQuality } from '../store/quality';
import {
  addSector,
  addStock,
  deleteSector,
  loadSectors,
  pickSector,
  refreshQuotes,
  useQuotes,
  useSectors,
  type Sector,
} from '../store/sectors';
import { gatewayName, useStatus } from '../store/status';
import { EmptyState, Feed, Meta, PageHead, Primer, SectionTitle } from '../ui/kit';

/**
 * 板块 = 股票池。一只股登记一次(板块成分股),「价位」「异动」是它身上的两个开关(lib/PoolStock.tsx)。
 *
 * 2026-09-12 以前「优质股」是侧栏里单独一页、单独一张名单,同一只股要在板块、价位提醒、优质股三处各登记一遍;
 * 用户看着侧栏问「这三个功能可以统一吗」,于是并成了这一页。扫描页没并:它本来就读同一个池子,
 * 只是"对这批股批量复盘"的另一种用法。
 */
export function SectorsPage() {
  const sectors = useSectors();
  const status = useStatus();
  const q = useQuality();
  const connected = Boolean(status?.broker_connected);
  const [name, setName] = useState('');
  const focus = useNavFocus('sectors');

  // 进页即刷板块、行情、价位与异动(两个开关的真值、量比都在后两份里);行情每 30 秒一轮(需已连券商),
  // 异动那份每 5 秒重读一次——它是本地道,只读库和内存,不碰券商。
  // 窗口在后台时报来的异动算"没看",切回前台才清未读
  useEffect(() => {
    void loadSectors().then(() => refreshQuotes());
    void loadAlerts();
    void loadQuality();
    markQualitySeen();
    const quotesTimer = setInterval(() => {
      if (connected) void refreshQuotes();
    }, 30_000);
    const poolTimer = setInterval(() => {
      void loadQuality();
      if (document.hasFocus()) markQualitySeen();
    }, 5_000);
    window.addEventListener('focus', markQualitySeen);
    return () => {
      clearInterval(quotesTimer);
      clearInterval(poolTimer);
      window.removeEventListener('focus', markQualitySeen);
    };
  }, [connected]);

  // 从弹窗「查看」跳过来(价位穿越、异动都是):把那一只股的行滚到眼前、闪一下,两秒后清掉焦点
  useEffect(() => {
    if (!focus) return;
    document.querySelector('#sectors-list .stock-block.focus')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const t = setTimeout(() => clearNavFocus(focus.seq), 2200);
    return () => clearTimeout(t);
  }, [focus, sectors.length]);

  // 没闪完就切走:上面那个定时器随卸载一起清了,焦点却会留在 nav 里,下次进来再闪一遍旧行
  useEffect(() => () => clearNavFocusFor('sectors'), []);

  async function create() {
    const n = name.trim();
    if (!n) return;
    if (await addSector(n)) setName('');
  }

  const anomalyFeed = q.feed.slice(0, 30).map((e) => ({ at: fmtWhen(Number(e.at) * 1000), text: `${e.title} · ${e.text}` }));

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
      <Primer id="intro-sectors" intro summary="池子、两个开关、扫描的关系">
        <p className="hint">
          <strong>板块就是股票池:一只股登记一次</strong>,行上的两个开关决定盯它的什么——
          <strong>价位</strong>(穿越期权墙 / 均线 / 整数关口时弹窗,行下画一条价位条)与
          <strong>异动</strong>(放量 / 急涨急跌 / 大涨大跌,引擎每 5 秒看一遍)。加进来默认两个都开;
          异动最多同时盯 30 只(每只占一条 TWS 行情线路),开不上的会直说。
          「扫描」页对<strong>同一个池子</strong>做批量复盘(RS 强度 / 拐点 / 极值偏离),不用再维护第二份名单。
        </p>
        <p className="hint">
          「AI 选股」由大模型给出板块代表性美股,<strong>仅供研究参考</strong>,不会自动交易。
          行情来自 TWS,未订阅标的用 15 分钟延迟数据;行情每 30 秒刷一次,异动指标每 5 秒。
          <strong>只提醒,不下单。</strong>
        </p>
      </Primer>
      <MonitorLine
        monitor={q.monitor}
        error={q.error}
        loadedAt={q.loadedAt}
        connected={q.monitor ? q.monitor.connected : connected}
        enabledCount={q.stocks.filter((s) => Boolean(s.enabled)).length}
        gateway={gatewayName(status)}
        futu={status?.broker_provider === 'futu'}
      />
      <div className="sector-grid" id="sectors-list">
        {!sectors.length ? (
          <EmptyState>还没有板块。输入一个主题试试,比如「AI 算力」。</EmptyState>
        ) : (
          sectors.map((s) => <SectorCard key={s.id} sector={s} focusSymbol={focus?.symbol ?? null} />)
        )}
      </div>

      <SectionTitle count={anomalyFeed.length}>最近异动</SectionTitle>
      <Feed items={anomalyFeed} empty="还没有异动。盘中放量、急涨急跌时会出现在这里,同时弹窗提醒。" />

      <PriceAlertsSection />

      <SectionTitle>提醒方式</SectionTitle>
      <AlertMethods
        popupSub="屏幕右上角的置顶小窗,不抢键盘焦点;关掉则退回系统通知"
        soundSub="急涨 / 上穿升调,急跌 / 下破降调,放量是同一个音响两下"
        hint="价位提醒与异动提醒共用这两个开关。"
      />

      <SectionTitle>触发条件</SectionTitle>
      <Conditions config={q.config} />
    </section>
  );
}

// ---- 一个板块 ----------------------------------------------------------------------

function SectorCard({ sector, focusSymbol }: { sector: Sector; focusSymbol: string | null }) {
  const quotes = useQuotes();
  const { watches, busy } = useAlerts();
  const { stocks: pool, config } = useQuality();
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
        <p className="muted">还没有成分股:点「AI 选股」生成,或在下面手动添加。加进来的股默认盯价位、盯异动。</p>
      ) : (
        <>
          {/* 卡片内滚动:股票多时不撑破卡片,滚动查看。列头放在滚动区里面:
              十几只时会冒出滚动条,放在外面的列头就比行宽一条滚动条,右边对不齐 */}
          <div className="sector-stocks">
            <PoolHead windowMin={config?.window_min || 5} />
            {sector.stocks.map((stock) => {
              const watch = watches.find((w) => w.symbol === stock.symbol);
              return (
                <PoolStock
                  key={stock.symbol}
                  sectorId={sector.id}
                  stock={stock}
                  quote={quotes[stock.symbol]}
                  watch={watch}
                  quality={pool.find((x) => x.symbol === stock.symbol)}
                  config={config}
                  computing={Boolean(watch && busy.includes(watch.id))}
                  focused={focusSymbol === stock.symbol}
                />
              );
            })}
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

/**
 * 卡片里的列头。行上两个开关长得一模一样、两个倍数也只是两个数——不标出来,人只能挨个悬停去猜哪个是哪个。
 * 列头和行用同一套定宽类(pool-num / pool-switch / pool-remove),靠行里会伸缩的理由列把右半边顶齐。
 */
function PoolHead({ windowMin }: { windowMin: number }) {
  return (
    <div className="stock-row pool-head">
      <span className="pool-head-spacer" />
      <span className="pool-num price">现价</span>
      <span className="pool-num chg">涨跌</span>
      <Tooltip title="全天量比:当日成交量 ÷ 同时段常态(90 日日均量 × 开盘到此刻的常态成交占比)">
        <span className="pool-num rvol">量比</span>
      </Tooltip>
      <Tooltip title={`近 ${windowMin} 分钟成交量 ÷ 同时段常态;一笔大单撑起来的不算`}>
        <span className="pool-num burst">{`${windowMin}分钟`}</span>
      </Tooltip>
      <Tooltip title="盯价位:穿越期权墙 / 均线 / 整数关口时弹窗">
        <span className="pool-switch">价位</span>
      </Tooltip>
      <Tooltip title="盯异动:放量 / 急涨急跌 / 大涨大跌时弹窗(最多同时 30 只)">
        <span className="pool-switch">异动</span>
      </Tooltip>
      <span className="pool-remove" />
    </div>
  );
}

// ---- 价位提醒:口径说明 + 触发记录 ----------------------------------------------------
// 每只股的墙、价位条、「重算墙」都已经在它自己那一行下面了(lib/PoolStock.tsx 的 Levels),
// 这里不再按股摆一遍卡片——那正是"同一只股登记好几处"的老毛病。

function PriceAlertsSection() {
  const { watches, feed, lastCheck } = useAlerts();
  const history: AlertEvent[] = feed.length ? feed : watches.flatMap((w) => (w.events || []).map((e) => ({ ...e, symbol: w.symbol })));
  const feedItems = history.slice(0, 30).map((event) => ({
    at: event.at ? fmtWhen(event.at * 1000) : '—',
    text: `${event.symbol || ''} ${event.text || ''}`,
  }));

  return (
    <div className="page-section" id="section-alerts">
      <SectionTitle count={feedItems.length}>最近价位触发</SectionTitle>
      <div className="sub-head">
        <span className="muted">{`${watches.length} 只在盯价位 · ${lastCheck}`}</span>
      </div>
      <Primer id="intro-alerts" intro summary="价位从哪来、什么时候报">
        <p className="hint">
          价位来自<strong>当天期权墙</strong>(持仓墙 / 成交墙 / 最大痛点 / Gamma 翻转)、<strong>日线趋势位</strong>
          (20 / 60 / 120 / 200 日均线与 52 周高低点)和<strong>整数关口</strong>
          (现价附近的步长整数倍:41 块、步长 5 → 40 和 45)。穿越报一次,离开足够远并过冷却后才再报,不会刷屏。
          <strong>OI 是隔夜存量</strong>,当日到期以成交墙为准。任何页面都会检查(需已连 TWS)。
        </p>
        <p className="hint">
          新开的盯单由引擎<strong>排队慢慢算</strong>(期权链请求贵,一轮只算一只),算好之前行下写「正在算价位…」;
          每天开盘后还会自己重算一遍,均线不会停在上次手点「重算墙」的那天。
        </p>
      </Primer>
      <Feed items={feedItems} empty="还没有价位触发记录。" />
    </div>
  );
}
