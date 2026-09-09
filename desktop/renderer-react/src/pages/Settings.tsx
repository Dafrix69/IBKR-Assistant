import { useCallback, useEffect, useState } from 'react';
import { Button, Segmented } from 'antd';
import { dafri, errorMessage, type Settings } from '../bridge';
import { showBanner } from '../store/banner';
import { brokerShortName, refreshStatus, useStatus } from '../store/status';
import { applyTheme, applyUpDown, useThemeMode, useUpDown, type ThemeMode, type UpDown } from '../theme/appearance';
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
}

function toForm(s: Settings): Form {
  // 少一个字段就整页崩掉、只留一句 JS 报错,不是可交付的失败方式:缺什么就空着那一格,其余照常可用
  const p = s.policies || {};
  const l = s.limits || {};
  return {
    autoExecute: Boolean(p.auto_execute),
    allowLive: Boolean(p.allow_live_trading),
    triggerVerify: Boolean(p.require_trigger_price_verification),
    notional: l.max_order_notional ?? null,
    contracts: l.max_option_contracts ?? null,
    mktShares: l.max_mkt_shares ?? null,
    slippage: l.max_spread_slippage ?? null,
    dupe: l.duplicate_window_minutes ?? null,
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
      <div className="seg-row">
        <Segmented options={THEME_OPTIONS} value={themeMode} onChange={(v) => void applyTheme(v as ThemeMode)} />
      </div>
      <Group>
        <GroupRow label="涨跌配色" sub="K 线、行情带、盈亏数字统一跟随;默认美股习惯">
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
            <SwitchRow label="允许自动执行" sub="关闭时只解析校验,永不发单" checked={form.autoExecute} onChange={(v) => patch({ autoExecute: v })} />
            <SwitchRow label="允许实盘账户下单" sub="默认关闭,纸面账户不受此限" checked={form.allowLive} onChange={(v) => patch({ allowLive: v })} />
            <SwitchRow label="触发方向必须有现价" sub="拿不到现价就拒绝条件单" checked={form.triggerVerify} onChange={(v) => patch({ triggerVerify: v })} />
          </Group>

          <SectionTitle>风控限额</SectionTitle>
          <Group>
            <NumberRow label="单笔名义金额上限" sub="USD" min={0} step={100} value={form.notional} onChange={(v) => patch({ notional: v })} />
            <NumberRow label="期权 / 价差单笔上限" sub="张" min={1} step={1} value={form.contracts} onChange={(v) => patch({ contracts: v })} />
            <NumberRow label="市价单股数上限" sub="无法估价时" min={1} step={10} value={form.mktShares} onChange={(v) => patch({ mktShares: v })} />
            <NumberRow label="AUTO_MID 滑点上限" sub="美元 / 张" min={0} step={0.01} value={form.slippage} onChange={(v) => patch({ slippage: v })} />
            <NumberRow label="重复防抖窗口" sub="分钟" min={0} step={1} value={form.dupe} onChange={(v) => patch({ dupe: v })} />
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
