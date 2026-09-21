/** 行情页「盘口」那一节:一张关注列表 + 每只一张只读的盘口卡片。
 *
 * 2026-09-21 从 pages/Market.tsx 搬出来(函数体逐字未改)。
 * 一处状态、两处用:关注列表(盘口墙与 PA 那一节的下拉)共用同一份收藏表。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Input, Space } from 'antd';
import { dafri, errorMessage } from '../bridge';
import { BookBody, read, write, type BookCell, type Books } from './marketBits';
import { showBanner } from '../store/banner';
import { useStatus } from '../store/status';
import { EmptyState, Primer, SectionTitle, StatusCard } from '../ui/kit';

export function readSymbols(): string[] {
  try {
    const raw = JSON.parse(read('dafri-book-symbols') || '[]');
    return Array.isArray(raw) ? raw.map(String) : [];
  } catch {
    return [];
  }
}

export function useBooks(): Books {
  const status = useStatus();
  const connected = Boolean(status?.broker_connected);
  const [symbols, setSymbols] = useState<string[]>(readSymbols);
  const [data, setData] = useState<Record<string, BookCell | undefined>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const symbolsRef = useRef(symbols);
  symbolsRef.current = symbols;
  const focused = useRef('');

  const load = useCallback(async (symbol: string) => {
    setLoading((s) => new Set(s).add(symbol));
    try {
      const snap = await dafri.orderBook(symbol);
      setData((d) => ({ ...d, [symbol]: snap }));
    } catch (err) {
      setData((d) => ({ ...d, [symbol]: { error: errorMessage(err) } }));
    } finally {
      setLoading((s) => {
        const n = new Set(s);
        n.delete(symbol);
        return n;
      });
    }
  }, []);

  // 逐个刷:十几个盘口同时压给引擎只会在读通道里排队;正在看的那个排最前
  const refreshAll = useCallback(async () => {
    const all = [focused.current, ...symbolsRef.current].filter(Boolean);
    for (const symbol of [...new Set(all)]) await load(symbol);
  }, [load]);

  // 已连 TWS 时每 20 秒自动刷新
  useEffect(() => {
    const t = setInterval(() => {
      if (connected) void refreshAll();
    }, 20_000);
    return () => clearInterval(t);
  }, [connected, refreshAll]);

  const focus = useCallback(
    (symbol: string) => {
      if (focused.current === symbol) return;
      focused.current = symbol;
      if (symbol) void load(symbol);
    },
    [load],
  );

  function persist(next: string[]) {
    setSymbols(next);
    write('dafri-book-symbols', JSON.stringify(next));
  }

  async function add(raw: string): Promise<boolean> {
    const symbol = raw.trim().toUpperCase();
    if (!symbol) return false;
    if (symbols.includes(symbol)) return true;
    if (symbols.length >= 12) {
      showBanner('盘口最多同时关注 12 个标的', true);
      return false;
    }
    persist([...symbols, symbol]);
    // 上面正在看的就是它:快照已经有了,不用再取一遍
    const cell = data[symbol];
    if (!cell || 'error' in cell) await load(symbol);
    return true;
  }

  function remove(symbol: string) {
    persist(symbols.filter((s) => s !== symbol));
    // 上面那张盘口还在用这份快照
    if (symbol === focused.current) return;
    setData((d) => {
      const n = { ...d };
      delete n[symbol];
      return n;
    });
  }

  return { symbols, data, loading, load, refreshAll, add, remove, focus };
}

export function BookWall({ books, onAnalyze }: { books: Books; onAnalyze: (symbol: string) => void }) {
  const { symbols } = books;
  const [input, setInput] = useState('');

  async function add() {
    if (await books.add(input)) setInput('');
  }

  return (
    <section className="sub-panel active" id="panel-book">
      <SectionTitle count={symbols.length}>关注的盘口</SectionTitle>
      <div className="row tight">
        <Input id="book-symbol" className="grow" placeholder="再盯一个盘口,如 SPY、NVDA(指数请用对应 ETF)" maxLength={12} value={input} onChange={(e) => setInput(e.target.value)} onPressEnter={() => void add()} />
        <Button id="btn-book-load" onClick={() => void add()}>
          添加
        </Button>
        <Button type="text" disabled={!symbols.length} onClick={() => void books.refreshAll()}>
          全部刷新
        </Button>
      </div>
      <div className="sector-grid">
        {!symbols.length ? (
          <EmptyState>还没有关注的盘口。上面加一个,或在正在看的那张盘口上点「加入关注」。</EmptyState>
        ) : (
          symbols.map((symbol) => (
            <BookCard
              key={symbol}
              symbol={symbol}
              snapshot={books.data[symbol]}
              loading={books.loading.has(symbol)}
              onAnalyze={() => onAnalyze(symbol)}
              onRefresh={() => void books.load(symbol)}
              onRemove={() => books.remove(symbol)}
            />
          ))
        )}
      </div>
      {/* 还没关注任何标的时,读盘常识正是这一刻要看的东西;加了标的它就该让路 */}
      <Primer id="book-primer" summary="读盘常识" defaultOpen={!symbols.length}>
        <div className="cards">
          <StatusCard title="订单簿是什么">
            <div>
              未成交限价单按价格聚合:买单从高到低,卖单从低到高。买一与卖一之差是<strong>价差</strong>,各价位挂单量是<strong>深度</strong>。一档(L1)只看买一/卖一;Level 2 看多档,需单独订阅。
            </div>
          </StatusCard>
          <StatusCard title="怎么读">
            <div>价差窄、深度厚 = 流动性好、滑点小;价差宽、深度薄时大单会吃穿多档。某价位的异常大单可能是支撑/压力,也可能是随时撤掉的诱导单:挂单不等于成交。盘前盘后深度明显变薄。</div>
          </StatusCard>
          <StatusCard tone="warn" title="对本系统的意义">
            <div>
              AUTO_MID 按盘口中间价 ±滑点上限定价:价差 10 美分的票,上限 0.10 合理;价差 2 美元的期权组合则可能永远不成交。下条件单前先看价差,再定净权利金上限或滑点。期权盘口普遍比正股宽一个数量级。
            </div>
          </StatusCard>
        </div>
      </Primer>
    </section>
  );
}

export function BookCard({ symbol, snapshot, loading, onAnalyze, onRefresh, onRemove }: { symbol: string; snapshot: any; loading: boolean; onAnalyze: () => void; onRefresh: () => void; onRemove: () => void }) {
  return (
    <Card
      size="small"
      className="sector-card"
      title={
        <button type="button" className="record-sym book-sym" title="看它的 K 线" onClick={onAnalyze}>
          {symbol}
        </button>
      }
      extra={
        <Space size={4}>
          <Button size="small" loading={loading} onClick={onRefresh}>
            {loading ? '读取中…' : '刷新'}
          </Button>
          <Button size="small" type="text" onClick={onRemove}>
            移除
          </Button>
        </Space>
      }
    >
      <BookBody snapshot={snapshot} loading={loading} />
    </Card>
  );
}
