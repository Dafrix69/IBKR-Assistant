// 把 React 版的界面组件原样渲染成 HTML(服务端渲染),给对拍用:生成器拿它对每个场景渲染一次、抽出文字,
// C++ 那一边的模型要说出同样的话。只在 node 里跑,不进应用。由 build.mjs 拷进 renderer-react/ 旁边、用 vite 的 SSR 模式打包
// (所以 import 写的是 ./src/…:打包时它和 src/ 在同一层)。外面包的那一层和 shell/App.tsx 一样(按钮不插空格、中文)。
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { TrackCard } from './src/lib/TrackCard';
import { TrackerPage } from './src/pages/Tracker';
import { getTrackerSnapshot, loadTracker, pollTrackers, reconcileHosted } from './src/store/tracker';
import { useAlerts } from './src/store/alerts';
import { useStatus } from './src/store/status';
import { loadAlerts, refreshWatch } from './src/store/alerts';
import { refreshStatus } from './src/store/status';
import { TradePage } from './src/pages/Trade';
import { loadLlmCatalog } from './src/store/llm';
import * as trade from './src/store/trade';
import { PayoffAxis, PayoffChart, type PayoffLeg } from './src/ui/graphics';
import { FlyPlanner } from './src/lib/FlyPlanner';
import { PlaybookPanel } from './src/lib/PlaybookPanel';
import * as flyStore from './src/store/flyPlan';
import { loadSpot, useSpot } from './src/store/spot';
import { loadPlaybook, usePlaybook } from './src/store/playbook';
import { loadEvents, useEvents } from './src/store/events';
import { BoardPage } from './src/pages/Board';
import { RecordsPage } from './src/pages/Records';
import { loadPending, usePending, usePendingError } from './src/store/pending';
import { loadRecords, useRecords, useRecordsError } from './src/store/records';
import { pushNotification, useFeed } from './src/store/notify';
import { MarketPage } from './src/pages/Market';
import { IdeasPage } from './src/pages/Ideas';
import { SectorsPage } from './src/pages/Sectors';
import { ScreenerPage } from './src/pages/Screener';
import { BacktestPage } from './src/pages/Backtest';
import { ReviewPage } from './src/pages/Review';
import { PerformancePage } from './src/pages/Performance';
import { IntelPage } from './src/pages/Intel';
import { DossierHost } from './src/shell/DossierHost';
import * as intel from './src/store/intel';
import { AccessPage } from './src/pages/Access';
import { SettingsPage } from './src/pages/Settings';
import { AboutPage } from './src/pages/About';
import * as settingsForm from './src/lib/settingsForm';
import { setSubtab } from './src/store/nav';
import * as followForm from './src/lib/followForm';
import { loadSectors, refreshQuotes, useSectors, useQuotes } from './src/store/sectors';
import { loadQuality, __qualitySnap } from './src/store/quality';
import { setPopupEnabled, isPopupEnabled } from './src/store/popup';
import { setSoundEnabled, useSoundEnabled } from './src/store/alerts';
import { paSpec } from './src/lib/chart/paSpec';
import { BUCKET_LABEL, BUCKET_TINT, OrderStages, StatusPill, statusBucket } from './src/lib/OrderStatus';

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }} wave={{ disabled: true }}>
      <AntdApp>{node}</AntdApp>
    </ConfigProvider>,
  );
}

export function renderTrackCard(props: Parameters<typeof TrackCard>[0]): string {
  return render(<TrackCard {...props} />);
}

/** 价位那一块读的是 store/alerts 的盯单:按场景灌进去(window.dafri.listAlerts 回 window.__watches)。busy 的那几条把重算挂起不回,显示「计算中」 */
export async function seedAlerts(watches: unknown[], busy: string[] = []): Promise<void> {
  (window as unknown as { __watches: unknown[] }).__watches = watches;
  await loadAlerts();
  for (const id of busy) void refreshWatch(id);
  await new Promise((r) => setTimeout(r, 0));
}

/** 券商是哪家(gatewayName 读它):按场景改状态快照(window.dafri.status 回 window.__status) */
export async function seedStatus(status: unknown): Promise<void> {
  (window as unknown as { __status: unknown }).__status = status;
  await refreshStatus();
}

export function renderTrackerPage(): string {
  return render(<TrackerPage />);
}

