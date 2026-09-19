/** 界面这一侧的提醒口径(desktop/renderer-react)。
 *
 * 这里钉的都是"编译期发现不了、真机上却会静默跑偏"的东西:
 *  1. 表里的窗口量比着色必须和引擎的判定同一道口径——橙色天天有、弹窗一次不来,这一列就废了;
 *  2. metrics 的字段是引擎与界面之间的契约,引擎加了字段界面没跟上,界面就只能拿旧口径显示;
 *  3. 一批提醒只响一声、弹窗没收下的要退回系统通知、心跳要自己走、焦点要过期——
 *     每一条都对应一次真机上"提醒悄无声息地没了 / 一直显示监控中"的事故。
 *
 * 纯判定(lib/alertRules.ts)是个不 import 任何东西的模块,这里直接跑它;
 * 剩下的接线(React 组件、CSS)按 desktop-whitelist.spec.ts 的老办法,对着源码核对。
 */
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import * as an from "../src/anomaly.js";
import { REJECTION_CODES } from "../src/models.js";
import { BLOCK_AUTO_EXECUTE, BLOCK_LIVE } from "../src/tracker.js";
import { VALIDATOR_CODES } from "../src/validator.js";

const SRC = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src");
const read = (...p: string[]): string => readFileSync(path.join(SRC, ...p), "utf-8");
const readEngine = (...p: string[]): string => readFileSync(path.resolve(__dirname, "..", ...p), "utf-8");

type BurstLevel = "none" | "hot" | "muted" | "reference" | "plain";
interface Rules {
  BLOCK_SHARE_HEAVY: number;
  burstVerdict(m: unknown, threshold: number): { level: BurstLevel; note: string };
  toneDirection(events: unknown): "up" | "down" | null;
  popupCounts(sent: number, res: unknown): { accepted: number; dropped: number };
}
const rules = (await import(
  /* @vite-ignore */ pathToFileURL(path.join(SRC, "lib", "alertRules.ts")).href
)) as unknown as Rules;

// 词表同样不 import 任何东西,直接跑
const labels = (await import(
  /* @vite-ignore */ pathToFileURL(path.join(SRC, "lib", "labels.ts")).href
)) as unknown as { REJECT_CODE_LABEL: Record<string, string>; REJECT_SOURCE_LABEL: Record<string, string> };

const CFG = an.DEFAULT_ANOMALY_CONFIG;
const DAY = "2026-09-11";
const OPEN_MS = Date.UTC(2026, 8, 11, 13, 30);
const AVG = 1_000_000;
const msAt = (minute: number): number => OPEN_MS + minute * 60_000;
const cum = (minute: number): number => an.cumVolumeFraction(minute);

/** 窗口里铺 12 步,其中一步是占窗口量 blockFrac 的大宗;整个窗口量 = ratio × 同时段常态。 */
function windowCase(minute: number, ratio: number, blockFrac: number): { samples: an.Sample[]; snap: an.VolumeSnapshot } {
  const W = CFG.window_min;
  const STEPS = 12;
  const windowVolume = ratio * AVG * (cum(minute) - cum(minute - W));
  const block = windowVolume * blockFrac;
  const rest = (windowVolume - block) / (STEPS - 1);
  let v = 4_000_000;
  const samples: an.Sample[] = [{ t: msAt(minute - W), volume: v, last: 100 }];
  for (let i = 1; i <= STEPS; i += 1) {
    v += i === 6 ? block : rest;
    samples.push({ t: msAt(minute - W) + (i * W * 60_000) / STEPS, volume: v, last: 100 });
  }
  return { samples, snap: { last: 100, close: 100, volume: v, avg_volume: AVG, hist_vol: null } };
}

function evaluate(minute: number, o: { samples: an.Sample[]; snap: an.VolumeSnapshot }): ReturnType<typeof an.evaluateAnomalies> {
  return an.evaluateAnomalies({
    symbol: "RKLB", snap: o.snap, samples: o.samples, state: null,
    nowMs: msAt(minute), etDate: DAY, minute, config: CFG,
  });
}

