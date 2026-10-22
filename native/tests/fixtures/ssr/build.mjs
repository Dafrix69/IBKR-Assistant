// 用 vite 的 SSR 模式把 entry.tsx 打成一个 node 能直接 import 的文件(依赖全打进去)。
//   node native/tests/fixtures/ssr/build.mjs <desktop 目录> <输出目录>
// <desktop 目录> 要装好依赖:项目在 iCloud 上时 node_modules 常被收走,用一份拷贝(源码同步过来、node_modules 指向没被收走的那份),
// 例如 /tmp/claude-501/ibkr-qtref/desktop。entry.tsx 先拷进 <desktop>/renderer-react/ 再打包,依赖就都从那份 node_modules 里找。
import { copyFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [desktop, outDir] = process.argv.slice(2);
if (!desktop || !outDir) throw new Error('用法:build.mjs <desktop 目录> <输出目录>');
// 拷进去的两个文件打完就删;给的要是仓库自己的 desktop 就不干(那会在仓库里留下没跟踪的文件)
if (resolve(desktop) === resolve(here, '../../../../desktop')) throw new Error('别把仓库自己的 desktop 传进来:用一份拷贝(见上)');
const root = join(desktop, 'renderer-react');
copyFileSync(join(here, 'entry.tsx'), join(root, 'ssr-entry.tsx'));
copyFileSync(join(here, 'zustand-ssr.js'), join(root, 'ssr-zustand.js'));
process.on('exit', () => {
  rmSync(join(root, 'ssr-entry.tsx'), { force: true });
  rmSync(join(root, 'ssr-zustand.js'), { force: true });
});
const modules = join(desktop, 'node_modules');
// 只在 effect 里才填上的几样(SSR 不跑 effect):打包时把它们的初值换成读 globalThis.__ssrSeed,场景就能把它们灌进去。
// 每一处都要在原文件里恰好找到一次,原文件改了这里当场报错,不会悄悄对着别的东西
const SEEDS = [
  ['src/pages/Trade.tsx', 'const [placeholders, setPlaceholders] = useState<string[]>([]);',
    'const [placeholders, setPlaceholders] = useState<string[]>((globalThis as any).__ssrSeed?.placeholders ?? []);'],
  ['src/lib/SimilarTrades.tsx', 'const [res, setRes] = useState<IdeasSimilarTradesResult | null>(null);',
    'const [res, setRes] = useState<IdeasSimilarTradesResult | null>((globalThis as any).__ssrSeed?.similar ?? null);'],
  ['src/lib/SimilarTrades.tsx', 'const [err, setErr] = useState<string | null>(null);',
    'const [err, setErr] = useState<string | null>((globalThis as any).__ssrSeed?.similarErr ?? null);'],
  // 交易记录页:筛选、关键词、疏密、打开的那一条(点出来的状态);表头点出来的排序(antd 的受控 sortOrder)
  ['src/pages/Records.tsx', "const [filter, setFilter] = useState('all');",
    "const [filter, setFilter] = useState((globalThis as any).__ssrSeed?.filter ?? 'all');"],
  ['src/pages/Records.tsx', "const [keyword, setKeyword] = useState('');",
    "const [keyword, setKeyword] = useState((globalThis as any).__ssrSeed?.keyword ?? '');"],
  ['src/pages/Records.tsx', 'const [density, setDensity] = useState<Density>(readDensity);',
    'const [density, setDensity] = useState<Density>((globalThis as any).__ssrSeed?.density ?? readDensity);'],
  ['src/pages/Records.tsx', 'const [openId, setOpenId] = useState<string | null>(null);',
    'const [openId, setOpenId] = useState<string | null>((globalThis as any).__ssrSeed?.openId ?? null);'],
  ['src/pages/Records.tsx', '  return (\n    <section className="tab-panel active" id="page-records">',
    '  { const s = (globalThis as any).__ssrSeed?.sort; if (s) for (const c of columns as any[]) c.sortOrder = c.dataIndex === s.key ? s.order : null; }\n  return (\n    <section className="tab-panel active" id="page-records">'],
  // 记录详情:records.get 回来之后的样子(effect 在 SSR 里不跑)
  ['src/lib/RecordDetail.tsx', 'const [record, setRecord] = useState<any>(null);',
    'const [record, setRecord] = useState<any>((globalThis as any).__ssrSeed?.detail?.record ?? null);'],
  ['src/lib/RecordDetail.tsx', "const [state, setState] = useState<'loading' | 'ok' | 'gone' | 'error'>('loading');",
    "const [state, setState] = useState<'loading' | 'ok' | 'gone' | 'error'>((globalThis as any).__ssrSeed?.detail?.state ?? 'loading');"],
  ['src/lib/RecordDetail.tsx', "const [error, setError] = useState('');",
    "const [error, setError] = useState((globalThis as any).__ssrSeed?.detail?.error ?? '');"],
  // 行情页:K 线读盘那一节取回来的结果、AI 解读、读着 / 解读着、周期表(effect 里取的);盘口的快照与读着的那几只
  ['src/lib/PaPanel.tsx', 'const [timeframes, setTimeframes] = useState<{ key: string; label: string }[]>([]);',
    'const [timeframes, setTimeframes] = useState<{ key: string; label: string }[]>((globalThis as any).__ssrSeed?.timeframes ?? []);'],
  ['src/lib/PaPanel.tsx', 'const [data, setData] = useState<PaAnalyzeResult | null>(null);',
    'const [data, setData] = useState<PaAnalyzeResult | null>((globalThis as any).__ssrSeed?.pa ?? null);'],
  ['src/lib/PaPanel.tsx', 'const [comment, setComment] = useState<(PaComment & { model: string }) | null>(null);',
    'const [comment, setComment] = useState<(PaComment & { model: string }) | null>((globalThis as any).__ssrSeed?.comment ?? null);'],
  ['src/lib/PaPanel.tsx', 'const [error, setError] = useState<string | null>(null);',
    'const [error, setError] = useState<string | null>((globalThis as any).__ssrSeed?.paError ?? null);'],
  ['src/lib/PaPanel.tsx', 'const [loading, setLoading] = useState(false);',
    'const [loading, setLoading] = useState((globalThis as any).__ssrSeed?.paLoading ?? false);'],
  ['src/lib/PaPanel.tsx', 'const [commenting, setCommenting] = useState(false);',
    'const [commenting, setCommenting] = useState((globalThis as any).__ssrSeed?.commenting ?? false);'],
  ['src/lib/BookWall.tsx', 'const [data, setData] = useState<Record<string, BookCell | undefined>>({});',
    'const [data, setData] = useState<Record<string, BookCell | undefined>>((globalThis as any).__ssrSeed?.books ?? {});'],
  ['src/lib/BookWall.tsx', 'const [loading, setLoading] = useState<Set<string>>(new Set());',
    'const [loading, setLoading] = useState<Set<string>>(new Set((globalThis as any).__ssrSeed?.bookLoading ?? []));'],
  // 想法页:筛选、列表、读不到、总结历史、总结着、附带交易结果、检索词与命中方式、正在分析的那几张(都是点出来 / effect 里取的)
  ['src/pages/Ideas.tsx', "const [filter, setFilter] = useState<'active' | 'all'>('active');",
    "const [filter, setFilter] = useState<'active' | 'all'>((globalThis as any).__ssrSeed?.filter ?? 'active');"],
  ['src/pages/Ideas.tsx', 'const [ideas, setIdeas] = useState<Idea[]>([]);',
    'const [ideas, setIdeas] = useState<Idea[]>((globalThis as any).__ssrSeed?.ideas ?? []);'],
  ['src/pages/Ideas.tsx', 'const [loadError, setLoadError] = useState<string | null>(null);',
    'const [loadError, setLoadError] = useState<string | null>((globalThis as any).__ssrSeed?.loadError ?? null);'],
  ['src/pages/Ideas.tsx', 'const [digests, setDigests] = useState<IdeaDigestRow[]>([]);',
    'const [digests, setDigests] = useState<IdeaDigestRow[]>((globalThis as any).__ssrSeed?.digests ?? []);'],
  ['src/pages/Ideas.tsx', "const [text, setText] = useState('');",
    "const [text, setText] = useState((globalThis as any).__ssrSeed?.text ?? '');"],
  ['src/pages/Ideas.tsx', 'const [digesting, setDigesting] = useState(false);',
    'const [digesting, setDigesting] = useState((globalThis as any).__ssrSeed?.digesting ?? false);'],
  ['src/pages/Ideas.tsx', 'const [withTrades, setWithTrades] = useState(true);',
    'const [withTrades, setWithTrades] = useState((globalThis as any).__ssrSeed?.withTrades ?? true);'],
  ['src/pages/Ideas.tsx', "const [query, setQuery] = useState('');",
    "const [query, setQuery] = useState((globalThis as any).__ssrSeed?.query ?? '');"],
  ['src/pages/Ideas.tsx', 'const [matched, setMatched] = useState<Record<string, IdeaMatch[]>>({});',
    'const [matched, setMatched] = useState<Record<string, IdeaMatch[]>>((globalThis as any).__ssrSeed?.matched ?? {});'],
  ['src/pages/Ideas.tsx', 'const [analyzing, setAnalyzing] = useState(false);',
    'const [analyzing, setAnalyzing] = useState(((globalThis as any).__ssrSeed?.analyzing ?? []).includes(idea.id));'],
  // 板块页:选股着的板块、拨着开关的那一行、正在改标签的那一只(点出来的状态)
  ['src/pages/Sectors.tsx', 'const [picking, setPicking] = useState(false);',
    'const [picking, setPicking] = useState(((globalThis as any).__ssrSeed?.picking ?? []).includes(sector.id));'],
  ['src/lib/PoolStock.tsx', "const [busy, setBusy] = useState<'' | 'price' | 'anomaly'>('');",
    "const [busy, setBusy] = useState<'' | 'price' | 'anomaly'>((globalThis as any).__ssrSeed?.busy?.[stock.symbol] ?? '');"],
  ['src/lib/PoolStock.tsx', 'const [editing, setEditing] = useState(false);',
    'const [editing, setEditing] = useState((globalThis as any).__ssrSeed?.editingTag === stock.symbol);'],
  // 异动与弹窗开关是 useSyncExternalStore:SSR 要一个服务端快照(给它此刻的值);生成器另要一个读快照的口子
  ['src/store/quality.ts', 'return useSyncExternalStore(subscribe, () => snap);',
    'return useSyncExternalStore(subscribe, () => snap, () => snap);'],
  ['src/store/quality.ts', 'export function useQuality(): QualitySnapshot {',
    'export function __qualitySnap(): QualitySnapshot { return snap; }\nexport function useQuality(): QualitySnapshot {'],
  ['src/store/popup.ts', '    () => popupOn,\n  );', '    () => popupOn,\n    () => popupOn,\n  );'],
  // 扫描页:排序、扫描的选项与结果、极值偏离、强势股筛选(点出来 / 取回来的状态)
  ['src/pages/Screener.tsx', 'const [sort, setSort] = useState<SortState | null>(null);',
    'const [sort, setSort] = useState<SortState | null>((globalThis as any).__ssrSeed?.sort ?? null);'],
  ['src/pages/Screener.tsx', "const [benchmark, setBenchmark] = useState<'SPY' | 'QQQ'>('SPY');",
    "const [benchmark, setBenchmark] = useState<'SPY' | 'QQQ'>((globalThis as any).__ssrSeed?.benchmark ?? 'SPY');"],
  ['src/pages/Screener.tsx', "const [timeframes, setTimeframes] = useState<string[]>(['1w', '1d']);",
    "const [timeframes, setTimeframes] = useState<string[]>((globalThis as any).__ssrSeed?.timeframes ?? ['1w', '1d']);"],
  ['src/pages/Screener.tsx', 'const [ma, setMa] = useState<number | null>(20);',
    'const [ma, setMa] = useState<number | null>((globalThis as any).__ssrSeed?.ma ?? 20);'],
  ['src/pages/Screener.tsx', 'const [busy, setBusy] = useState(false);',
    'const [busy, setBusy] = useState((globalThis as any).__ssrSeed?.scanBusy ?? false);'],
  ['src/pages/Screener.tsx', "const [progress, setProgress] = useState('');",
    "const [progress, setProgress] = useState((globalThis as any).__ssrSeed?.progress ?? '');"],
  ['src/pages/Screener.tsx', 'const [rs, setRs] = useState<RsResult | null>(null);',
    'const [rs, setRs] = useState<RsResult | null>((globalThis as any).__ssrSeed?.rs ?? null);'],
  ['src/pages/Screener.tsx', 'const [infl, setInfl] = useState<InflState>(null);',
    'const [infl, setInfl] = useState<InflState>((globalThis as any).__ssrSeed?.infl ?? null);'],
  ['src/lib/DeviationSection.tsx', "const [symbol, setSymbol] = useState('');",
    "const [symbol, setSymbol] = useState((globalThis as any).__ssrSeed?.devSymbol ?? '');"],
  ['src/lib/DeviationSection.tsx', "const [free, setFree] = useState('');",
    "const [free, setFree] = useState((globalThis as any).__ssrSeed?.devFree ?? '');"],
  ['src/lib/DeviationSection.tsx', "const [timeframe, setTimeframe] = useState('1d');",
    "const [timeframe, setTimeframe] = useState((globalThis as any).__ssrSeed?.devTf ?? '1d');"],
  ['src/lib/DeviationSection.tsx', 'const [period, setPeriod] = useState<number | null>(20);',
    'const [period, setPeriod] = useState<number | null>((globalThis as any).__ssrSeed?.devPeriod ?? 20);'],
  ['src/lib/DeviationSection.tsx', 'const [lookback, setLookback] = useState<number | null>(120);',
    'const [lookback, setLookback] = useState<number | null>((globalThis as any).__ssrSeed?.devLookback ?? 120);'],
  ['src/lib/DeviationSection.tsx', 'const [busy, setBusy] = useState(false);',
    'const [busy, setBusy] = useState((globalThis as any).__ssrSeed?.devBusy ?? false);'],
  ['src/lib/DeviationSection.tsx', 'const [result, setResult] = useState<DeviationResult | null>(null);',
    'const [result, setResult] = useState<DeviationResult | null>((globalThis as any).__ssrSeed?.dev ?? null);'],
  ['src/lib/DeviationSection.tsx', "const [status, setStatus] = useState('');",
    "const [status, setStatus] = useState((globalThis as any).__ssrSeed?.devStatus ?? '');"],
  ['src/lib/LeadersSection.tsx', 'const [data, setData] = useState<LeadersResult | null>(null);',
    'const [data, setData] = useState<LeadersResult | null>((globalThis as any).__ssrSeed?.leaders ?? null);'],
  ['src/lib/LeadersSection.tsx', 'const [busy, setBusy] = useState(false);',
    'const [busy, setBusy] = useState((globalThis as any).__ssrSeed?.leadersBusy ?? false);'],
  ['src/lib/LeadersSection.tsx', 'const [error, setError] = useState<string | null>(null);',
    'const [error, setError] = useState<string | null>((globalThis as any).__ssrSeed?.leadersError ?? null);'],
  ['src/lib/LeadersSection.tsx', "const [filter, setFilter] = useState<Filter>('all');",
    "const [filter, setFilter] = useState<Filter>((globalThis as any).__ssrSeed?.leadersFilter ?? 'all');"],
  // 回测页:策略目录、表单、结果;条件搭建器的一句话;参数扫描的表单与结果(点出来 / 取回来的状态)
  ['src/pages/Backtest.tsx', 'const [strategies, setStrategies] = useState<Strategy[]>([]);',
    'const [strategies, setStrategies] = useState<Strategy[]>((globalThis as any).__ssrSeed?.strategies ?? []);'],
  ['src/pages/Backtest.tsx', 'const [symbol, setSymbol] = useState(\'\');',
    'const [symbol, setSymbol] = useState((globalThis as any).__ssrSeed?.symbol ?? \'\');'],
  ['src/pages/Backtest.tsx', 'const [start, setStart] = useState(() => isoDate(new Date(Date.now() - 365 * 86400e3)));',
    'const [start, setStart] = useState(() => (globalThis as any).__ssrSeed?.start ?? isoDate(new Date(Date.now() - 365 * 86400e3)));'],
  ['src/pages/Backtest.tsx', 'const [end, setEnd] = useState(() => isoDate(new Date()));',
    'const [end, setEnd] = useState(() => (globalThis as any).__ssrSeed?.end ?? isoDate(new Date()));'],
  ['src/pages/Backtest.tsx', 'const [strategyKey, setStrategyKey] = useState<string>(\'\');',
    'const [strategyKey, setStrategyKey] = useState<string>((globalThis as any).__ssrSeed?.strategyKey ?? \'\');'],
  ['src/pages/Backtest.tsx', 'const [params, setParams] = useState<Record<string, number | null>>({});',
    'const [params, setParams] = useState<Record<string, number | null>>((globalThis as any).__ssrSeed?.params ?? {});'],
  ['src/pages/Backtest.tsx', 'const [rules, setRules] = useState<Rules>(DEFAULT_RULES);',
    'const [rules, setRules] = useState<Rules>((globalThis as any).__ssrSeed?.rules ?? DEFAULT_RULES);'],
  ['src/pages/Backtest.tsx', 'const [instType, setInstType] = useState(\'stock\');',
    'const [instType, setInstType] = useState((globalThis as any).__ssrSeed?.instType ?? \'stock\');'],
  ['src/pages/Backtest.tsx', 'const [inst, setInst] = useState({ dte: 30 as number | null, offset: 0 as number | null, width: 2 as number | null, risk: 10 as number | null });',
    'const [inst, setInst] = useState((globalThis as any).__ssrSeed?.inst ?? { dte: 30 as number | null, offset: 0 as number | null, width: 2 as number | null, risk: 10 as number | null });'],
  ['src/pages/Backtest.tsx', 'const [cost, setCost] = useState<number | null>(0);',
    'const [cost, setCost] = useState<number | null>((globalThis as any).__ssrSeed?.cost !== undefined ? (globalThis as any).__ssrSeed.cost : 0);'],
  ['src/pages/Backtest.tsx', 'const [result, setResult] = useState<BacktestRunResult | null>(null);',
    'const [result, setResult] = useState<BacktestRunResult | null>((globalThis as any).__ssrSeed?.result ?? null);'],
  ['src/pages/Backtest.tsx', 'const [running, setRunning] = useState(false);',
    'const [running, setRunning] = useState((globalThis as any).__ssrSeed?.running ?? false);'],
  ['src/pages/Backtest.tsx', 'const [failure, setFailure] = useState<string | null>(null);',
    'const [failure, setFailure] = useState<string | null>((globalThis as any).__ssrSeed?.failure ?? null);'],
  ['src/lib/RuleBuilder.tsx', 'const [text, setText] = useState(\'\');',
    'const [text, setText] = useState((globalThis as any).__ssrSeed?.ruleText ?? \'\');'],
  ['src/lib/RuleBuilder.tsx', 'const [generating, setGenerating] = useState(false);',
    'const [generating, setGenerating] = useState((globalThis as any).__ssrSeed?.generating ?? false);'],
  ['src/lib/SweepPanel.tsx', 'const [extra, setExtra] = useState(\'\');',
    'const [extra, setExtra] = useState((globalThis as any).__ssrSeed?.swExtra ?? \'\');'],
  ['src/lib/SweepPanel.tsx', 'const [grid, setGrid] = useState<Record<string, string>>({});',
    'const [grid, setGrid] = useState<Record<string, string>>((globalThis as any).__ssrSeed?.swGrid ?? {});'],
  ['src/lib/SweepPanel.tsx', 'const [split, setSplit] = useState<number | null>(70);',
    'const [split, setSplit] = useState<number | null>((globalThis as any).__ssrSeed?.swSplit !== undefined ? (globalThis as any).__ssrSeed.swSplit : 70);'],
  ['src/lib/SweepPanel.tsx', 'const [folds, setFolds] = useState<number | null>(3);',
    'const [folds, setFolds] = useState<number | null>((globalThis as any).__ssrSeed?.swFolds !== undefined ? (globalThis as any).__ssrSeed.swFolds : 3);'],
  ['src/lib/SweepPanel.tsx', 'const [objective, setObjective] = useState<SweepObjective>(\'return\');',
    'const [objective, setObjective] = useState<SweepObjective>((globalThis as any).__ssrSeed?.swObjective ?? \'return\');'],
  ['src/lib/SweepPanel.tsx', 'const [result, setResult] = useState<BacktestSweepResult | null>(null);',
    'const [result, setResult] = useState<BacktestSweepResult | null>((globalThis as any).__ssrSeed?.swResult ?? null);'],
  ['src/lib/SweepPanel.tsx', 'const [running, setRunning] = useState(false);',
    'const [running, setRunning] = useState((globalThis as any).__ssrSeed?.swRunning ?? false);'],
  ['src/lib/SweepPanel.tsx', 'const [failure, setFailure] = useState<string | null>(null);',
    'const [failure, setFailure] = useState<string | null>((globalThis as any).__ssrSeed?.swFailure ?? null);'],
  // 交易分析页:候选、筛选、新鲜度、结果(取回来的状态;选中的那一笔、周期、EM、类型读 localStorage)
  ['src/pages/Review.tsx', 'const [candidates, setCandidates] = useState<any[]>([]);',
    'const [candidates, setCandidates] = useState<any[]>((globalThis as any).__ssrSeed?.candidates ?? []);'],
  ['src/pages/Review.tsx', 'const [includeLocal, setIncludeLocal] = useState(false);',
    'const [includeLocal, setIncludeLocal] = useState((globalThis as any).__ssrSeed?.includeLocal ?? false);'],
  ['src/pages/Review.tsx', 'const [freshness, setFreshness] = useState(\'—\');',
    'const [freshness, setFreshness] = useState((globalThis as any).__ssrSeed?.freshness ?? \'—\');'],
  ['src/pages/Review.tsx', 'const [available, setAvailable] = useState<boolean | null>(null);',
    'const [available, setAvailable] = useState<boolean | null>((globalThis as any).__ssrSeed?.available !== undefined ? (globalThis as any).__ssrSeed.available : null);'],
  ['src/pages/Review.tsx', 'const [data, setData] = useState<ReviewAnalyzeResult | null>(null);',
    'const [data, setData] = useState<ReviewAnalyzeResult | null>((globalThis as any).__ssrSeed?.data ?? null);'],
  ['src/pages/Review.tsx', 'const [error, setError] = useState<string | null>(null);',
    'const [error, setError] = useState<string | null>((globalThis as any).__ssrSeed?.error ?? null);'],
  ['src/pages/Review.tsx', 'const [loading, setLoading] = useState(false);',
    'const [loading, setLoading] = useState((globalThis as any).__ssrSeed?.loading ?? false);'],
  // 绩效体检页:体检结果、保护规则建议在填、信号成绩单、仓位计算器的每份最大亏损(范围与权益、比例读 localStorage)
  ['src/pages/Performance.tsx', 'const [data, setData] = useState<ReviewPerformanceResult | null>(null);',
    'const [data, setData] = useState<ReviewPerformanceResult | null>((globalThis as any).__ssrSeed?.data ?? null);'],
  ['src/pages/Performance.tsx', 'const [error, setError] = useState<string | null>(null);',
    'const [error, setError] = useState<string | null>((globalThis as any).__ssrSeed?.error ?? null);'],
  ['src/pages/Performance.tsx', 'const [loading, setLoading] = useState(false);',
    'const [loading, setLoading] = useState((globalThis as any).__ssrSeed?.loading ?? false);'],
  ['src/lib/PerformanceExtras.tsx', 'const [busy, setBusy] = useState<string | null>(null);',
    'const [busy, setBusy] = useState<string | null>((globalThis as any).__ssrSeed?.adviceBusy ?? null);'],
  ['src/lib/SignalScorecard.tsx', 'const [data, setData] = useState<ReviewSignalsResult | null>(null);',
    'const [data, setData] = useState<ReviewSignalsResult | null>((globalThis as any).__ssrSeed?.signals ?? null);'],
  ['src/lib/SignalScorecard.tsx', 'const [loading, setLoading] = useState(false);',
    'const [loading, setLoading] = useState((globalThis as any).__ssrSeed?.signalsLoading ?? false);'],
  ['src/lib/SignalScorecard.tsx', 'const [error, setError] = useState<string | null>(null);',
    'const [error, setError] = useState<string | null>((globalThis as any).__ssrSeed?.signalsError ?? null);'],
  ['src/lib/PositionSizer.tsx', 'const [unit, setUnit] = useState<number | null>(typicalRisk);',
    'const [unit, setUnit] = useState<number | null>((globalThis as any).__ssrSeed?.sizerUnit !== undefined ? (globalThis as any).__ssrSeed.sizerUnit : typicalRisk);'],
  // 情报页:筛的关键字;⌘K 里敲的字。档案的抽屉、查标的对话框在 SSR 里不肯渲染(portal):换成就地摆标题、右上角的按钮与正文的替身
  ['src/pages/Intel.tsx', "const [query, setQuery] = useState('');",
    "const [query, setQuery] = useState((globalThis as any).__ssrSeed?.query ?? '');"],
  ['src/shell/DossierHost.tsx', "const [text, setText] = useState('');",
    "const [text, setText] = useState((globalThis as any).__ssrSeed?.lookupText ?? '');"],
  ['src/shell/DossierHost.tsx', "import { Input, Modal, Tag, type InputRef } from 'antd';",
    "import { Input, Tag, type InputRef } from 'antd';\nconst Modal = (p: any) => (p.open ? <div className=\"ssr-modal\"><div className=\"ssr-modal-title\">{p.title}</div>{p.children}</div> : null);"],
  ['src/lib/SymbolDossier.tsx', "import { Button, Drawer, Space, Tag } from 'antd';",
    "import { Button, Space, Tag } from 'antd';\nconst Drawer = (p: any) => <div className=\"ssr-drawer\"><div className=\"ssr-drawer-head\">{p.title}{p.extra}</div><div className=\"ssr-drawer-body\">{p.children}</div></div>;"],
];
// 接入页的五节:状态全在各自的 useState 里,一行一行照抄太长——按「文件、命名空间、原文那一行」生成:
// 场景给了 __ssrSeed[命名空间][变量名] 就用它,没给就用原来的初值(给 null 也算给了)
const PANEL_SEEDS = [
  ['src/lib/TwsPanel.tsx', 'tws', [
    'const [scan, setScan] = useState<TwsScanResult | null>(null);', 'const [scanError, setScanError] = useState<string | null>(null);',
    'const [current, setCurrent] = useState<string | null>(null);', 'const [diag, setDiag] = useState<DiagnoseResult[] | null>(null);',
    "const [diagState, setDiagState] = useState<'idle' | 'working' | 'error'>('idle');", "const [diagError, setDiagError] = useState('');"]],
  ['src/lib/FutuPanel.tsx', 'futu', [
    'const [catalog, setCatalog] = useState<BrokerCatalog | null>(null);', 'const [catalogError, setCatalogError] = useState<string | null>(null);',
    'const [scan, setScan] = useState<FutuScanResult | null>(null);', 'const [scanError, setScanError] = useState<string | null>(null);',
    'const [diag, setDiag] = useState<DiagnoseResult[] | null>(null);', "const [diagState, setDiagState] = useState<'idle' | 'working' | 'error'>('idle');",
    "const [diagError, setDiagError] = useState('');", 'const [switching, setSwitching] = useState<string | null>(null);',
    "const [password, setPassword] = useState('');", 'const [isMd5, setIsMd5] = useState(false);', 'const [saving, setSaving] = useState(false);',
    'const [unlocking, setUnlocking] = useState(false);']],
  ['src/lib/AccountsPanel.tsx', 'accounts', [
    'const [info, setInfo] = useState<AccountsInfo | null>(null);', 'const [draft, setDraft] = useState<Draft | null>(null);', 'const [busy, setBusy] = useState(false);']],
  ['src/lib/FollowPanel.tsx', 'follow', [
    'const [status, setStatus] = useState<FollowStatus | null>(null);', 'const [loadError, setLoadError] = useState<string | null>(null);',
    'const [form, setForm] = useState<FollowForm | null>(null);', "const [token, setToken] = useState('');", "const [newAuthor, setNewAuthor] = useState('');",
    "const [busy, setBusy] = useState<'token' | 'save' | 'reconnect' | null>(null);", 'const [checked, setChecked] = useState(false);']],
  ['src/lib/LlmPanel.tsx', 'llm', [
    "const [provider, setProvider] = useState<string>('');", "const [model, setModel] = useState('');", "const [customModel, setCustomModel] = useState('');",
    "const [baseUrl, setBaseUrl] = useState('');", "const [effort, setEffort] = useState('high');", 'const [temperature, setTemperature] = useState<number | null>(null);',
    'const [maxTokens, setMaxTokens] = useState<number | null>(null);', 'const [timeout, setTimeoutS] = useState<number | null>(null);',
    "const [apiKey, setApiKey] = useState('');", 'const [test, setTest] = useState<LlmTestResult | { pending: true } | null>(null);',
    'const [testing, setTesting] = useState(false);']],
  ['src/lib/connectBits.tsx', 'bits', ['const [launching, setLaunching] = useState<string | null>(null);', 'const [busy, setBusy] = useState(false);']],
  // 设置页、数据与备份、重要事件的口径;关于页与它的支持一节
  ['src/pages/Settings.tsx', 'settings', [
    'const [saved, setSaved] = useState<Settings | null>(null);', 'const [form, setForm] = useState<SettingsForm | null>(null);',
    'const [saving, setSaving] = useState(false);', 'const [checked, setChecked] = useState(false);']],
  ['src/lib/DataPanel.tsx', 'data', [
    'const [info, setInfo] = useState<Backups | null>(null);', 'const [error, setError] = useState<string | null>(null);', 'const [busy, setBusy] = useState<string | null>(null);']],
  ['src/lib/EventsConfig.tsx', 'eventscfg', ['const [draft, setDraft] = useState<Config | null>(config);']],
  ['src/pages/About.tsx', 'about', [
    'const [info, setInfo] = useState<{ app: AppInfo; self: Selftest } | null>(null);', 'const [error, setError] = useState<string | null>(null);']],
  ['src/lib/SupportPanel.tsx', 'support', ['const [busy, setBusy] = useState(false);']],
];
for (const [file, ns, lines] of PANEL_SEEDS) {
  for (const line of lines) {
    const m = /^const \[(\w+), (\w+)\] = useState(<[^(]*>)?\((.*)\);$/.exec(line);
    if (!m) throw new Error(`认不出:${line}`);
    const [, name, setter, type = '', init] = m;
    const seed = `(globalThis as any).__ssrSeed?.${ns}`;
    SEEDS.push([file, line, `const [${name}, ${setter}] = useState${type}((${seed} && '${name}' in ${seed}) ? ${seed}.${name} : ${init});`]);
  }
}
// 原文里同一行出现两次(TwsPanel 与 FutuPanel 各自的文件里各一次没问题;同一个文件里两次就会在下面报错)
const seeds = {
  name: 'ssr-seeds',
  enforce: 'pre',
  transform(code, id) {
    let out = code;
    for (const [file, from, to] of SEEDS) {
      if (!id.endsWith(file)) continue;
      if (out.split(from).length !== 2) throw new Error(`${file} 里没有恰好一处 ${from}`);
      out = out.replace(from, to);
    }
    return out === code ? null : out;
  },
};
const { build } = await import(pathToFileURL(join(modules, 'vite/dist/node/index.js')).href);
const react = (await import(pathToFileURL(join(modules, '@vitejs/plugin-react/dist/index.js')).href)).default;
await build({
  configFile: false,
  logLevel: 'warn',
  root,
  plugins: [seeds, react()],
  // zustand 的钩子换成读此刻状态的那一版(见 zustand-ssr.js)
  resolve: { alias: [{ find: /^zustand$/, replacement: join(root, 'ssr-zustand.js') }] },
  ssr: { noExternal: true },
  build: { ssr: join(root, 'ssr-entry.tsx'), outDir, emptyOutDir: true, target: 'node22', rolldownOptions: { output: { entryFileNames: 'entry.mjs', codeSplitting: false } } },
});
