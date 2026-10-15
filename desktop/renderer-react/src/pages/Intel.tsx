import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Segmented, Switch, Tag } from 'antd';
import { IntelTimeline } from '../lib/IntelTimeline';
import { EMPTY_FILTER, filterItems, hotSymbols, KIND_LABEL, KIND_ORDER } from '../lib/intelRules';
import { MOD_KEY } from '../store/appearance';
import { loadIntelFeed, markIntelSeen, openDossier, setIntelHeldOnly, setIntelKinds, setLookupOpen, useIntel } from '../store/intel';
import { clearNavFocus, useNavFocus } from '../store/nav';
import { useStatus } from '../store/status';
import { LoadingBlock, Notice, PageHead, Primer } from '../ui/kit';
import type { IntelKind } from '../bridge';

// 情报:Discord 里的消息、价位与异动的信号、宏观与自定义事件、自己下过的单、记下的想法,按时间排成一条线,
// 每一条都认出了它在说哪几只标的——点标的打开它的档案(持仓、追踪、价位、事件、提到它的消息)。只读,不发单。

export function IntelPage() {
  const { feed, feedError, loading, kinds, heldOnly } = useIntel();
  const status = useStatus();
  const [query, setQuery] = useState('');
  const focus = useNavFocus('intel');

  // 进页即刷;人在这一页、窗口在前台就算看过了"持仓的票被提到"
  useEffect(() => {
    void loadIntelFeed();
    markIntelSeen();
    const onFocus = () => markIntelSeen();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // 弹窗「查看」带着标的跳过来:直接打开它的档案
  useEffect(() => {
    if (!focus) return;
    openDossier(focus.symbol);
    clearNavFocus(focus.seq);
  }, [focus]);

  const items = useMemo(() => filterItems(feed?.items ?? [], { ...EMPTY_FILTER, query }), [feed, query]);
  const hot = useMemo(() => hotSymbols(feed?.items ?? []), [feed]);
  const now = feed?.at ?? Date.now();
  const kindValue = kinds.length === 1 ? kinds[0] : 'all';

  return (
    <section className="tab-panel active" id="page-intel">
      <PageHead
        title="情报"
        extra={(
          <div className="intel-actions">
            <Button shape="round" onClick={() => setLookupOpen(true)}>查标的 {MOD_KEY}K</Button>
            <Button shape="round" loading={loading} onClick={() => void loadIntelFeed()}>刷新</Button>
          </div>
        )}
      />
      <Primer id="intel" intro summary="消息、信号、事件、单子、想法按标的串成一条线;点标的看它的档案">
        <p>
          Discord 频道里的每一条消息(bot 读的与本地收件读的)都会认出它提到了哪几只标的:写了 $ 的、在持仓 / 股票池 / 板块 / 提醒里的、
          中文名与常用叫法(英伟达、标普);没写标的的期权行话(「7700 7725 bear call」)算作 SPX。像代码但不在名单里的词标一个问号,只作参考。
        </p>
        <p>
          消息上记着提到那一刻的价,旁边是此刻的价:事后看得出"他说的时候在哪、现在走到哪了"。只取已经在订着的行情(指数、持仓、股票池),
          随口提到的票不另占行情线路。信任的人提到自己持仓的票时会弹窗提醒。像单子的消息可以「写进指令框」,发不发还是你自己的事。
        </p>
      </Primer>
      {!status?.broker_connected ? <Notice tone="info" title="没连券商">时间线照常;消息上"此刻的价"、档案里的持仓与现价要连上之后才有。</Notice> : null}
      {feedError ? <Notice tone="warn" title="时间线没读到">{feedError}</Notice> : null}
      <div className="intel-bar">
        <Segmented
          size="small"
          value={kindValue}
          onChange={(v) => setIntelKinds(v === 'all' ? [] : [v as IntelKind])}
          options={[{ label: '全部', value: 'all' }, ...KIND_ORDER.map((k) => ({ label: KIND_LABEL[k], value: k }))]}
        />
        <label className="intel-held">
          <Switch size="small" checked={heldOnly} onChange={setIntelHeldOnly} /> 只看持仓相关
        </label>
        <Input allowClear size="small" className="intel-search" placeholder="筛:代码或原文里的字" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="intel-count">{feed ? `${items.length} 条 · 共记 ${feed.total_messages} 条消息` : ''}</span>
      </div>
      {hot.length ? (
        <div className="intel-hot">
          <span>常被提到</span>
          {hot.map((h) => (
            <Tag key={h.symbol} bordered={false} className={`chip-tag${h.held ? ' held' : ''}`} onClick={() => openDossier(h.symbol)} title={h.held ? '持仓中' : undefined}>
              {h.symbol} <b>{h.n}</b>
            </Tag>
          ))}
        </div>
      ) : null}
      {!feed && !feedError ? <LoadingBlock rows={5} /> : <IntelTimeline items={items} now={now} empty={query ? `没有含「${query}」的` : undefined} />}
    </section>
  );
}