describe("界面:窗口量比的着色和引擎的判定同一道口径", () => {
  // 引擎报不报 = 去掉窗口里最大的一步之后还够不够倍数(anomaly.ts 的 sustained);
  // 界面只有 metrics,靠 block_share 复原同一个判断:sustained = burst × (1 − block_share)
  const cases: { what: string; ratio: number; block: number; fires: boolean; level: BurstLevel }[] = [
    { what: "一步步放上来的 6×:引擎报,表里橙", ratio: 6, block: 0.1, fires: true, level: "hot" },
    { what: "6× 全靠一笔大宗:引擎不报,表里压成灰的", ratio: 6, block: 0.8, fires: false, level: "muted" },
    { what: "6× 里最大一笔占四成,去掉只剩 3.6×:差一点,不报也不橙", ratio: 6, block: 0.4, fires: false, level: "muted" },
    { what: "平静的 2×:不报,也不着色", ratio: 2, block: 0.1, fires: false, level: "plain" },
  ];
  for (const c of cases) {
    it(c.what, () => {
      const r = evaluate(120, windowCase(120, c.ratio, c.block));
      expect(r.metrics.burst!).toBeCloseTo(c.ratio, 2);
      expect(r.events.some((e) => e.kind === "burst")).toBe(c.fires);
      expect(rules.burstVerdict(r.metrics, CFG.burst_ratio).level).toBe(c.level);
    });
  }

  it("窗口是流里的短时量兜底来的(block_share 为 null):引擎不报,表里只作参考值", () => {
    const v5 = 6.34 * AVG * (cum(120) - cum(115));
    const r = an.evaluateAnomalies({
      symbol: "RKLB",
      snap: { last: 100, close: 100, volume: 900_000, avg_volume: AVG, hist_vol: null, vol_5m: v5 },
      samples: [{ t: msAt(120), volume: 900_000, last: 100 }],
      state: null, nowMs: msAt(120), etDate: DAY, minute: 120, config: CFG,
    });
    expect(r.metrics.block_share).toBeNull();
    expect(r.events.some((e) => e.kind === "burst")).toBe(false);
    expect(rules.burstVerdict(r.metrics, CFG.burst_ratio).level).toBe("reference");
  });

  it("没有数就是没有数;大单占比高的时候要把占了多少说出来", () => {
    expect(rules.burstVerdict(null, 4).level).toBe("none");
    expect(rules.burstVerdict({ burst: null, block_share: 0.1, basis_volume: "avg_volume" }, 4).level).toBe("none");
    const heavy = rules.burstVerdict({ burst: 5.3, block_share: 0.82, basis_volume: "avg_volume" }, 4);
    expect(heavy.level).toBe("muted");
    expect(heavy.note).toContain("82%");
    expect(heavy.note).toContain("不算放量");
    // 没有日均量、按当日节奏估的那种,得在提示里说清楚
    const pace = rules.burstVerdict({ burst: 2.1, block_share: null, basis_volume: "session_pace" }, 4);
    expect(pace.level).toBe("reference");
    expect(pace.note).toContain("节奏");
  });

  it("一笔大单占了一半以上、但去掉它仍然够倍数:照样是橙的——弹窗马上就来", () => {
    const v = rules.burstVerdict({ burst: 999.9, block_share: 0.5, basis_volume: "avg_volume" }, 4);
    expect(v.level).toBe("hot");
    expect(v.note).toContain("50%");
  });
});

describe("界面:metrics 的字段跟着引擎走", () => {
  function ifaceKeys(src: string, name: string): string[] {
    const start = src.indexOf(`interface ${name} {`);
    expect(start, `找不到 ${name}`).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start));
    return [...body.matchAll(/^ {2}([a-z_]+)\??:/gm)].map((m) => m[1]!);
  }

  it("bridge.ts 的 QualityMetrics 和引擎的 Metrics 一字不差(block_share 就是这么漏掉的)", () => {
    const engine = ifaceKeys(readFileSync(path.resolve(__dirname, "..", "src", "anomaly.ts"), "utf-8"), "Metrics");
    const ui = ifaceKeys(read("bridge.ts"), "QualityMetrics");
    expect(engine).toContain("block_share");
    expect(ui).toEqual(engine);
  });
});

