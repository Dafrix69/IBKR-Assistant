import { useEffect, useRef } from 'react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { Topbar } from './Topbar';
import { Sidebar } from './Sidebar';
import { MacroStrip } from './MacroStrip';
import { NAV_ITEMS } from './nav';
import { LEAF_TABS, PAGES } from '../pages';
import { navigate, useTab } from '../store/nav';
import { useStatus } from '../store/status';
import { useAntdTheme } from '../theme/antd';
import { Toasts } from '../ui/Toasts';

/** 壳:统一工具栏 + 源列表侧栏 + 内容区(macOS UI Kit 的应用模板结构),Ant Design 按 styles.css 的 token 配色。 */
export function App({ nonce }: { nonce: string }) {
  const tab = useTab();
  const status = useStatus();
  const theme = useAntdTheme();
  const contentRef = useRef<HTMLElement>(null);

  // 截图脚本(tools/capture_pages.js)靠这两个全局逐页拍
  useEffect(() => {
    window.__dafriNavigate = navigate;
    window.__dafriLeafTabs = LEAF_TABS;
    return () => {
      delete window.__dafriNavigate;
      delete window.__dafriLeafTabs;
    };
  }, []);

  // Ctrl/⌘ + 1…9:按侧栏顺序切页(Mail / Finder 都有);输入框里也生效,因为这组键没有别的含义
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (!(n >= 1 && n <= 9) || !NAV_ITEMS[n - 1]) return;
      e.preventDefault();
      navigate(NAV_ITEMS[n - 1].key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [tab]);

  const Page = PAGES[tab] || PAGES.trade;

  return (
    <ConfigProvider
      theme={theme}
      locale={zhCN}
      csp={{ nonce }}
      button={{ autoInsertSpace: false }}
      // 点击不出水波纹:那是 Material / Ant 的语言,AppKit 的按钮按下只是变暗
      wave={{ disabled: true }}
    >
      <AntdApp notification={{ maxCount: 3 }}>
        <Toasts />
        <Topbar />
        <MacroStrip />
        <div className="shell">
          <Sidebar active={tab} onSelect={navigate} pendingCount={status?.pending_count || 0} />
          <main className="content" ref={contentRef}>
            <Page />
          </main>
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}
