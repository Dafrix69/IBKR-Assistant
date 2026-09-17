import { useMacroRows, useMacroTrails, type MacroRow } from '../store/macro';
import { Sparkline } from '../ui/graphics';

function fmtValue(row: MacroRow): string {
  if (row.last == null) return '—';
  if (row.fmt === 'pct') return `${row.last.toFixed(2)}%`;
  if (row.fmt === 'plain') return row.last.toFixed(2);
  return row.last.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** 全局宏观行情带:公开数据,只读展示,不参与定价。一个数都没有时整条收起。 */
export function MacroStrip() {
  const rows = useMacroRows();
  const trails = useMacroTrails();
  const hidden = !rows.some((row) => row.last != null);
  return (
    <div id="macro-strip" className="macro-strip" hidden={hidden} title="仅供参考,不参与定价。已连 TWS 且有实时权限的走 2 秒流式;其余为公开数据源,分钟级">
      {rows.map((row) => {
        const live = row.source === 'tws';
        const title = live
          ? row.instrument === 'PAXOS'
            ? 'TWS 实时流式,读的是 IBKR/PAXOS 的比特币现货,就是币价本身'
            : `TWS 实时流式,实际读的是 ${row.instrument}(ETF,涨跌幅贴近但绝对价位与指数不同)`
          : '公开数据源,分钟级;VIX 与美债10Y 永远走这条(它们没有不失真的 ETF 替身)';
        const dir = row.change_pct == null ? null : row.change_pct > 0 ? 'up' : row.change_pct < 0 ? 'down' : 'flat';
        return (
          <div className="macro-item" key={row.key} title={title}>
            <span className="macro-top">
              <span className="macro-label">{row.label}</span>
              {/* 读的不是指数本身就必须标出来:GLD 几百美元、黄金期货几千美元,不标的话那个数字会让人以为行情崩了 */}
              {row.instrument ? <span className="macro-inst">{row.instrument}</span> : null}
              {row.stale ? <span className="macro-stale">旧</span> : null}
            </span>
            <span className="macro-bottom">
              <span className={`macro-value${live ? ' live' : ''}`}>{fmtValue(row)}</span>
              {dir ? (
                <span className={`macro-chg ${dir}`}>
                  {dir === 'flat' ? null : <i className="macro-arrow" />}
                  {`${Math.abs(row.change_pct!)}%`}
                </span>
              ) : null}
            </span>
            {(trails[row.key]?.length || 0) >= 3 ? <Sparkline values={trails[row.key]} width={44} height={20} tint={dir === 'down' ? 'down' : dir === 'up' ? 'up' : 'gray'} fill={false} className="macro-spark" /> : null}
          </div>
        );
      })}
    </div>
  );
}
