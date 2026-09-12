/**
 * 侧栏三组、13 项,按"多久用一次"分层(docs/features/ui.md)。
 * 图标是 ui/Icons.tsx 里按 SF Symbols 几何手绘的线稿,这里只引名字。
 * 徽标:board 显示排队等待触发的订单数,sectors(股票池)显示没看过的异动条数。
 *
 * 「优质股」这一项已经并进「板块」:一只股登记一次(板块成分股 = 股票池),盯价位 / 盯异动是它身上的两个开关,
 * 所以侧栏不再为"盯异动的那几只"单开一项。旧的 quality 页名仍要能跳(见下面的 PARENT_OF)。
 */
export interface NavItem {
  key: string;
  label: string;
  icon: string;
  badge?: 'pending' | 'anomaly';
}

export interface NavGroup {
  key: string;
  title: string;
  bottom?: boolean;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'work',
    title: '工作区',
    items: [
      { key: 'trade', label: '交易指令', icon: 'sf-pencil' },
      { key: 'board', label: '订单看板', icon: 'sf-board', badge: 'pending' },
      { key: 'records', label: '交易记录', icon: 'sf-doc' },
      { key: 'tracker', label: '持仓追踪', icon: 'sf-target' },
    ],
  },
  {
    key: 'research',
    title: '研究',
    items: [
      { key: 'market', label: '行情', icon: 'sf-candles' },
      { key: 'ideas', label: '想法', icon: 'sf-bulb' },
      { key: 'sectors', label: '板块', icon: 'sf-squares', badge: 'anomaly' },
      { key: 'screener', label: '扫描', icon: 'sf-scan' },
      { key: 'backtest', label: '回测', icon: 'sf-chart' },
      { key: 'review', label: '交易分析', icon: 'sf-review' },
    ],
  },
  {
    key: 'app',
    title: '应用',
    bottom: true,
    items: [
      { key: 'access', label: '接入', icon: 'sf-plug' },
      { key: 'settings', label: '设置', icon: 'sf-gear' },
      { key: 'about', label: '关于', icon: 'sf-info' },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** 旧页面里的跳转目标(子页 / 页内一节)→ 侧栏项。React 壳只认侧栏项,子页由旧逻辑自己记。 */
const PARENT_OF: Record<string, string> = {
  pa: 'market',
  book: 'market',
  rs: 'screener',
  inflection: 'screener',
  deviation: 'screener',
  tws: 'access',
  futu: 'access',
  llm: 'access',
  alerts: 'sectors',
  // 异动弹窗的「查看」发的是 page:'quality'(主进程里存着的旧条目也是),那一页已经并进板块页——
  // 这一行不能删:少了它,弹窗点「查看」就哪儿也去不了(startMenuNavigation 只认侧栏里真有的页)。
  quality: 'sectors',
};

export function navKeyFor(tab: string): string {
  return PARENT_OF[tab] || tab;
}

export function groupOf(key: string): NavGroup | undefined {
  return NAV_GROUPS.find((g) => g.items.some((i) => i.key === key));
}
