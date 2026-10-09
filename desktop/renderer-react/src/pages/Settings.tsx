import { useCallback, useEffect, useState } from 'react';
import { Button, Segmented, Slider } from 'antd';
import { dafri, errorMessage, type Settings } from '../bridge';
import { showBanner } from '../store/banner';
import { refreshStatus } from '../store/status';
import { applyGlassTint, applyTheme, applyUpDown, useGlassTint, useThemeMode, useUpDown, type ThemeMode, type UpDown } from '../store/appearance';
import { AccountLimitsRows } from '../lib/AccountLimitsRows';
import { DataPanel } from '../lib/DataPanel';
import { formProblems, isDirty, toForm, toPatch, type SettingsForm } from '../lib/settingsForm';
import { Group, GroupRow, LoadingBlock, Notice, NumberRow, PageHead, SectionTitle, SwitchRow } from '../ui/kit';

const THEME_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: '跟随系统', value: 'system' },
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
];
const COOL_SCOPE_OPTIONS = [{ label: '这只标的', value: 'symbol' }, { label: '同一个结构', value: 'position' }];
const DAILY_BASIS_OPTIONS = [{ label: '已实现盈亏', value: 'realized' }, { label: '账户当日盈亏', value: 'account' }];
const UPDOWN_OPTIONS: { label: string; value: UpDown }[] = [
  { label: '绿涨红跌', value: 'green-up' },
  { label: '红涨绿跌', value: 'red-up' },
];

