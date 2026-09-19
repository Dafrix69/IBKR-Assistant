import { useCallback, useEffect, useState } from 'react';
import { Button, Segmented, Slider } from 'antd';
import { dafri, errorMessage, type Settings, type SettingsProtections } from '../bridge';
import { showBanner } from '../store/banner';
import { brokerShortName, refreshStatus, useStatus } from '../store/status';
import { applyGlassTint, applyTheme, applyUpDown, useGlassTint, useThemeMode, useUpDown, type ThemeMode, type UpDown } from '../store/appearance';
import { Group, GroupRow, LoadingBlock, NumberRow, PageHead, SectionTitle, SwitchRow } from '../ui/kit';

interface Form {
  autoExecute: boolean;
  allowLive: boolean;
  triggerVerify: boolean;
  notional: number | null;
  contracts: number | null;
  mktShares: number | null;
  slippage: number | null;
  dupe: number | null;
  // 保护规则(见 engine-ts/src/protections.ts)。默认全关,老配置升级上来行为不变。
  slGuard: boolean;
  slLookback: number | null;
  slCount: number | null;
  slPause: number | null;
  ddGuard: boolean;
  ddLookback: number | null;
  ddUsd: number | null;
  ddPause: number | null;
  coolOn: boolean;
  coolMinutes: number | null;
}

function toForm(s: Settings): Form {
  // 少一个字段就整页崩掉、只留一句 JS 报错,不是可交付的失败方式:缺什么就空着那一格,其余照常可用
  const p = s.policies || {};
  const l = s.limits || {};
  const pr: Partial<SettingsProtections> = s.protections || {};
  const sg: Partial<SettingsProtections['stoploss_guard']> = pr.stoploss_guard || {};
  const dd: Partial<SettingsProtections['max_drawdown']> = pr.max_drawdown || {};
  const cd: Partial<SettingsProtections['cooldown']> = pr.cooldown || {};
  return {
    autoExecute: Boolean(p.auto_execute),
    allowLive: Boolean(p.allow_live_trading),
    triggerVerify: Boolean(p.require_trigger_price_verification),
    notional: l.max_order_notional ?? null,
    contracts: l.max_option_contracts ?? null,
    mktShares: l.max_mkt_shares ?? null,
    slippage: l.max_spread_slippage ?? null,
    dupe: l.duplicate_window_minutes ?? null,
    slGuard: Boolean(sg.enabled),
    slLookback: sg.lookback_minutes ?? null,
    slCount: sg.trigger_count ?? null,
    slPause: sg.pause_minutes ?? null,
    ddGuard: Boolean(dd.enabled),
    ddLookback: dd.lookback_minutes ?? null,
    ddUsd: dd.max_drawdown_usd ?? null,
    ddPause: dd.pause_minutes ?? null,
    coolOn: Boolean(cd.enabled),
    coolMinutes: cd.minutes ?? null,
  };
}

const THEME_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: '跟随系统', value: 'system' },
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
];
const UPDOWN_OPTIONS: { label: string; value: UpDown }[] = [
  { label: '绿涨红跌', value: 'green-up' },
  { label: '红涨绿跌', value: 'red-up' },
];

