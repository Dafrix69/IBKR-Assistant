/** 体积预算的闸门:引擎单文件 1,500 行、界面单文件 400 行。
 *
 * 2026-09-17 的体检报告在「机制:让它保持住」里写过第 3 条「不需要工具,写在 CLAUDE.md 里就够」。
 * **那条判断被事实推翻了**:到 2026-09-20 为止,`engine.ts` 长到 2,527 行、`broker.ts` 2,509 行,
 * 界面五个页面 400–875 行——规矩写在文件里没人拦得住它长。09-20/21 花了十二刀把它们拉回来,
 * 所以这里补一道和 `LEGACY_METHODS` 同一种的闸门:**名单只许变短,数字只许变小**。
 *
 * 它不判"该不该拆",只保证:已经超线的不许更超,没超线的不许新超。真要让某个文件变长,
 * 就得来这里改一个数字——那一刻就得回答 CLAUDE.md 那句话:"它是不是两个东西"。
 *
 * 离线、不碰券商:只读源码行数。
 */
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 两片源码各自的预算。界面那 400 行的预算 CLAUDE.md 写的是「页面组件」,这里对整个 renderer-react/src
 *  一视同仁——`lib/` 里的组件长起来一样难读。 */
const SCOPES = [
  { root: "engine-ts/src", exts: [".ts"], budget: 1500 },
  { root: "desktop/renderer-react/src", exts: [".ts", ".tsx"], budget: 400 },
];

/**
 * 现在还超线的文件,以及它此刻的行数。**这张表只许变短,数字只许变小。**
 *
 * 名单里 5 个条目**都量过、都有方案**(写在体检报告末尾):`BrokerRouter` 按状态簇、
 * `TradingEngine` 按四簇(另有两个方法超 150 行)、`FutuRouter` 按面切但排最后、
 * `chart/engine.ts` 是一个 467 行的 `mountChart`、`chart/overlays.ts` 是 308 行的 `SpecOverlay`。
 * **五个的共同约束是同一条:先做真机核对,再动它们。**
 */
const OVER_BUDGET: Record<string, number> = {
  "engine-ts/src/broker.ts": 2398,
  "engine-ts/src/engine.ts": 1777,
  "engine-ts/src/futuBroker.ts": 1740,
  "desktop/renderer-react/src/lib/chart/engine.ts": 535,
  "desktop/renderer-react/src/lib/chart/overlays.ts": 483,
};

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(p, exts, out);
    } else if (exts.some((x) => entry.name.endsWith(x))) {
      out.push(p);
    }
  }
  return out;
}

const rel = (p: string): string => path.relative(ROOT, p).split(path.sep).join("/");
const lineCount = (p: string): number => fs.readFileSync(p, "utf-8").split(/\r?\n/).length;

/** 每个源文件此刻多少行 */
function measure(): Map<string, { lines: number; budget: number }> {
  const out = new Map<string, { lines: number; budget: number }>();
  for (const scope of SCOPES) {
    const dir = path.join(ROOT, scope.root);
    if (!fs.existsSync(dir)) throw new Error(`扫不到 ${scope.root}——是不是目录改名了?`);
    for (const f of walk(dir, scope.exts)) out.set(rel(f), { lines: lineCount(f), budget: scope.budget });
  }
  return out;
}

describe("体积预算:只许变短", () => {
  const sizes = measure();

  it("扫到了东西(路径写错会让这一套静默通过)", () => {
    expect(sizes.size).toBeGreaterThan(100);
    expect([...sizes.keys()]).toContain("engine-ts/src/engine.ts");
    expect([...sizes.keys()]).toContain("desktop/renderer-react/src/bridge.ts");
  });

  it("没有新的文件超线:要么在名单里,要么在预算内", () => {
    const fresh = [...sizes.entries()]
      .filter(([f, s]) => s.lines > s.budget && !(f in OVER_BUDGET))
      .map(([f, s]) => `${f}(${s.lines} 行 > ${s.budget})`);
    expect(fresh, "新超线的文件。先问一句:它是不是两个东西?真要留就往 OVER_BUDGET 里加一行").toEqual([]);
  });

  it("名单里的文件只许变短", () => {
    const grown: string[] = [];
    for (const [f, pinned] of Object.entries(OVER_BUDGET)) {
      const now = sizes.get(f);
      if (now === undefined) continue; // 文件没了 —— 下一条用例管
      if (now.lines > pinned) grown.push(`${f}:${pinned} → ${now.lines}`);
    }
    expect(grown, "这些文件又长了。拆掉,或者说清为什么非长不可").toEqual([]);
  });

  it("名单只留还超线的:降下来了就划掉(同 LEGACY_METHODS 的规矩)", () => {
    const stale: string[] = [];
    for (const [f, pinned] of Object.entries(OVER_BUDGET)) {
      const now = sizes.get(f);
      if (now === undefined) { stale.push(`${f}:文件没了`); continue; }
      if (now.lines <= now.budget) stale.push(`${f}:${now.lines} 行已经在 ${now.budget} 以内`);
      else if (now.lines < pinned) stale.push(`${f}:已经缩到 ${now.lines},把名单里的 ${pinned} 改小`);
    }
    expect(stale, "名单该更新了").toEqual([]);
  });

  it("所有页面组件都在预算内(2026-09-21 九刀拆完的成果,别长回去)", () => {
    const pages = [...sizes.entries()].filter(([f]) => f.startsWith("desktop/renderer-react/src/pages/"));
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.filter(([, s]) => s.lines > s.budget).map(([f, s]) => `${f}(${s.lines})`)).toEqual([]);
  });
});
