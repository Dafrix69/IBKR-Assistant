/** 阶段 6 验收:RPC 契约回放。
 *
 * 固定时钟、假 LLM、无券商连接下的 76 步请求序列(baseline/rpc/,最初由已退役的 Python 参考实现
 * 生成,现在是本引擎的契约快照)。这里用 RpcServer 回放同一序列,归一化后逐条对拍
 * ——方法表、参数校验、错误码、错误文案、返回形状全部一致,
 * 现有 Electron renderer 才能一行不改地对接。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { setClock } from "../src/config.js";
import type { PromptBundle } from "../src/prompts.js";
import { fingerprint } from "../src/prompts.js";
import { LLMResponse } from "../src/providers.js";
import { RpcServer } from "../src/rpc.js";
import { expectSame, loadGoldenFile } from "./util.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RPC_DIR = path.resolve(HERE, "..", "baseline", "rpc");

const baseConfig = JSON.parse(fs.readFileSync(path.join(RPC_DIR, "base_config.json"), "utf-8"));
const requests: Array<Record<string, any>> = JSON.parse(
  fs.readFileSync(path.join(RPC_DIR, "requests.json"), "utf-8"),
);
const expected: Array<Record<string, any>> = loadGoldenFile(path.join(RPC_DIR, "expected.json"));

// ---------------------------------------------------------------- 假解析器(与 Python 生成器镜像)
const FAKE_PARSE_PAYLOAD = {
  orders: [
    {
      intent_summary: "限价 230 买入 100 股 AAPL",
      contract: { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" },
      execution_type: "IMMEDIATE",
      trigger: null,
      account: "DEFAULT",
      order: {
        action: "BUY", orderType: "LMT", totalQuantity: 100,
        price_mode: "EXPLICIT", lmtPrice: 230.0, tif: "DAY", outsideRth: false,
      },
      reason: "回调到位",
      confidence: 0.99,
      warnings: [],
    },
  ],
  rejections: [
    { original_text: "顺便梭哈", code: "UNCLEAR", message: "「梭哈」没有明确数量与标的,拒绝。" },
  ],
};

const FAKE_JSON_BY_SCHEMA: Record<string, Record<string, unknown>> = {
  stocks: {
    stocks: [
      { symbol: "NVDA", company: "英伟达", reason: "AI 芯片份额第一", tag: "芯片" },
      { symbol: "AMD", company: "AMD", reason: "数据中心第二供应商", tag: "芯片" },
    ],
  },
  entry: {
    entry: [
      {
        left: { kind: "indicator", name: "macd_hist" },
        op: "cross_up",
        right: { kind: "const", value: 0.0 },
      },
    ],
    exit: [],
  },
  // "themes" 是 IdeaDigest 独有的键,必须排在 "summary" 前:两个 schema 都有 summary
  themes: {
    summary: "偏好半导体尾盘动量,想法多带明确价位",
    themes: ["半导体(2 条)"],
    lessons: ["想法带价位条件的更可执行"],
    patterns: ["具体价位 + 条件的想法质量高"],
    actions: ["把尾盘动量写成可回测的规则"],
  },
  summary: {
    summary: "回调加仓想法与当前动能匹配度一般",
    thesis: "需要价格站回均线之上",
    checks: ["财报日期"],
    risks: ["波动率偏高"],
    suggestion: "等回调到锚点再考虑",
  },
  reading: { summary: "结构偏多", reading: "高点抬高。", watch: ["盯 450"], risks: ["假突破"] },
};

class FakeParser {
  async parse(bundle: PromptBundle, _userMessage: string): Promise<LLMResponse> {
    return new LLMResponse(
      JSON.stringify(FAKE_PARSE_PAYLOAD),
      "fake-model",
      bundle.version,
      fingerprint(bundle),
      5,
      { input_tokens: 100, output_tokens: 50 },
    );
  }

  async completeJson(
    _system: string, _user: string, schema: Record<string, any>,
  ): Promise<Record<string, unknown>> {
    const props = new Set(Object.keys(schema["properties"] ?? {}));
    for (const [marker, payload] of Object.entries(FAKE_JSON_BY_SCHEMA)) {
      if (props.has(marker)) return structuredClone(payload);
    }
    throw new Error(`没有匹配的假响应:${[...props].sort().join(",")}`);
  }
}

// ---------------------------------------------------------------- 归一化(与 Python 生成器镜像)
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const PATH_RE = /^([A-Za-z]:[\\/]|\/)/;

const MASK_KEYS = new Set([
  "latency_ms", "port_latency_ms", "now_et", "at", "analyzed_at", "fetched_at",
  "created_at", "updated_at", "exported_at", "fired_at", "last_fired_at",
  "raw_response", "path", "config", "unlock_password_saved", "key_configured",
]);
const DROP_KEYS = new Set(["ports", "apps", "connected", "sdk_installed", "running", "installed"]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (MASK_KEYS.has(key)) out[key] = "<VAR>";
      else if (DROP_KEYS.has(key)) out[key] = "<MACHINE>";
      else out[key] = normalize(item);
    }
    return out;
  }
  if (typeof value === "string") {
    const masked = value.replace(UUID_RE, "<ID>"); // 错误文案里也可能内嵌 uuid
    if (masked === "<ID>") return masked;
    if (ISO_RE.test(masked)) return "<TS>";
    if (PATH_RE.test(masked) && (masked.includes("\\") || masked.includes("/"))) return "<PATH>";
    return masked;
  }
  return value;
}

function getPath(obj: unknown, dotted: string): unknown {
  let cur: any = obj;
  for (const part of dotted.split(".")) {
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else cur = (cur ?? {})[part];
  }
  return cur;
}

function substitute(value: unknown, variables: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((v) => substitute(v, variables));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v, variables)]),
    );
  }
  if (typeof value === "string" && value.startsWith("$")) {
    return variables[value.slice(1)] ?? value;
  }
  return value;
}

// ---------------------------------------------------------------- 回放
describe("golden: RPC 契约回放(76 步)", () => {
  let dir: string;
  let server: RpcServer;
  const variables: Record<string, unknown> = {};

  beforeAll(() => {
    setClock(Date.parse("2026-08-14T10:32:00-04:00")); // 与 Python 生成器同一时刻(盘中)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-rpc-"));
    const config = structuredClone(baseConfig);
    config["storage"] = { db_path: path.join(dir, "trades.db") };
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2), "utf-8");
    server = new RpcServer(settingsPath, () => undefined); // 事件通知丢弃,契约只看响应
    server.parserFactory = () => new FakeParser();
    variables["EXPORT_PATH"] = path.join(dir, "export.json");
  });
  afterAll(() => {
    setClock(null);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能仍占着 */
    }
  });

  requests.forEach((step, i) => {
    it(`${String(i).padStart(2, "0")} ${step["method"]}`, async () => {
      const params = substitute(structuredClone(step["params"]), variables);
      const response = await server.handle({
        jsonrpc: "2.0", id: i, method: step["method"], params,
      });
      for (const [name, capturePath] of Object.entries(step["capture"] ?? {})) {
        variables[name] = getPath({ result: response["result"] }, String(capturePath));
      }
      const normalized = normalize(
        Object.fromEntries(
          Object.entries(response).filter(([k]) => k === "result" || k === "error"),
        ),
      );
      expectSame(normalized, expected[i], `${step["method"]}[${i}]`);
    });
  });
});