export function SettingsPage() {
  const themeMode = useThemeMode();
  const updown = useUpDown();
  const glass = useGlassTint();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [saving, setSaving] = useState(false);
  // 点过一次保存之后才把问题清单摆出来:一进页面就是一排红字,谁也不想看
  const [checked, setChecked] = useState(false);

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

  const patch = (part: Partial<SettingsForm>) => setForm((f) => (f ? { ...f, ...part } : f));
  const problems = form ? formProblems(form) : [];
  const dirty = form ? isDirty(form, saved) : false;

  /**
   * 两个执行闸门:**关**是当场生效的,不等「保存设置」。以前关掉开关之后要滚到页面最底下点保存才算数,
   * 中途切走页面,这次修改就丢了——人以为自动执行已经关了,其实还开着。开则照旧跟着保存走(要确认)。
   */
  async function setGate(key: 'autoExecute' | 'allowLive', policy: 'auto_execute' | 'allow_live_trading', on: boolean) {
    patch({ [key]: on });
    if (on || !saved?.policies?.[policy]) return;
    try {
      const next = await dafri.patchSettings({ policies: { [policy]: false } });
      setSaved(next);
      showBanner(policy === 'auto_execute' ? '已关闭自动执行,当场生效。' : '已关闭实盘账户下单,当场生效。', true);
      await refreshStatus();
    } catch (err) {
      patch({ [key]: true });
      showBanner(`没有关掉:${errorMessage(err)}`, false);
    }
  }

  async function save() {
    if (!form) return;
    setChecked(true);
    if (problems.length) {
      showBanner(`还不能保存:${problems[0]}${problems.length > 1 ? `(另有 ${problems.length - 1} 处)` : ''}`, false);
      return;
    }
    // 打开闸门、放宽限额都要在主进程的确认框里点过确认(desktop/confirm-grants.js):框上的话由主进程写,
    // 限额从多少改到多少也由它对着引擎现在的设置算。没有这一步,后面的 patchSettings 会被拒
    if (form.autoExecute && !saved?.policies?.auto_execute) {
      const ok = await dafri.confirm({ purpose: 'gate.auto_execute', title: '打开自动执行', message: '', confirmLabel: '我明白,打开' });
      if (!ok) return patch({ autoExecute: false });
    }
    if (form.allowLive && !saved?.policies?.allow_live_trading) {
      const ok = await dafri.confirm({ purpose: 'gate.allow_live_trading', title: '允许实盘下单', message: '', confirmLabel: '我明白,打开实盘' });
      if (!ok) return patch({ allowLive: false });
    }
    const next = toPatch(form, saved);
    const ok = await dafri.confirm({ purpose: 'limits.loosen', binding: { limits: next.limits ?? {} }, title: '放宽风控限额', message: '', confirmLabel: '我明白,放宽' });
    if (!ok) return;
    setSaving(true);
    try {
      await dafri.patchSettings(next);
      showBanner('设置已保存,提示词与限额已同步更新。', true);
      setChecked(false);
      await Promise.all([load(), refreshStatus()]);
    } catch (err) {
      showBanner(`保存失败(配置未改动):${errorMessage(err)}`, false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="tab-panel active" id="page-settings">
      <PageHead
        title="设置"
        extra={dirty ? (
          <span className="unsaved">
            <span className="muted">有未保存的修改</span>
            <Button size="small" type="primary" onClick={() => void save()} loading={saving}>
              保存设置
            </Button>
          </span>
        ) : undefined}
      />

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
            <SwitchRow icon="sf-bolt" tint="orange" label="允许自动执行" sub="关闭时只解析校验,永不发单。关是当场生效的,开要点保存" checked={form.autoExecute} onChange={(v) => void setGate('autoExecute', 'auto_execute', v)} />
            <SwitchRow icon="sf-dollar" tint="red" label="允许实盘账户下单" sub="默认关闭,纸面账户不受此限。关是当场生效的,开要点保存" checked={form.allowLive} onChange={(v) => void setGate('allowLive', 'allow_live_trading', v)} />
            <SwitchRow icon="sf-shield" tint="blue" label="触发方向必须有现价" sub="拿不到现价就拒绝条件单" checked={form.triggerVerify} onChange={(v) => patch({ triggerVerify: v })} />
          </Group>

          <SectionTitle>风控限额</SectionTitle>
          <Group>
            <NumberRow icon="sf-dollar" tint="green" label="单笔名义金额上限" sub="USD" min={0} step={100} value={form.notional} onChange={(v) => patch({ notional: v })} />
            <NumberRow icon="sf-layers" tint="purple" label="期权 / 价差单笔上限" sub="张" min={1} step={1} value={form.contracts} onChange={(v) => patch({ contracts: v })} />
            <NumberRow icon="sf-gauge" tint="orange" label="市价单股数上限" sub="无法估价时" min={1} step={10} value={form.mktShares} onChange={(v) => patch({ mktShares: v })} />
            <NumberRow icon="sf-scan" tint="teal" label="AUTO_MID 滑点上限" sub="美元 / 张" min={0} step={0.01} value={form.slippage} onChange={(v) => patch({ slippage: v })} />
            <NumberRow icon="sf-scan" tint="teal" label="AUTO_MID 按价差让价" sub="%:中间价到立刻成交价那一段让多少。空着 = 不用它,照上面的固定滑点" min={0} max={100} step={5} placeholder="不用" value={form.midShare} onChange={(v) => patch({ midShare: v })} />
            <NumberRow icon="sf-clock" tint="gray" label="重复防抖窗口" sub="分钟" min={0} step={1} value={form.dupe} onChange={(v) => patch({ dupe: v })} />
            <NumberRow icon="sf-shield" tint="red" label="在手期权的最坏亏损上限" sub="USD,每个账户各算:在手的 + 这一单超过就拒;平仓不拦。空着 = 不设" min={0} step={100} placeholder="不设" value={form.openRisk} onChange={(v) => patch({ openRisk: v })} />
            <NumberRow icon="sf-layers" tint="purple" label="同标的同到期的张数上限" sub="张,组合按组数:在手的 + 这一单超过就拒。空着 = 不设" min={0} step={1} placeholder="不设" value={form.underlying} onChange={(v) => patch({ underlying: v })} />
          </Group>
          {Object.keys(form.byAccount).length > 1 ? (
            <Group hint="只填要和上面不一样的那几项,空着的用上面的;往松了改同样要确认。">
              <AccountLimitsRows
                value={form.byAccount}
                paper={Object.fromEntries((saved?.accounts ?? []).map((a) => [a.alias, a.is_paper]))}
                onChange={(byAccount) => patch({ byAccount })}
              />
            </Group>
          ) : null}

          <SectionTitle>保护规则</SectionTitle>
          <p className="hint">
            比熔断细一档:接连止损、盈亏回撤过大、当天亏到上限、同一只刚平过仓,就先停一会儿自动执行。到点自己解除,不用人工。
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
              <>
                <NumberRow icon="sf-clock" tint="gray" label="冷却多久" sub="分钟" min={1} step={5} value={form.coolMinutes} onChange={(v) => patch({ coolMinutes: v })} />
                <GroupRow icon="sf-layers" tint="teal" label="冷却挡什么" sub="只做一个标的的人选「同一个结构」:只挡和刚平掉的那份持仓同到期、同行权价的单,别的照发">
                  <Segmented size="small" options={COOL_SCOPE_OPTIONS} value={form.coolScope} onChange={(v) => patch({ coolScope: v === 'position' ? 'position' : 'symbol' })} />
                </GroupRow>
              </>
            ) : null}
            <SwitchRow icon="sf-gauge" tint="red" label="日内亏损上限" sub="当天(美东)净亏到线,当天不再下新单;第二天零点自己解除" checked={form.dailyOn} onChange={(v) => patch({ dailyOn: v })} />
            {form.dailyOn ? (
              <>
                <NumberRow icon="sf-dollar" tint="red" label="当天最多亏" sub="USD,盈亏以券商报的为准" min={0} step={100} value={form.dailyUsd} onChange={(v) => patch({ dailyUsd: v })} />
                <GroupRow icon="sf-gauge" tint="red" label="拿什么算" sub="已实现盈亏:只数软件发的单、平了才算。账户当日盈亏:券商报的,含没平的浮亏和在 TWS 里手动做的单,每个账户各算各的(只认美元账户;券商没报时退回已实现盈亏)">
                  <Segmented size="small" options={DAILY_BASIS_OPTIONS} value={form.dailyBasis} onChange={(v) => patch({ dailyBasis: v === 'account' ? 'account' : 'realized' })} />
                </GroupRow>
              </>
            ) : null}
          </Group>

          <SectionTitle>单笔风险预算</SectionTitle>
          <Group hint="一单占账户权益太多时,在订单卡片上多一句提醒;只提醒,不拦单,平仓单不受影响。权益填了就用填的;空着的 IBKR 美元账户用券商报的净值。">
            <SwitchRow icon="sf-gauge" tint="orange" label="按账户权益提醒" sub="期权 / 组合看最坏亏损,股票看名义金额" checked={form.rbOn} onChange={(v) => patch({ rbOn: v })} />
            {form.rbOn ? (
              <>
                <NumberRow icon="sf-xmark" tint="red" label="期权 / 组合最坏亏损" sub="占权益 %,冠军们多在 0.5–2" min={0.1} max={100} step={0.5} value={form.rbRisk} onChange={(v) => patch({ rbRisk: v })} />
                <NumberRow icon="sf-layers" tint="purple" label="股票仓位" sub="名义金额占权益 %" min={0.1} max={1000} step={5} value={form.rbPosition} onChange={(v) => patch({ rbPosition: v })} />
                {Object.keys(form.rbEquity).map((alias) => (
                  <NumberRow key={alias} icon="sf-dollar" tint="green" label={`${alias} 的权益`} sub="USD,空着 = 用券商报的净值(拿不到就不提醒)" min={0} step={1000}
                    value={form.rbEquity[alias] ?? null} onChange={(v) => patch({ rbEquity: { ...form.rbEquity, [alias]: v } })} />
                ))}
              </>
            ) : null}
          </Group>

          {checked && problems.length ? (
            <Notice tone="warn" title="还不能保存">
              <ul className="hint-list">
                {problems.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <Button type="primary" onClick={() => void save()} loading={saving}>
            保存设置
          </Button>
          <p className="hint">
            账户在「接入 → 账户」里配。连接(端口、client id)只能手动编辑配置文件,改完重启交易引擎生效。{' '}
            <Button size="small" type="link" onClick={() => void dafri.reveal('config').catch((err) => showBanner(errorMessage(err), false))}>
              打开配置文件所在位置
            </Button>
          </p>
        </>
      )}

      <SectionTitle>数据与备份</SectionTitle>
      <DataPanel />
    </section>
  );
}
