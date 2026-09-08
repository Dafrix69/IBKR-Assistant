/** 黄金对拍:prompts(指纹 / 渲染 / 账号泄漏自检)。
 * 读取仓库根 prompts/ 下与 Python 完全同一份提示词资产。 */
import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { etNowFromEpoch } from "../src/config.js";
import {
  PromptError, fingerprint, loadPromptBundle, renderUser,
} from "../src/prompts.js";
import { parseSchemaForPrompt } from "../src/providers.js";
import { loadGolden, makeSettings } from "./util.js";

const sha256 = (text: string): string =>
  crypto.createHash("sha256").update(text, "utf-8").digest("hex");

describe("golden: prompts", () => {
  const g = loadGolden("prompts");
  const now = etNowFromEpoch(Date.parse(g.now));

  for (const entry of g.versions) {
    it(`version ${entry.version}`, () => {
      const settings = makeSettings(g.base_config, { prompt_version: entry.version });
      const bundle = loadPromptBundle(settings);
      expect(bundle.fewshot.length).toBe(entry.fewshot_count);
      expect(bundle.system_text.length).toBe(entry.system_len);
      expect(sha256(bundle.system_text)).toBe(entry.system_sha256);
      expect(fingerprint(bundle)).toBe(entry.fingerprint);
      const userText = renderUser(bundle, settings, "买入 AAPL 100股 limit 230", now, null, {
        AAPL: 229.4, SPX: 7462.35,
      });
      expect(userText.length).toBe(entry.user_len);
      expect(sha256(userText)).toBe(entry.user_sha256);
      // 发给模型的 rejection 代码表随提示词版本走(v1.8.0 起不列 EXCEEDS_LIMIT)
      const defs = parseSchemaForPrompt(entry.version)["$defs"] as Record<string, any>;
      expect(defs["Rejection"]["properties"]["code"]["enum"]).toEqual(entry.rejection_codes_sent);
    });
  }

  it("指纹只随模型看到的东西变:v1.8.0 起改限额不换指纹,v1.7.0 照旧随限额变", () => {
    const tighter = { limits: { max_order_notional: 999.0 } };
    const a = fingerprint(loadPromptBundle(makeSettings(g.base_config)));
    const b = fingerprint(loadPromptBundle(makeSettings(g.base_config, tighter)));
    expect(a).toBe(b);
    const legacy = fingerprint(loadPromptBundle(makeSettings(g.base_config, { prompt_version: "v1.7.0" })));
    const legacyTighter = fingerprint(
      loadPromptBundle(makeSettings(g.base_config, { prompt_version: "v1.7.0", ...tighter })),
    );
    expect(legacy).not.toBe(legacyTighter);
  });

  it("sample user text byte-for-byte", () => {
    const settings = makeSettings(g.base_config);
    const bundle = loadPromptBundle(settings);
    const text = renderUser(bundle, settings, "买入 AAPL 100股 limit 230", now, null, g.sample_snapshot);
    expect(text).toBe(g.sample_user_text);
  });

  it("account leak check", () => {
    const settings = makeSettings(g.base_config);
    const bundle = loadPromptBundle(settings);
    expect(() => renderUser(bundle, settings, g.leak_check.instruction, now)).toThrowError(
      PromptError,
    );
    try {
      renderUser(bundle, settings, g.leak_check.instruction, now);
    } catch (exc) {
      expect((exc as Error).message).toBe(g.leak_check.error);
    }
  });
});
