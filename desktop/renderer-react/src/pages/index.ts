/**
 * 已迁到 React 的页面。不在这张表里的侧栏项由 LegacyPage 寄宿旧实现。
 * 迁一页:在这里登记,并删掉 renderer/ 里对应的脚本与 HTML 片段。
 */
import type { ComponentType } from 'react';
import { SettingsPage } from './Settings';
import { AboutPage } from './About';
import { RecordsPage } from './Records';
import { TrackerPage } from './Tracker';
import { ScreenerPage } from './Screener';
import { SectorsPage } from './Sectors';
import { BoardPage } from './Board';
import { IdeasPage } from './Ideas';
import { BacktestPage } from './Backtest';
import { ReviewPage } from './Review';
import { PerformancePage } from './Performance';
import { AccessPage } from './Access';
import { TradePage } from './Trade';
import { MarketPage } from './Market';

export const PAGES: Record<string, ComponentType> = {
  trade: TradePage,
  market: MarketPage,
  board: BoardPage,
  ideas: IdeasPage,
  backtest: BacktestPage,
  review: ReviewPage,
  performance: PerformancePage,
  access: AccessPage,
  records: RecordsPage,
  tracker: TrackerPage,
  sectors: SectorsPage,
  screener: ScreenerPage,
  settings: SettingsPage,
  about: AboutPage,
};

/** 合并页的子页(页头分段控件里切)。截图脚本按叶子页逐页拍,这里是它的清单来源。 */
export const PAGE_SUBTABS: Record<string, string[]> = {
  access: ['tws', 'futu', 'llm'],
};

export const LEAF_TABS: string[] = Object.keys(PAGES).flatMap((key) => PAGE_SUBTABS[key] || [key]);