export function SettingsPage() {
  const themeMode = useThemeMode();
  const updown = useUpDown();
  const glass = useGlassTint();
  const status = useStatus();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await dafri.getSettings();
      setSaved(s);
      setForm(toForm(s));
    } catch (err) {
      showBanner(`读取设置失败:${errorMessage(err)}`, false);
    }
  }, []);

  useEffect(() => {
    void load();
    return dafri.on('engine-event', ({ event }) => {
      if (event === 'settings') void load();
    });
  }, [load]);

  const patch = (part: Partial<Form>) => setForm((f) => (f ? { ...f, ...part } : f));

  async function save() {
    if (!form) return;
    if (form.autoExecute && !saved?.policies?.auto_execute) {
      const ok = await dafri.confirm({
        title: '打开自动执行',
        message: `打开后,解析通过的订单会被直接发送到${brokerShortName(status)},没有人工确认环节。`,
        detail: '建议先在纸面账户跑够回归测试再打开。',
        confirmLabel: '我明白,打开',
      });
      if (!ok) return patch({ autoExecute: false });
    }
    if (form.allowLive && !saved?.policies?.allow_live_trading) {
      const ok = await dafri.confirm({
        title: '允许实盘下单',
        message: '打开后,指向实盘账户的订单将不再被拦截,会用真钱成交。',
        confirmLabel: '我明白,打开实盘',
      });
      if (!ok) return patch({ allowLive: false });
    }
    setSaving(true);
    try {
      await dafri.patchSettings({
        policies: {
          auto_execute: form.autoExecute,
          allow_live_trading: form.allowLive,
          require_trigger_price_verification: form.triggerVerify,
        },
        limits: {
          max_order_notional: Number(form.notional),
          max_option_contracts: Number(form.contracts),
          max_mkt_shares: Number(form.mktShares),
          max_spread_slippage: Number(form.slippage),
          duplicate_window_minutes: Number(form.dupe),
        },
        protections: {
          stoploss_guard: {
            enabled: form.slGuard, lookback_minutes: Number(form.slLookback),
            trigger_count: Number(form.slCount), pause_minutes: Number(form.slPause),
          },
          max_drawdown: {
            enabled: form.ddGuard, lookback_minutes: Number(form.ddLookback),
            max_drawdown_usd: Number(form.ddUsd), pause_minutes: Number(form.ddPause),
          },
          cooldown: { enabled: form.coolOn, minutes: Number(form.coolMinutes) },
        },
      });
      showBanner('设置已保存,提示词与限额已同步更新。', true);
      await Promise.all([load(), refreshStatus()]);
    } catch (err) {
      showBanner(`保存失败(配置未改动):${errorMessage(err)}`, false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="tab-panel active" id="page-settings">
      <PageHead title="设置" />

      <SectionTitle>外观</SectionTitle>
      <Group>
        <GroupRow icon="sf-sun" tint="indigo" label="深浅色" sub="跟随系统,或固定一种">
          <Segmented size="small" options={THEME_OPTIONS} value={themeMode} onChange={(v) => void applyTheme(v as ThemeMode)} />
        </GroupRow>
        <GroupRow icon="sf-drop" tint="teal" label="Liquid Glass" sub="侧栏、工具栏这些玻璃面有多透:左边通透,右边着色(更好读)">
          <span className="glass-slider">
            <span className="glass-swatch clear" aria-hidden="true" />
            <Slider min={0} max={100} step={5} value={Math.round(glass * 100)} onChange={(v) => applyGlassTint(Number(v) / 100)} tooltip={{ open: false }} />
            <span className="glass-swatch tinted" aria-hidden="true" />
          </span>
        </GroupRow>
        <GroupRow icon="sf-updown" tint="green" label="涨跌配色" sub="K 线、行情带、盈亏数字统一跟随;默认美股习惯">
          <Segmented size="small" options={UPDOWN_OPTIONS} value={updown} onChange={(v) => applyUpDown(v as UpDown)} />
        </GroupRow>
      </Group>

      {/* 数据到位前不画控件:先画一排禁用的开关再翻成启用,会闪一下,截图台里过渡还会停在禁用态 */}
      {!form ? (
        <LoadingBlock rows={4} />
      ) : (
        <>
          <SectionTitle>执行闸门</SectionTitle>
          <Group>
            <SwitchRow icon="sf-bolt" tint="orange" label="允许自动执行" sub="关闭时只解析校验,永不发单" checked={form.autoExecute} onChange={(v) => patch({ autoExecute: v })} />
            <SwitchRow icon="sf-dollar" tint="red" label="允许实盘账户下单" sub="默认关闭,纸面账户不受此限" checked={form.allowLive} onChange={(v) => patch({ allowLive: v })} />
            <SwitchRow icon="sf-shield" tint="blue" label="触发方向必须有现价" sub="拿不到现价就拒绝条件单" checked={form.triggerVerify} onChange={(v) => patch({ triggerVerify: v })} />
          </Group>

          <SectionTitle>风控限额</SectionTitle>
          <Group>
            <NumberRow icon="sf-dollar" tint="green" label="单笔名义金额上限" sub="USD" min={0} step={100} value={form.notional} onChange={(v) => patch({ notional: v })} />
            <NumberRow icon="sf-layers" tint="purple" label="期权 / 价差单笔上限" sub="张" min={1} step={1} value={form.contracts} onChange={(v) => patch({ contracts: v })} />
            <NumberRow icon="sf-gauge" tint="orange" label="市价单股数上限" sub="无法估价时" min={1} step={10} value={form.mktShares} onChange={(v) => patch({ mktShares: v })} />
            <NumberRow icon="sf-scan" tint="teal" label="AUTO_MID 滑点上限" sub="美元 / 张" min={0} step={0.01} value={form.slippage} onChange={(v) => patch({ slippage: v })} />
            <NumberRow icon="sf-clock" tint="gray" label="重复防抖窗口" sub="分钟" min={0} step={1} value={form.dupe} onChange={(v) => patch({ dupe: v })} />
          </Group>

          <SectionTitle>保护规则</SectionTitle>
          <p className="hint">
            比熔断细一档:接连止损、盈亏回撤过大、同一只刚平过仓,就先停一会儿自动执行。到点自己解除,不用人工。
            <b>只挡新单,永远不挡平仓。</b>被挡下的单停在「仅校验未发送」,保护期过了还能再发。
          </p>
          <Group>
            <SwitchRow icon="sf-shield" tint="orange" label="止损护栏" sub="窗口内止损够次数就暂停自动执行" checked={form.slGuard} onChange={(v) => patch({ slGuard: v })} />
            {form.slGuard ? (
              <>
                <NumberRow icon="sf-clock" tint="gray" label="往回看" sub="分钟" min={1} step={10} value={form.slLookback} onChange={(v) => patch({ slLookback: v })} />
                <NumberRow icon="sf-xmark" tint="red" label="几次止损算数" sub="次" min={1} step={1} value={form.slCount} onChange={(v) => patch({ slCount: v })} />
                <NumberRow icon="sf-hourglass" tint="orange" label="暂停多久" sub="分钟,从最后一次止损算起" min={1} step={10} value={form.slPause} onChange={(v) => patch({ slPause: v })} />
              </>
            ) : null}
            <SwitchRow icon="sf-arrow-down" tint="red" label="回撤护栏" sub="已实现盈亏从峰值回落够多就暂停" checked={form.ddGuard} onChange={(v) => patch({ ddGuard: v })} />
            {form.ddGuard ? (
              <>
                <NumberRow icon="sf-clock" tint="gray" label="往回看" sub="分钟" min={1} step={60} value={form.ddLookback} onChange={(v) => patch({ ddLookback: v })} />
                <NumberRow icon="sf-dollar" tint="red" label="回撤阈值" sub="USD,盈亏以券商报的为准" min={0} step={100} value={form.ddUsd} onChange={(v) => patch({ ddUsd: v })} />
                <NumberRow icon="sf-hourglass" tint="orange" label="暂停多久" sub="分钟,从最低点算起" min={1} step={10} value={form.ddPause} onChange={(v) => patch({ ddPause: v })} />
              </>
            ) : null}
            <SwitchRow icon="sf-pulse" tint="teal" label="同标的冷却" sub="刚平过仓的标的,一段时间内不再下新单" checked={form.coolOn} onChange={(v) => patch({ coolOn: v })} />
            {form.coolOn ? (
              <NumberRow icon="sf-clock" tint="gray" label="冷却多久" sub="分钟" min={1} step={5} value={form.coolMinutes} onChange={(v) => patch({ coolMinutes: v })} />
            ) : null}
          </Group>

          <Button type="primary" onClick={() => void save()} loading={saving}>
            保存设置
          </Button>
          <p className="hint">
            账户别名与连接端口涉及真实账号,仅可手动编辑 <code>config/settings.json</code>。
          </p>
        </>
      )}
    </section>
  );
}
