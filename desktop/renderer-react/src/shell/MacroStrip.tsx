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
            : row.key === '^TNX'
              ? 'TWS 实时流式,读的是 Cboe 的 TNX 指数本身;它按 10 倍报价,这里显示除以 10 之后的收益率'
              : `TWS 实时流式,读的是标的本身(${row.instrument})`
          : row.instrument === 'Cboe'
            ? 'Yahoo 取不到,改读 Cboe 官方的延迟行情(15 分钟),读的同样是指数本身'
            : '公开数据源(Yahoo),分钟级:没连 TWS、或 TWS 这一格没有报价时走这条';
        const dir = row.change_pct == null ? null : row.change_pct > 0 ? 'up' : row.change_pct < 0 ? 'down' : 'flat';
        return (
          <div className="macro-item" key={row.key} title={title}>
            <span className="macro-top">
              <span className="macro-label">{row.label}</span>
              {/* 标出这一格读的是哪条行情:TWS 那路的合约(SPX、COMEX GC、PAXOS…),或 Yahoo 挂掉时的 Cboe 备用源;走 Yahoo 的不标 */}
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
