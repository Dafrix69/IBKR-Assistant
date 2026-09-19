/**
 * 入口。外观与全局 store 先起(状态轮询、盯盘、警告、行情带、引擎日志从第一行起就收),再挂 React 树。
 *
 * 界面写 DOM 的规矩不变:任何来自引擎 / 模型 / 用户的文本只当文本渲染——
 * React 默认转义,dangerouslySetInnerHTML 在这个仓库里不允许出现。
 */
import { createRoot } from 'react-dom/client';
import './styles.css';
import './shell.css';
import './graphics.css';
import { App } from './shell/App';
import { startAlertsLoop } from './store/alerts';
import { startEngineLog } from './store/engineLog';
import { startLlmFeed } from './store/llm';
import { startMacroLoop } from './store/macro';
import { startMenuNavigation } from './store/nav';
import { startNotifyFeed } from './store/notify';
import { startPendingFeed } from './store/pending';
import { startQualityFeed } from './store/quality';
import { startRecordsFeed } from './store/records';
import { startStatusPolling } from './store/status';
import { startTrackerLoops } from './store/tracker';
import { initAppearance } from './store/appearance';

function cspNonce(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]');
  return meta?.nonce || meta?.getAttribute('nonce') || '';
}

/**
 * AntD 的主样式经 ConfigProvider 的 csp 拿到 nonce;但 rc-util 里两处工具样式(测滚动条宽度的临时 <style>、
 * 弹层的滚动锁)不接收 nonce,会被 style-src 拦下并在控制台报错。这里给每个动态创建的 <style> 都补上页面的 nonce:
 * script-src 只有 'self',能创建它们的只有我们自己的包,放行它们正是这条 nonce 的本意。
 */
function nonceAllDynamicStyles(nonce: string): void {
  if (!nonce) return;
  const create = document.createElement.bind(document);
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const node = create(tag, options);
    if (String(tag).toLowerCase() === 'style') node.setAttribute('nonce', nonce);
    return node;
  }) as typeof document.createElement;
}

const nonce = cspNonce();
nonceAllDynamicStyles(nonce);
initAppearance();
startStatusPolling();
startEngineLog();
startRecordsFeed();
startPendingFeed();
startNotifyFeed();
startLlmFeed();
startMacroLoop();
startTrackerLoops();  // 每秒盯盘与托管对账,不看当前在哪一页——止损要保命
startAlertsLoop();    // 价位警告 10 秒一轮,同样不看当前在哪一页
startQualityFeed();   // 异动检测在引擎里 5 秒一轮;这里只订阅它的 anomaly 事件,弹窗 / 响铃同样不看当前在哪一页
startMenuNavigation(); // 弹窗的「查看」经主进程的 menu 通道跳回对应页
createRoot(document.getElementById('root')!).render(<App nonce={nonce} />);
