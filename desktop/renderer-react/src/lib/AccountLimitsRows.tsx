/** 「设置 → 风控限额」里按账户覆盖的那几行:一个账户一行,四个小格子,空着 = 用全局的。
 *
 * 纸面账户与实盘账户不该被迫用同一套限额;覆盖的那几项由校验层按账户取(引擎 Settings.limitsFor)。
 * 往松了改和全局限额一样要过主进程的确认框(desktop/confirm-grants.js 的 loosenedLimits)。
 */
import { InputNumber } from 'antd';
import type { AccountLimitFields } from './settingsForm';
import { GroupRow } from '../ui/kit';

const FIELDS: Array<{ key: keyof AccountLimitFields; label: string; step: number; min: number }> = [
  { key: 'notional', label: '单笔金额', step: 100, min: 0 },
  { key: 'contracts', label: '单笔张数', step: 1, min: 1 },
  { key: 'openRisk', label: '在手风险', step: 100, min: 0 },
  { key: 'underlying', label: '同标的张数', step: 1, min: 0 },
];

export function AccountLimitsRows({
  value, paper, onChange,
}: {
  value: Record<string, AccountLimitFields>;
  /** 账户别名 → 是不是纸面账户(只用来在行上标一下) */
  paper: Record<string, boolean>;
  onChange: (next: Record<string, AccountLimitFields>) => void;
}) {
  return (
    <>
      {Object.entries(value).map(([alias, own]) => (
        <GroupRow key={alias} icon="sf-layers" tint={paper[alias] ? 'gray' : 'red'} label={alias} sub={paper[alias] ? '纸面账户' : '实盘账户'} className="account-limits-row">
          <span className="account-limits">
            {FIELDS.map((field) => (
              <label key={field.key}>
                <span className="muted">{field.label}</span>
                <InputNumber
                  size="small"
                  min={field.min}
                  step={field.step}
                  placeholder="同全局"
                  value={own[field.key]}
                  onChange={(v) => onChange({ ...value, [alias]: { ...own, [field.key]: v === null || v === undefined ? null : Number(v) } })}
                  aria-label={`${alias} ${field.label}`}
                />
              </label>
            ))}
          </span>
        </GroupRow>
      ))}
    </>
  );
}
