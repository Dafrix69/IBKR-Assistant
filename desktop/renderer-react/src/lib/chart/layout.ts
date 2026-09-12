// 文字避让。图表库负责轴、网格、蜡烛与十字光标;它不管的是**业务标签挤在一起**——关键位价格在
// 0.6% 区间里扎堆、同一时刻两个事件标签叠在一起。这两个算法从原来的 canvas 引擎原样搬过来。

export interface Tag {
  /** 真实价位对应的 y(像素) */
  y: number;
  /** 避让后实际放置的 y(中心) */
  ly?: number;
  /** 钉住的不动(现价),别人给它让位 */
  pinned?: boolean;
}

/** 一维碰撞避让:按 y 排序,重叠的向两边推开,再夹回区间。pinned 的不动。 */
export function layoutTags<T extends Tag>(tags: T[], minY: number, maxY: number, h: number): Array<T & { ly: number }> {
  const sorted = tags.slice().sort((a, b) => a.y - b.y) as Array<T & { ly: number }>;
  for (const t of sorted) t.ly = Math.min(maxY - h / 2, Math.max(minY + h / 2, t.y));
  for (let pass = 0; pass < 8; pass += 1) {
    let moved = false;
    for (let i = 1; i < sorted.length; i += 1) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const overlap = a.ly + h - b.ly;
      if (overlap > 0) {
        moved = true;
        if (a.pinned && !b.pinned) b.ly += overlap;
        else if (b.pinned && !a.pinned) a.ly -= overlap;
        else {
          a.ly -= overlap / 2;
          b.ly += overlap / 2;
        }
      }
    }
    for (const t of sorted) {
      if (!t.pinned) t.ly = Math.min(maxY - h / 2, Math.max(minY + h / 2, t.ly));
    }
    if (!moved) break;
  }
  return sorted;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 二维的文字标签避让:和已放下的矩形重叠就往 dir 方向挪一行,最多挪 6 次。 */
export function placeLabel(placed: Rect[], rect: Rect, dir: 1 | -1): Rect {
  for (let k = 0; k < 6; k += 1) {
    const hit = placed.some((r) => rect.x < r.x + r.w && rect.x + rect.w > r.x && rect.y < r.y + r.h && rect.y + rect.h > r.y);
    if (!hit) break;
    rect.y += dir * (rect.h + 1);
  }
  placed.push(rect);
  return rect;
}
