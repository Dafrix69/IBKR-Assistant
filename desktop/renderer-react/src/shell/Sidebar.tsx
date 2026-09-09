import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Menu, type MenuProps } from 'antd';
import { NAV_GROUPS, NAV_ITEMS, groupOf, type NavGroup } from './nav';
import { useAlertsArmed } from '../store/alerts';
import { SfIcon } from '../ui/Icons';

interface Props {
  active: string;
  onSelect: (key: string) => void;
  pendingCount: number;
}

type MenuItem = NonNullable<MenuProps['items']>[number];

function readCollapsed(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const g of NAV_GROUPS) {
    try {
      out[g.key] = localStorage.getItem(`dafri-sidegroup-${g.key}`) === '0';
    } catch {
      out[g.key] = false;
    }
  }
  return out;
}

/** 窄窗口只剩图标(Mail / Finder 的做法):Menu 折叠成 56px,项的名字进悬停提示。 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1000px)').matches);
  useEffect(() => {
    const q = window.matchMedia('(max-width: 1000px)');
    const on = () => setNarrow(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return narrow;
}

/**
 * 源列表侧栏:AntD Menu(inline),三组按"多久用一次"分层,组标题可点击折叠(状态记在本地),
 * 「应用」组沉底。徽标:订单看板显示排队数,板块显示活跃的价位提醒数。
 * 键盘:方向键在项之间走动、Enter 选中(Menu 自带);Ctrl/⌘ + 1…9 在 App 里。
 */
export function Sidebar({ active, onSelect, pendingCount }: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const alertsCount = useAlertsArmed();
  const narrow = useNarrow();

  const setGroup = useCallback((key: string, open: boolean) => {
    setCollapsed((c) => ({ ...c, [key]: !open }));
    try {
      localStorage.setItem(`dafri-sidegroup-${key}`, open ? '1' : '0');
    } catch {
      /* 同上 */
    }
  }, []);

  // 目标在折叠着的组里(快捷键 / 就绪清单跳过来):把组展开,不然选中项看不见。
  // 只在**切页**时做:否则用户点组标题收起自己正在看的那一组,会被这里立刻顶开,永远收不起来。
  const lastActive = useRef<string | null>(null);
  useEffect(() => {
    if (lastActive.current === active) return;
    lastActive.current = active;
    const g = groupOf(active);
    if (g && collapsed[g.key]) setGroup(g.key, true);
  }, [active, collapsed, setGroup]);

  const badgeOf = (badge?: 'pending' | 'alerts') => (badge === 'pending' ? pendingCount : badge === 'alerts' ? alertsCount : 0);

  const buildItems = useCallback(
    (groups: NavGroup[]): MenuItem[] => {
      const leaf = (it: (typeof NAV_ITEMS)[number]): MenuItem => {
        const n = badgeOf(it.badge);
        return {
          key: it.key,
          icon: <SfIcon name={it.icon} />,
          title: it.label,
          label: (
            <span className="nav-label">
              <span className="nav-text">{it.label}</span>
              {it.badge ? (narrow ? <Badge dot={n > 0} className="nav-dot" /> : <Badge count={n} size="small" className="nav-badge" />) : null}
            </span>
          ),
        };
      };
      // 图标栏没有地方放组标题:窄窗口下三组摊平
      if (narrow) return groups.flatMap((g) => g.items.map(leaf));
      return groups.map((g) => ({
        key: `group:${g.key}`,
        label: g.title,
        className: 'sidebar-group',
        children: g.items.map(leaf),
      }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [narrow, pendingCount, alertsCount],
  );

  const top = useMemo(() => buildItems(NAV_GROUPS.filter((g) => !g.bottom)), [buildItems]);
  const bottom = useMemo(() => buildItems(NAV_GROUPS.filter((g) => g.bottom)), [buildItems]);
  const openKeys = NAV_GROUPS.filter((g) => !collapsed[g.key]).map((g) => `group:${g.key}`);

  const common: MenuProps = {
    mode: 'inline',
    inlineIndent: 8,
    inlineCollapsed: narrow,
    selectedKeys: [active],
    openKeys: narrow ? [] : openKeys,
    onOpenChange: (keys) => {
      for (const g of NAV_GROUPS) setGroup(g.key, keys.includes(`group:${g.key}`));
    },
    onClick: ({ key }) => onSelect(String(key)),
    expandIcon: ({ isOpen }) => <span className={`group-chevron${isOpen ? ' open' : ''}`} aria-hidden="true" />,
  };

  return (
    <nav className={`sidebar${narrow ? ' narrow' : ''}`} aria-label="主导航">
      <Menu {...common} items={top} className="sidebar-menu" />
      <Menu {...common} items={bottom} className="sidebar-menu bottom" />
    </nav>
  );
}