/** 持仓追踪的数据:照 store/tracker 自己的读法灌进去(window.dafri 的 listTrackers / listPositions / pollTrackers / reconcileTrackers 回场景的那一份) */
export async function seedTracker(): Promise<void> {
  await loadTracker(true);
  await pollTrackers();
  await reconcileHosted();
}

/** 此刻各个 store 里的那一份(SSR 版的 zustand 钩子就是读状态的普通函数,见 zustand-ssr.js):对拍时 C++ 那边拿同样的输入 */
export function snapshot() {
  return { tracker: getTrackerSnapshot(), alerts: useAlerts(), status: useStatus() };
}

/** 交易指令页:整页照原样渲染。输入、结果都在 store/trade 里,由生成器经下面的 trade 这一组原函数灌 */
export function renderTradePage(): string {
  return render(<TradePage />);
}

/** 就绪检查表要知道 Key 配没配:照 store/llm 自己的读法读一遍(window.dafri.llmCatalog 回场景的那一份) */
export async function seedLlm(): Promise<void> {
  await loadLlmCatalog();
}

/** store/trade 的原函数(提交、勾选、写进指令……):生成器直接调它们,记下每一步 */
export { trade };

/** 到期损益图单拎出来(票据之外的输入:带现价、只有一个行权价……) */
export function renderPayoff({ legs, premium, spot }: { legs: PayoffLeg[]; premium: number | null; spot: number | null }): string {
  return render(
    <div className="payoff-wrap">
      <PayoffChart legs={legs} premium={premium} spot={spot} />
      <PayoffAxis legs={legs} spot={spot} />
    </div>,
  );
}

/** 蝴蝶测算面板(右栏的一面):表单与结果都在 store/flyPlan 里,生成器经 fly 这一组原函数灌 */
export function renderFlyPlanner(): string {
  return render(<FlyPlanner onInstruction={() => undefined} />);
}
export function renderPlaybookPanel(): string {
  return render(<PlaybookPanel />);
}
export { flyStore as fly };
/** 面板顶上的现价行、事件提醒、日内剧本:照各自 store 的读法读一遍(window.dafri 回场景的那一份) */
export async function seedPanels(): Promise<void> {
  await Promise.all([loadSpot(), loadPlaybook(), loadEvents(true)]);
}
export function panelSnapshot() {
  return { fly: flyStore.useFlyPlan(), spot: useSpot(), playbook: usePlaybook(), events: useEvents(), status: useStatus() };
}

/** 订单看板:条件单、交易记录、通知流照各自 store 的读法灌(window.dafri 回场景的那一份;通知流走 pushNotification) */
export function renderBoardPage(): string {
  return render(<BoardPage />);
}
export async function seedBoard(): Promise<void> {
  await Promise.all([loadPending(), loadRecords()]);
}
export { pushNotification };
export function boardSnapshot() {
  return { pending: usePending(), pendingError: usePendingError(), records: useRecords(), recordsError: useRecordsError(), feed: useFeed() };
}

/** 一笔记录的状态口径:分在哪一档、阶段路径与状态胶囊的 HTML(原组件) */
export function orderStatus(record: { final_status?: string | null; status?: string | null }) {
  return { bucket: statusBucket(record), tint: BUCKET_TINT[statusBucket(record)], bucketLabel: BUCKET_LABEL[statusBucket(record)],
    stagesHtml: render(<OrderStages record={record} />), pillHtml: render(<StatusPill record={record} />) };
}

/** 交易记录页:列表照 store/records.ts 的读法灌;筛选、关键词、疏密、排序、打开的详情由 globalThis.__ssrSeed 给 */
export function renderRecordsPage(): string {
  return render(<RecordsPage />);
}
export { ticketFromRecord } from './src/lib/OrderTicket';

/** 行情页:K 线读盘的结果、盘口快照由 globalThis.__ssrSeed 给;标的、周期、只看正常时段、关注的盘口、参考资料开没开读 localStorage(生成器按场景换) */
export function renderMarketPage(): string {
  return render(<MarketPage />);
}
export { paSpec };
export { refreshStatus };

/** 想法页:列表、总结、检索词、点出来的状态都由 globalThis.__ssrSeed 给 */
export function renderIdeasPage(): string {
  return render(<IdeasPage />);
}

