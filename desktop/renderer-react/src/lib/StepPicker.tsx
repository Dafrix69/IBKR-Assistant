/**
 * 一条盯单的整数关口步长(成分股行下面那一排小字里的第一项)。判定与分档都在引擎(alerts.ts 的 autoStep),这里只是选。
 */
import { Select, Tooltip } from 'antd';
import { refreshWatch, type Watch } from '../store/alerts';

/** 整数关口的步长可选的几档(引擎的阶梯 1 / 2.5 / 5 × 10ⁿ 里常用的那几个);盯单上存着别的数也列出来。 */
const STEP_CHOICES = [0.5, 1, 2.5, 5, 10, 25, 50, 100];

/**
 * 整数关口的步长:0 = 自动(引擎按现价分档),正数 = 一直用这个数——升级之前建的盯单存的是 5,不会自己变成自动。
 * 选完立刻按新步长重算这只的价位(到期日沿用盯单上记着的)。
 */
export function StepPicker({ watch, disabled }: { watch: Watch; disabled: boolean }) {
  const fixed = [...new Set([...STEP_CHOICES, watch.step])].filter((v) => v > 0).sort((a, b) => a - b);
  return (
    <Tooltip title="自动 = 按现价分档:1 / 2.5 / 5 × 10ⁿ 里不小于现价 0.6% 的最小一档(相邻两个关口各自 ±0.3% 的范围不叠)。选一个数就一直用它">
      <span className="step-picker">
        整数关口步长
        <Select
          size="small"
          variant="borderless"
          popupMatchSelectWidth={false}
          disabled={disabled}
          value={watch.step > 0 ? watch.step : 0}
          options={[{ value: 0, label: '自动' }, ...fixed.map((v) => ({ value: v, label: String(v) }))]}
          onChange={(v) => void refreshWatch(watch.id, watch.expiry, Number(v))}
          aria-label={`${watch.symbol} 整数关口步长`}
        />
      </span>
    </Tooltip>
  );
}
