/**
 * 价位穿越怎么才算数。判定全在引擎(alerts.ts 的状态机),这里只是一个开关:
 * 关 = 两次取价之间跨过就报(一直以来的做法);开 = 跨过之后等那一分钟走完,收在价位另一侧才报。
 * 等的是「1 分钟收盘」这条规则,没有可调的秒数。
 */
import type { CrossConfirm } from '../bridge';
import { saveCrossConfirm } from '../store/alerts';
import { Group, SwitchRow } from '../ui/kit';

export function CrossConfirmSetting({ mode }: { mode: CrossConfirm }) {
  return (
    <Group
      className="cross-confirm"
      hint="开着时提醒会晚几十秒(等那一分钟走完),换来的是不报收回去的假突破。反复碰均线不受这个开关影响。"
    >
      <SwitchRow
        key="bar-close"
        label="穿越要等 1 分钟收盘确认"
        sub="关:两次取价(10 秒一次)之间跨过价位就报。开:跨过的那一分钟收完,最后一笔价还在价位另一侧才报"
        checked={mode === 'bar_close'}
        onChange={(v) => void saveCrossConfirm(v ? 'bar_close' : 'immediate')}
      />
    </Group>
  );
}