/** 板块页:板块与行情、价位、异动照各自 store 的读法灌(window.dafri 回场景的那一份) */
export function renderSectorsPage(): string {
  return render(<SectorsPage />);
}
export async function seedSectors(): Promise<void> {
  await loadSectors();
  await refreshQuotes();
  await Promise.all([loadAlerts(), loadQuality()]);
}
export { setPopupEnabled, setSoundEnabled };
/** 板块页此刻用到的各份 store(C++ 那边拿同样的输入) */
export function sectorsSnapshot() {
  return { sectors: useSectors(), quotes: useQuotes(), quality: __qualitySnap(), alerts: useAlerts(), status: useStatus(), popup: isPopupEnabled(), sound: useSoundEnabled() };
}
export { refreshWatch };

/** 扫描页:板块读 store/sectors(window.dafri.listSectors);扫描、极值偏离、强势股的结果由 globalThis.__ssrSeed 给 */
export function renderScreenerPage(): string {
  return render(<ScreenerPage />);
}
export { loadSectors };

// 回测页(pages/Backtest.tsx):状态全由 __ssrSeed 灌进 useState(效果在 SSR 里不跑,换策略带出默认参数那一步由种子给)
export function renderBacktestPage(): string {
  return render(<BacktestPage />);
}

// 交易分析页(pages/Review.tsx):状态由 __ssrSeed 与 localStorage 给(效果在 SSR 里不跑:读候选、筛选后退到第一笔那两步由种子给)
export function renderReviewPage(): string {
  return render(<ReviewPage />);
}

// 绩效体检页(pages/Performance.tsx):状态由 __ssrSeed 与 localStorage 给(效果在 SSR 里不跑:进页那一次取数由种子给)
export function renderPerformancePage(): string {
  return render(<PerformancePage />);
}
export { sizePosition } from './src/lib/sizing';
export { cardSubtitle, cardFootnote } from './src/lib/shareCardDraw';

// 情报页(pages/Intel.tsx)与全站共用的档案抽屉、⌘K 查标的(shell/DossierHost.tsx):状态在 store/intel(场景先按原样调它的函数灌数据),
// 关键字与 ⌘K 里敲的字由 __ssrSeed 给;抽屉与对话框换成就地渲染的替身(见 build.mjs)
export function renderIntelPage(): string {
  return render(<IntelPage />);
}
export function renderDossierHost(): string {
  return render(<DossierHost />);
}
export { intel };
export function intelSnapshot() {
  let snap: unknown = null;
  const Probe = () => {
    snap = intel.useIntel();
    return null;
  };
  render(<Probe />);
  return snap;
}

// 接入页(pages/Access.tsx):子页签由 store/nav 给,各节的 useState 由 __ssrSeed 按命名空间给(见 build.mjs 的 PANEL_SEEDS)
export function renderAccessPage(sub: string): string {
  setSubtab('access', sub);
  return render(<AccessPage />);
}
/** 大模型目录(store/llm):直接设 store,不走 dafri.llmCatalog */
export async function seedLlmCatalog(catalog: unknown): Promise<void> {
  const api = ((globalThis as any).__zustandStores || []).find((s: any) => s.getState() && 'catalog' in s.getState() && Object.keys(s.getState()).length === 1);
  if (!api) throw new Error('找不到 store/llm');
  api.setState({ catalog });
}
export { followForm };

// 设置页:表单、数据与备份、重要事件口径的 useState 由 __ssrSeed 给(settings / data / eventscfg);外观三项在 store/appearance(按值认出那个 store)
export function renderSettingsPage(): string {
  return render(<SettingsPage />);
}
export function seedAppearance(state: { themeMode: string; updown: string; glass: number }): void {
  const api = ((globalThis as any).__zustandStores || []).find((s: any) => s.getState() && 'themeMode' in s.getState() && 'glass' in s.getState());
  if (!api) throw new Error('找不到 store/appearance');
  api.setState(state);
}
export { settingsForm };
// 关于页:版本信息由 __ssrSeed.about 给;更新一节在 store/update,引擎日志在 store/engineLog
export function renderAboutPage(): string {
  return render(<AboutPage />);
}
export function seedUpdate(state: Record<string, unknown>): void {
  const api = ((globalThis as any).__zustandStores || []).find((s: any) => s.getState() && 'checking' in s.getState() && 'dismissed' in s.getState());
  if (!api) throw new Error('找不到 store/update');
  api.setState(state);
}
export function seedEngineLog(text: string): void {
  const api = ((globalThis as any).__zustandStores || []).find((s: any) => s.getState() && 'lines' in s.getState() && 'text' in s.getState());
  if (!api) throw new Error('找不到 store/engineLog');
  api.setState({ lines: text ? text.split('\n') : [], text });
}