describe("界面:提示音一批只响一声,放量是中性的", () => {
  it("放量(rvol / burst)带的方向只给圆点用,不参与选音——「提醒方式」里写的是同一个音响两下", () => {
    expect(rules.toneDirection([{ kind: "burst", direction: "up" }])).toBeNull();
    expect(rules.toneDirection([{ kind: "rvol", direction: "down" }])).toBeNull();
    expect(rules.toneDirection([{ kind: "rvol", direction: "up" }, { kind: "burst", direction: "up" }])).toBeNull();
  });

  it("价格类才定方向:一致按方向,有涨有跌是中性", () => {
    expect(rules.toneDirection([{ kind: "spike", direction: "up" }])).toBe("up");
    expect(rules.toneDirection([{ kind: "day_move", direction: "down" }, { kind: "burst", direction: "up" }])).toBe("down");
    expect(rules.toneDirection([{ kind: "spike", direction: "up" }, { kind: "day_move", direction: "down" }])).toBeNull();
    // 价位提醒没有 kind,一律按方向
    expect(rules.toneDirection([{ direction: "up" }, { direction: "up" }])).toBe("up");
    expect(rules.toneDirection([])).toBeNull();
    expect(rules.toneDirection(null)).toBeNull();
  });

  it("价位提醒一轮只响一声:轮询不再逐条 announce", () => {
    const alerts = read("store", "alerts.ts");
    expect(alerts).toContain("await announce(fired)");
    expect(alerts).not.toMatch(/for \(const event of fired\) await announce/);
    expect(alerts).toContain("toneDirection(events)");
  });

  it("异动那一批用同一个口径选音", () => {
    expect(read("store", "quality.ts")).toMatch(/playAlertTone\(toneDirection\(/);
  });
});

describe("界面:弹窗没收下的要退回系统通知", () => {
  it("回执读成收下几条、丢了几条;老主进程只回 shown 就当全收了", () => {
    expect(rules.popupCounts(3, { shown: 3 })).toEqual({ accepted: 3, dropped: 0 });
    expect(rules.popupCounts(25, { shown: 20, dropped: 5 })).toEqual({ accepted: 20, dropped: 5 });
    // 只回 shown 的老主进程:少收的那几条也算丢了,不能让它们没了
    expect(rules.popupCounts(25, { shown: 20 })).toEqual({ accepted: 20, dropped: 5 });
    // 弹窗页坏了:一条都没收下,整批退回系统通知
    expect(rules.popupCounts(3, { shown: 0 })).toEqual({ accepted: 0, dropped: 3 });
    // 什么都不回(更老的主进程 / 预览台):当成全收了,宁可少一条通知也不要每条都重复报
    expect(rules.popupCounts(2, undefined)).toEqual({ accepted: 2, dropped: 0 });
    expect(rules.popupCounts(0, { shown: 0 })).toEqual({ accepted: 0, dropped: 0 });
    // 回执里的数不讲理也不能越界
    expect(rules.popupCounts(2, { shown: 99, dropped: -3 })).toEqual({ accepted: 2, dropped: 0 });
  });

  it("两条提醒路都按丢了几条来兜底", () => {
    for (const file of [["store", "quality.ts"], ["store", "alerts.ts"]]) {
      const src = read(...file);
      expect(src, file.join("/")).toMatch(/const \{ dropped \} = await showAlertPopup\(/);
      expect(src, file.join("/")).toMatch(/dropped <= 0/);
      expect(src, file.join("/")).toContain("dafri.notify(title, body)");
    }
  });
});

describe("界面:监控心跳不会永远停在绿色的「监控中」", () => {
  const store = read("store", "quality.ts");
  // 心跳行 2026-09-12 随「优质股」页并进板块页,构件搬到了 lib/MonitorLine.tsx
  const page = read("lib", "MonitorLine.tsx");

  it("列表读失败要记进快照(引擎挂了不会再有回执来触发重画)", () => {
    expect(store).toMatch(/catch \(err\)[\s\S]{0,400}set\(\{ error: msg/);
    expect(store).toMatch(/error: '',\s*\n\s*loadedAt: Date\.now\(\)/);
  });

  it("心跳那一行自己走表:秒数随时间重算,读不到时红着说读不到", () => {
    expect(page).toContain("useNowTick");
    expect(page).toMatch(/setInterval\(\(\) => setNow\(Date\.now\(\)\)/);
    expect(page).toContain("读不到异动监控");
    // 年龄按 tick 算,不能再在渲染里直接读 Date.now()
    expect(page).toMatch(/const age = lastMs != null \? now - lastMs : null;/);
  });
});

describe("界面:跳页之后要真的看得到那一行", () => {
  it("壳层的回顶部是 layout effect(effect 先子后父,普通 effect 会把页面刚滚好的位置拨回去)", () => {
    const app = read("shell", "App.tsx");
    expect(app).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]{0,220}scrollTop = 0/);
    expect(app).toContain("pendingNavFocus(tab)");
    // 普通 effect 里不能再留一份回顶部
    expect(app).not.toMatch(/useEffect\(\(\) => \{\s*if \(contentRef\.current\) contentRef\.current\.scrollTop = 0;/);
  });

  it("焦点有保质期,离开页面也会清掉(否则下次进来再闪一遍旧行)", () => {
    const nav = read("store", "nav.ts");
    expect(nav).toContain("FOCUS_TTL_MS");
    expect(nav).toMatch(/Date\.now\(\) - focus\.at <= FOCUS_TTL_MS/);
    expect(read("pages", "Sectors.tsx")).toContain("clearNavFocusFor('sectors')");
  });
});

describe("界面:股票池一只股登记一次(2026-09-12 板块 + 优质股合页)", () => {
  const row = read("lib", "PoolStock.tsx");

  it("行上是「价位」「异动」两个开关,走 pool.set_watch;不再有 ☆ / 盯 这种搬到另一张名单的按钮", () => {
    expect(row).toMatch(/setPoolWatch\(stock\.symbol, which === 'price' \? \{ price: on \} : \{ anomaly: on \}\)/);
    expect(row).toContain('label="价位"');
    expect(row).toContain('label="异动"');
    expect(row).not.toContain("star-btn");
    expect(row).not.toContain("addQuality");
    expect(read("pages", "Sectors.tsx")).not.toContain("createWatch");
  });

  it("旧库里停用过的异动行:开关显示成关,拨开是重新启用那一行,不是再建一行", () => {
    expect(row).toMatch(/const anomalyOn = Boolean\(quality\) && Boolean\(quality!\.enabled\);/);
    expect(row).toMatch(/if \(which === 'anomaly' && on && disabledRow\) await toggleQuality\(quality!\.id, true\);/);
  });

  it("「正在算价位」读的是异动行上的 levels_status(引擎把它放在 quality.list 的行上)", () => {
    expect(row).toContain("quality?.levels_status");
    expect(row).not.toContain("watch.levels_status");
  });

  it("「优质股」页已经删掉,旧的 quality 页名还能跳回板块页", () => {
    expect(fs.existsSync(path.join(SRC, "pages", "Quality.tsx"))).toBe(false);
    expect(read("pages", "index.ts")).not.toContain("Quality");
    expect(read("shell", "nav.ts")).toMatch(/quality: 'sectors'/);
  });
});

describe("界面:文字着色用可访问变体(docs/features/ui.md)", () => {
  it("行里到档的倍数是小字,橙色用 --orange-text;☆ 按钮与旧表格的样式不留尸体", () => {
    const css = read("shell.css");
    expect(css).toMatch(/\.stock-row \.num\.hot \{ color: var\(--orange-text\)/);
    expect(css).not.toMatch(/\.num\.hot \{ color: var\(--orange\)/);
    expect(css).not.toContain(".star-btn");
    expect(css).not.toContain(".quality-table");
  });
});

// 拒绝卡片是用户读得最仔细的一张卡——单子没发出去,他正等着这张卡告诉他为什么。
// 它原来的第一行是 `校验拒绝 · LIVE_TRADING_DISABLED`,正文里写着 allow_live_trading=false:
// 两样都是引擎内部的说法,一样也不该出现在这里(docs/features/ui.md §第三轮)。
describe("界面:拒绝卡片摆人话,不摆引擎枚举(docs/features/ui.md)", () => {
  // 两道执行闸门在「设置」里各有一个开关,用户读得到的只该是那个开关的名字。
  // 不在名单里的:allow_combo_live 没有设置项、只能手改配置文件,limits.* 的校验错误说的
  // 就是配置本身写错了哪一行——这两种情况下说出键名才是帮忙(见 docs/features/tracker.md)
  const CONFIG_KEYS = ["allow_live_trading", "auto_execute"];

  /** 引擎与券商自己报的码(模型的在 REJECTION_CODES,硬校验的在 VALIDATOR_CODES)。 */
  function engineCodes(): string[] {
    const src = readEngine("src", "engine.ts");
    const codes = [...src.matchAll(/code: "([A-Z_]+)"/g)].map((m) => m[1]!);
    const broker = src.match(/BROKER === "futu" \? "([A-Z_]+)" : "([A-Z_]+)"/);
    expect(broker, "找不到 brokerCode 的两个券商码").not.toBeNull();
    return [...codes, broker![1]!, broker![2]!];
  }

  it("引擎能报出的每一个拒绝码都有中文", () => {
    const all = [...REJECTION_CODES, ...VALIDATOR_CODES, ...engineCodes()];
    const missing = all.filter((code) => !labels.REJECT_CODE_LABEL[code]);
    expect(missing, "labels.ts 的 REJECT_CODE_LABEL 漏了这些码").toEqual([]);
    // 四个来源(engine.ts 里 source 那个字段)也都得有说法
    for (const source of ["llm", "validator", "engine", "broker"]) {
      expect(labels.REJECT_SOURCE_LABEL[source], source).toBeTruthy();
    }
  });

  it("卡片标题走词表,不再把 code 直接拼进去", () => {
    const page = read("pages", "Trade.tsx");
    expect(page).toContain("REJECT_CODE_LABEL");
    expect(page).not.toMatch(/title=\{`\$\{[A-Za-z_.[\]]+\} · \$\{r\.code\}`\}/);
  });

  it("拒绝信息与闸门原因里不出现配置键名(黄金基线就是真实文案)", () => {
    const baselines = ["baseline/golden/validator.json", "baseline/rpc/expected.json"];
    for (const file of baselines) {
      // 基线里既有请求里的配置(policies.allow_live_trading: false,那是配置本身,该留),
      // 也有回给界面的文案;只看 message 字段
      const messages = [...readEngine(file).matchAll(/"message": "([^"]*)"/g)].map((m) => m[1]!);
      expect(messages.length, file).toBeGreaterThan(0);
      for (const message of messages) {
        for (const key of CONFIG_KEYS) expect(message, `${file}: ${message}`).not.toContain(key);
      }
    }
    for (const blocker of [BLOCK_AUTO_EXECUTE, BLOCK_LIVE]) {
      for (const key of CONFIG_KEYS) expect(blocker).not.toContain(key);
    }
  });

  it("勾了实盘却没允许实盘下单:按下解析之前就说,不花一次模型调用换一张拒绝卡片", () => {
    const page = read("pages", "Trade.tsx");
    expect(page).toMatch(/status && !status\.allow_live_trading/);
    expect(page).toContain("liveBlocked");
    expect(page).toContain("没有允许实盘下单");
  });
});
