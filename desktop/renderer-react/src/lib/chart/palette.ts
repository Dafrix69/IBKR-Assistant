// 图表配色:全部从 CSS token 读,画的时候再解析——深浅色与「涨跌配色」切换后重新取一次就是新值。
//
// 蜡烛的配色不用系统绿红:systemGreen / systemRed 是给圆点和开关用的饱和色,几百根挤在一起会发光。
// 这里用图表业界通用的一对(青绿 #26a69a / 珊瑚红 #ef5350,TradingView 的默认值),文字与圆点仍用系统色。

export interface Palette {
  up: string;
  down: string;
  blue: string;
  orange: string;
  purple: string;
  label: string;
  label2: string;
  label3: string;
  separator: string;
  bg: string;
  font: string;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function readPalette(): Palette {
  return {
    up: cssVar('--chart-up', '') || cssVar('--up', '#26a69a'),
    down: cssVar('--chart-down', '') || cssVar('--down', '#ef5350'),
    blue: cssVar('--blue', '#007aff'),
    orange: cssVar('--orange', '#ff9500'),
    purple: cssVar('--purple', '#af52de'),
    label: cssVar('--label', '#000'),
    label2: cssVar('--label-secondary', 'rgba(60,60,67,0.6)'),
    label3: cssVar('--label-tertiary', 'rgba(60,60,67,0.3)'),
    separator: cssVar('--separator', 'rgba(60,60,67,0.18)'),
    bg: cssVar('--chart-bg', '') || cssVar('--bg-elevated', '#fff'),
    font: getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif',
  };
}

/** 颜色写 token 名('up' / 'down' / 'blue' / 'orange' / 'purple' / 'label' / 'label2' / 'label3')或字面量。 */
export function resolveColor(P: Palette, color: string | null | undefined): string {
  if (!color) return P.label2;
  const token = (P as unknown as Record<string, string>)[color];
  return color !== 'font' && token ? token : color;
}

/** 把颜色叠上透明度:支持 #rgb / #rrggbb 与 rgb() / rgba()。其余原样返回。 */
export function withAlpha(color: string, a: number): string {
  const c = String(color).trim();
  if (c.startsWith('#')) {
    const hex = c.length === 4 ? c.slice(1).split('').map((ch) => ch + ch).join('') : c.slice(1, 7);
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((s) => s.trim());
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${a})`;
  }
  return c;
}
