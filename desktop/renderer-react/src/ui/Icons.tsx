/**
 * 侧栏图标:按 SF Symbols 的几何手绘的 16×16 线稿(描边 1.4、currentColor),不引外部字体,CSP 依旧只允许 'self'。
 * 迁到 React 时旧 index.html 里的 <symbol> 定义没有跟过来,侧栏一度只剩文字——现在图标就是组件,不再依赖页面里的 <defs>。
 */
import type { CSSProperties, ReactNode } from 'react';

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 } as const;
const ROUND = { ...STROKE, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const GLYPHS: Record<string, ReactNode> = {
  'sf-pencil': <path d="M3 10.5 10.2 3.3a1.4 1.4 0 0 1 2 0l.5.5a1.4 1.4 0 0 1 0 2L5.5 13 3 13.5 3 10.5Z" {...STROKE} strokeLinejoin="round" />,
  'sf-board': (
    <>
      <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="2" {...STROKE} />
      <line x1="2.2" y1="6.4" x2="13.8" y2="6.4" {...STROKE} />
      <line x1="6.4" y1="6.4" x2="6.4" y2="13.2" {...STROKE} />
    </>
  ),
  'sf-antenna': (
    <>
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      <path d="M5.2 10.8a4 4 0 0 1 0-5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.2 12.8a6.8 6.8 0 0 1 0-9.6M12.8 3.2a6.8 6.8 0 0 1 0 9.6" {...ROUND} />
    </>
  ),
  'sf-target': (
    <>
      <circle cx="8" cy="8" r="6" {...STROKE} />
      <circle cx="8" cy="8" r="2.6" {...STROKE} />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" />
    </>
  ),
  'sf-plug': (
    <>
      <path d="M6 2v4M10 2v4" {...ROUND} />
      <path d="M4 6h8v2.2A4 4 0 0 1 8 12.2 4 4 0 0 1 4 8.2z" {...STROKE} strokeLinejoin="round" />
      <path d="M8 12.2V14.5" {...ROUND} />
    </>
  ),
  'sf-cpu': (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1.6" {...STROKE} />
      <rect x="6.6" y="6.6" width="2.8" height="2.8" rx="0.6" fill="currentColor" />
      <path d="M6 4V2M10 4V2M6 14v-2M10 14v-2M4 6H2M4 10H2M14 6h-2M14 10h-2" {...ROUND} />
    </>
  ),
  'sf-doc': (
    <>
      <path d="M4 2.5h5.5L12.5 6v7.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" {...STROKE} strokeLinejoin="round" />
      <path d="M9.5 2.5V6h3" {...STROKE} strokeLinejoin="round" />
      <line x1="5.8" y1="9" x2="10.2" y2="9" {...ROUND} strokeWidth={1.3} />
      <line x1="5.8" y1="11.4" x2="10.2" y2="11.4" {...ROUND} strokeWidth={1.3} />
    </>
  ),
  'sf-squares': (
    <>
      <rect x="2.4" y="2.4" width="4.9" height="4.9" rx="1.2" {...STROKE} />
      <rect x="8.7" y="2.4" width="4.9" height="4.9" rx="1.2" {...STROKE} />
      <rect x="2.4" y="8.7" width="4.9" height="4.9" rx="1.2" {...STROKE} />
      <rect x="8.7" y="8.7" width="4.9" height="4.9" rx="1.2" {...STROKE} />
    </>
  ),
  // 心电折线(SF 的 waveform.path.ecg):优质股页盯的就是"突然跳一下"
  'sf-pulse': <path d="M1.6 8.6h2.9l1.5-4.4 2.4 8.2 1.9-6.1 1.1 2.3h3" {...ROUND} />,
  'sf-ladder': (
    <>
      <line x1="2.6" y1="4" x2="7.2" y2="4" {...ROUND} strokeWidth={1.6} />
      <line x1="8.8" y1="4" x2="13.4" y2="4" {...ROUND} strokeWidth={1.6} />
      <line x1="4.2" y1="8" x2="7.2" y2="8" {...ROUND} strokeWidth={1.6} />
      <line x1="8.8" y1="8" x2="11.8" y2="8" {...ROUND} strokeWidth={1.6} />
      <line x1="5.6" y1="12" x2="7.2" y2="12" {...ROUND} strokeWidth={1.6} />
      <line x1="8.8" y1="12" x2="10.4" y2="12" {...ROUND} strokeWidth={1.6} />
    </>
  ),
  'sf-bell': (
    <>
      <path d="M8 2.2a4 4 0 0 1 4 4v2.6l1 1.9H3l1-1.9V6.2a4 4 0 0 1 4-4Z" {...STROKE} strokeLinejoin="round" />
      <path d="M6.6 12.4a1.5 1.5 0 0 0 2.8 0" {...ROUND} />
    </>
  ),
  'sf-candles': (
    <>
      <line x1="5" y1="1.8" x2="5" y2="14.2" {...ROUND} />
      <rect x="3.2" y="4.4" width="3.6" height="6" rx="0.8" {...STROKE} />
      <line x1="11" y1="2.8" x2="11" y2="13.2" {...ROUND} />
      <rect x="9.2" y="6.6" width="3.6" height="4.6" rx="0.8" fill="currentColor" />
    </>
  ),
  'sf-scan': (
    <>
      <path d="M2.5 5V3.5a1 1 0 0 1 1-1H5M11 2.5h1.5a1 1 0 0 1 1 1V5M13.5 11v1.5a1 1 0 0 1-1 1H11M5 13.5H3.5a1 1 0 0 1-1-1V11" {...ROUND} />
      <path d="M4.5 9.5 6.5 7l1.8 1.6 3.2-3.6" {...ROUND} />
    </>
  ),
  'sf-chart': (
    <>
      <path d="M2.5 2.5v10a1 1 0 0 0 1 1h10" {...ROUND} />
      <path d="M4.5 10.5 7 7.5l2.2 1.8 3.3-4.3" {...ROUND} />
    </>
  ),
  'sf-review': (
    <>
      <circle cx="7" cy="7" r="4.6" {...STROKE} />
      <path d="M10.4 10.4 13.6 13.6" {...ROUND} strokeWidth={1.5} />
      <path d="M5 8.4 6.4 6.6l1.3 1 1.6-2.2" {...ROUND} strokeWidth={1.3} />
    </>
  ),
  'sf-bulb': (
    <>
      <path d="M8 1.8a4.3 4.3 0 0 1 2.5 7.8c-.5.4-.8 1-.8 1.6v.3H6.3v-.3c0-.6-.3-1.2-.8-1.6A4.3 4.3 0 0 1 8 1.8Z" {...STROKE} strokeLinejoin="round" />
      <path d="M6.5 13.2h3M7.1 14.7h1.8" {...ROUND} />
    </>
  ),
  'sf-gear': (
    <>
      <circle cx="8" cy="8" r="2.2" {...STROKE} />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" {...ROUND} />
    </>
  ),
  'sf-info': (
    <>
      <circle cx="8" cy="8" r="6.2" {...STROKE} />
      <circle cx="8" cy="5.2" r="0.9" fill="currentColor" />
      <path d="M8 7.4v3.8" {...ROUND} strokeWidth={1.5} />
    </>
  ),
};

export function SfIcon({ name, size = 16, className, style }: { name: string; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg className={`sf-icon${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={style}>
      {GLYPHS[name] || null}
    </svg>
  );
}
