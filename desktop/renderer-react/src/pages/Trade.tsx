import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Input, Space, Splitter, Steps, Tag } from 'antd';
import { CheckCircleFilled, ExclamationCircleFilled } from '@ant-design/icons';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { fmtMoney } from '../lib/format';
import { REJECT_CODE_LABEL, REJECT_SOURCE_LABEL, say } from '../lib/labels';
import { isTicket, OrderTicket } from '../lib/OrderTicket';
import { SimilarTrades } from '../lib/SimilarTrades';
import { useLlmCatalog } from '../store/llm';
import { navigate } from '../store/nav';
import { brokerShortName, gatewayName, pickableAccounts, useStatus } from '../store/status';
import { clearResult, savePickedAccounts, selectedAccounts, setInstruction, submitInstruction, useComposer, usePickedRevision, type SubmitPayload } from '../store/trade';
import type { InstructionOrder } from '../bridge';
import { ENTER_KEY, MOD_KEY, SHIFT_KEY } from '../store/appearance';
import { EmptyState, Meta, PageHead, Primer, StatusCard, Working, type Tone } from '../ui/kit';

// 交易指令:输入框(⌘Enter 解析)与解析结果并排(可拖分栏);「解析并校验(不下单)」/「发送到 IBKR / 富途」两个按钮。
// 这是整个软件唯一的主动作,进页就把光标放进输入框。

// 期权速记:内容与提示词的既定偏好逐条同源(§2 铁律 1/5 的用户例外),不在这里发明任何解析器不认识的规则
const SHORTHAND_CHIPS: [string, string][] = [
  ['1.8 挂15蝴蝶 15CM', '1.8 挂15蝴蝶 15CM'],
  ['7520的20cm蝴蝶', '7520的20cm蝴蝶'],
  ['call spread', '开一张今天的 7520 7550 call spread'],
  ['卖出铁鹰', '卖出 7200/7250/7650/7700 铁鹰'],
  ['权利金上限', ',权利金不超过 '],
  ['补理由', ',理由:'],
];

/** 窄窗口(< 980px)时两栏改成上下叠放 */
function useStacked(): boolean {
  const [stacked, setStacked] = useState(() => window.matchMedia('(max-width: 980px)').matches);
  useEffect(() => {
    const q = window.matchMedia('(max-width: 980px)');
    const on = () => setStacked(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return stacked;
}

export function TradePage() {
  const status = useStatus();
  const llm = useLlmCatalog();
  const stacked = useStacked();
  // 输入、结果、进行中的提交都在 store 里:切页回来还在原处(壳一次只挂载一页)
  const { text, busy, working, payload, failure } = useComposer();
  const setText = setInstruction;
  const pickRevision = usePickedRevision();
  const areaRef = useRef<TextAreaRef>(null);

  const connected = Boolean(status?.broker_connected);
  const engaged = Boolean(status?.breaker.engaged);
  const gateway = gatewayName(status);
  const broker = brokerShortName(status);
  const usable = useMemo(() => pickableAccounts(status), [status]);
  // pickRevision 看着"没用到",它正是重算的信号:勾选存在 store 里,selectedAccounts 直接读 store,
  // 不进依赖数组的话勾了新账户这里不会重算(eslint 看不出这层)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const picked = useMemo(() => selectedAccounts(usable), [usable, pickRevision]);

  // 开机 / 切回本页即可打字:每次都要用鼠标点一下才能打字是白白多出来的一步
  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  const keyed = llm ? Boolean(llm.key_configured?.[llm.current.provider]) : null;
  const steps = [
    { done: keyed !== false, title: '配置大模型 API Key', todo: '没有 Key 无法解析指令。Key 存于系统凭据库,不落配置文件。', ok: '已配置', tab: 'llm', action: '去配置', optional: false },
    { done: connected, title: `连接${gateway}`, todo: '没有券商连接只能解析,不能下单,也拿不到行情。', ok: '已连接', tab: status?.broker_provider === 'futu' ? 'futu' : 'tws', action: '去连接', optional: false },
    { done: Boolean(status?.auto_execute), title: '打开自动执行', todo: '当前「仅解析」,校验通过也不发单。确认要下单再打开。', ok: '已打开', tab: 'settings', action: '去设置', optional: true },
  ];
  const blocking = steps.filter((s) => !s.done && !s.optional);

  // 「发送」按钮只在真的会发到实盘账户时才橙字——常态是普通次要按钮,常橙会被读成"一直在警告"
  const liveOn = usable.length < 2 ? usable.some((a) => !a.is_paper) : usable.some((a) => !a.is_paper && picked.includes(a.alias));
  // 会发到实盘、但实盘闸门还关着的账户:这一份一定会被硬校验拦下(LIVE_TRADING_DISABLED),
  // 而这件事本地就知道——不该等花掉一次模型调用之后才由结果卡片告诉用户
  const liveBlocked = status && !status.allow_live_trading ? usable.filter((a) => !a.is_paper && picked.includes(a.alias)).map((a) => a.alias) : [];
  const blockers: string[] = [];
  if (!status?.auto_execute) blockers.push('自动执行未打开');
  if (!connected) blockers.push(`未连接 ${gateway}`);
  if (engaged) blockers.push('已熔断');
  if (status?.protections?.paused) blockers.push('保护规则暂停中');
  const canExecute = !blockers.length;

  function insertSnippet(snippet: string) {
    const box = areaRef.current?.resizableTextArea?.textArea;
    if (!box) {
      setText(text + snippet);
      return;
    }
    const start = box.selectionStart ?? text.length;
    const end = box.selectionEnd ?? text.length;
    // 追加到句尾时,整句片段前补换行;逗号开头的补充片段原样接上
    const atTail = start === text.length;
    const sep = atTail && text && !text.endsWith('\n') && !snippet.startsWith(',') ? '\n' : '';
    const next = text.slice(0, start) + sep + snippet + text.slice(end);
    setText(next);
    const caret = start + sep.length + snippet.length;
    requestAnimationFrame(() => {
      box.focus();
      box.setSelectionRange(caret, caret);
    });
  }

  function togglePick(alias: string, on: boolean) {
    const next = new Set(picked);
    if (on) next.add(alias);
    else next.delete(alias);
    savePickedAccounts(usable.map((a) => a.alias).filter((x) => next.has(x)));
  }

  const submit = (execute: boolean) => submitInstruction(execute, picked);

  const limits = status?.limits;

  const editor = (
    <div className="trade-editor">
      <Input.TextArea
        ref={areaRef}
        id="instruction"
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="例:spx到7500时,开一张今天的 7520 7550 call spread。理由:突破 7500 整数关口后追动能"
        onKeyDown={(e) => {
          // Ctrl+Enter 解析;Ctrl+Shift+Enter 解析并发送(走同一个确认框)
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void submit(e.shiftKey);
          }
        }}
      />
      <div className="row">
        <Button type="primary" id="btn-parse" loading={busy === 'parse'} disabled={busy === 'execute'} onClick={() => void submit(false)}>
          解析并校验
        </Button>
        <Button
          id="btn-execute"
          className={liveOn ? 'btn-warn' : undefined}
          loading={busy === 'execute'}
          disabled={!canExecute || busy === 'parse'}
          title={blockers.length ? `不能发送:${blockers.join('、')}` : '解析通过后直接发送给券商'}
          onClick={() => void submit(true)}
        >
          {`发送到${broker}`}
        </Button>
        <span className="muted">{`${MOD_KEY}${ENTER_KEY} 解析 · ${MOD_KEY}${SHIFT_KEY}${ENTER_KEY} 发送`}</span>
      </div>
      {/* 发单账户:只有一个账户时没什么可选,控件隐藏,行为与以前完全一样 */}
      {usable.length >= 2 ? (
        <div className="account-picker">
          <span className="muted">发单账户</span>
          <Space size={6} wrap className="account-chips">
            {usable.map((a) => {
              const on = picked.includes(a.alias);
              return (
                <Tag.CheckableTag
                  key={a.alias}
                  className={`account-chip${a.is_paper ? '' : ' live'}`}
                  checked={on}
                  onChange={(v) => togglePick(a.alias, v)}
                >
                  <span title={`${a.account_masked} · 连接 ${a.connection}`}>{`${a.alias} · ${a.is_paper ? '纸面' : '实盘'}`}</span>
                </Tag.CheckableTag>
              );
            })}
          </Space>
          <span className="muted">{picked.length > 1 ? `每笔订单各发 ${picked.length} 份,各自独立校验与记录` : picked.length === 1 ? '' : '未勾选账户,无法发单'}</span>
        </div>
      ) : null}
      {/* 实盘闸门是纯本地判断,不必等模型解析完再由校验层告诉用户"这一份发不出去"。
          这里只提醒,不替用户改勾选:改到哪个账户发单是他自己的决定 */}
      {liveBlocked.length ? (
        <div className="live-gate">
          <span>{`「${liveBlocked.join('」「')}」是实盘账户,当前没有允许实盘下单,${liveBlocked.length === picked.length ? '这条指令会被校验拦下' : '发到这个账户的那一份会被拦下'}。`}</span>
          <Button size="small" onClick={() => navigate('settings')}>
            去设置
          </Button>
        </div>
      ) : null}
      {/* 速记片段是"可点的词",不是胶囊按钮:填充底、无边框,和 Mail 收件人 token 同一族 */}
      <Space size={6} wrap className="shorthand-chips">
        {SHORTHAND_CHIPS.map(([label, snippet]) => (
          <Tag key={label} bordered={false} className="chip-tag" onClick={() => insertSnippet(snippet)}>
            {label}
          </Tag>
        ))}
      </Space>
      <Primer id="shorthand" intro summary="速记规则、默认值与发送条件">
        <ul className="hint-list">
          <li>默认 1 张、当日到期、组合默认 SPX、蝴蝶默认买入;用到默认值时结果会带警告,发送前核对。</li>
          <li>N cm = 翼宽 N 点;末尾孤立数字 = 净权利金上限;看涨 / 看跌未写时按现价推断。</li>
          <li>固定行话本地秒解、不经 AI:「1.8 挂15蝴蝶 15CM」中「挂」= 当日限价,「N蝴蝶」= 现价百位 + N(现价 6907 → 6915)。</li>
          <li>「蝴蝶」二字可省:「spx明天 7850 40cm 2.3」= 明日 7810/7850/7890 蝴蝶挂 2.3;带触发价、理由等附加语义仍走 AI。</li>
          <li>发送条件:自动执行已打开 · {`已连接 ${gateway}`} · 未熔断;实盘账户还需在「设置」里允许实盘下单。</li>
        </ul>
      </Primer>
    </div>
  );

  const results = (
    <div className="trade-results">
      <div className="pane-head">
        <h3>解析结果</h3>
        <Button size="small" type="text" onClick={clearResult}>
          清空
        </Button>
      </div>
      <div className="result">
        {working ? (
          <Working>{working}</Working>
        ) : failure ? (
          <StatusCard tone="bad" title="调用失败">
            <div>{failure}</div>
          </StatusCard>
        ) : payload ? (
          <ResultCards payload={payload} />
        ) : (
          <EmptyState>还没有解析结果</EmptyState>
        )}
      </div>
    </div>
  );

  return (
    <section className="tab-panel active" id="page-trade">
      <PageHead title="交易指令" extra={<span className="muted">{limits ? `单笔 ≤ ${fmtMoney(limits.max_order_notional)} USD · 期权 ≤ ${limits.max_option_contracts} 张` : '—'}</span>} />

      {/* 就绪检查表:三个前置条件,缺哪个说哪个,并给出去哪修;必要条件都满足就收起来 */}
      {blocking.length ? (
        <StatusCard tone="warn" title={`还差 ${blocking.length} 步才能开始`} className="readiness">
          <div className="readiness-sub">未完成项会挡住解析或下单,点右侧按钮前往。</div>
          <Steps
            direction="vertical"
            size="small"
            className="readiness-steps"
            items={steps.map((step) => ({
              title: step.title,
              status: step.done ? 'finish' : 'process',
              icon: step.done ? <CheckCircleFilled className="tone-icon ok" /> : <ExclamationCircleFilled className="tone-icon warn" />,
              description: (
                <span className="readiness-step">
                  <span>{step.done ? step.ok : step.todo}</span>
                  {!step.done ? (
                    <Button size="small" onClick={() => navigate(step.tab)}>
                      {step.action}
                    </Button>
                  ) : null}
                </span>
              ),
            }))}
          />
        </StatusCard>
      ) : null}

      {stacked ? (
        <div className="trade-grid">
          {editor}
          {results}
        </div>
      ) : (
        <Splitter className="trade-split">
          <Splitter.Panel defaultSize="50%" min="36%" max="64%">
            {editor}
          </Splitter.Panel>
          <Splitter.Panel>{results}</Splitter.Panel>
        </Splitter>
      )}
    </section>
  );
}

function ResultCards({ payload }: { payload: SubmitPayload }) {
  const groups: [Tone, string, InstructionOrder[]][] = [
    ['ok', '已提交', payload.submitted || []],
    ['info', '排队等待触发', payload.queued || []],
    ['warn', '已通过校验(未发送)', payload.validated_only || []],
  ];
  const cards: ReactNode[] = [];
  for (const [kind, label, items] of groups) {
    items.forEach((item, i) => {
      const meta = [`账户 ${item.account || '—'}`];
      if (item.notional !== undefined) meta.push(`敞口 ≈ ${fmtMoney(item.notional)} USD`);
      if (item.order_id) meta.push(`订单号 ${item.order_id}`);
      if (item.mode) meta.push(item.mode === 'software_watch' ? '软件盯盘(AUTO_MID)' : item.mode);
      cards.push(
        <StatusCard key={`${label}-${i}`} tone={kind} title={`${label} · ${item.intent_summary || ''}`} className="ticket-card">
          {/* 老引擎的摘要里没有 ticket:那就只剩标题那一句话,和从前一样 */}
          {isTicket(item.ticket) ? <OrderTicket ticket={item.ticket} /> : null}
          <Meta items={meta} />
          {/* 历史里相似的交易:只读展示,不拦单 */}
          {isTicket(item.ticket) ? <SimilarTrades ticket={item.ticket} /> : null}
        </StatusCard>,
      );
    });
  }
  (payload.rejections || []).forEach((r, i) => {
    // 拒绝码翻成人话:LIVE_TRADING_DISABLED 这种是引擎内部的枚举,不该是用户读到的第一行。
    // 词表里没有的照旧露英文——见 labels.ts:露一个英文好过编一个错的中文
    const why = say(REJECT_CODE_LABEL, r.code) || '未说明原因';
    cards.push(
      <StatusCard key={`rej-${i}`} tone="bad" title={`${REJECT_SOURCE_LABEL[r.source] || '拒绝'} · ${why}`}>
        <div>{r.message}</div>
        {r.original_text || r.intent_summary ? <div className="reason">{r.original_text || r.intent_summary}</div> : null}
      </StatusCard>,
    );
  });
  if (payload.warnings?.length) {
    cards.push(
      <StatusCard key="warn" tone="warn" title="提示">
        <ul>
          {payload.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      </StatusCard>,
    );
  }
  if (payload.llm) {
    // 本地速记命中时不显示 token 用量——根本没调大模型,显示 0 tokens 反而让人疑惑
    const local = payload.llm.model === 'local-shorthand';
    const meta = local
      ? [`语法 ${payload.llm.model}`, '毫秒级本地解析,规则与 AI 同一套校验']
      : [`模型 ${payload.llm.model}`, `提示词 ${payload.llm.prompt_version}`, `模型 ${payload.llm.latency_ms} ms`, `in ${payload.llm.usage?.input_tokens ?? '—'} / out ${payload.llm.usage?.output_tokens ?? '—'} tokens`];
    if (payload.__elapsedMs != null) meta.push(`全链路 ${payload.__elapsedMs} ms`);
    cards.push(
      <StatusCard key="llm" title={local ? '本次解析 · 本地秒解(未经大模型)' : '本次解析'}>
        <Meta items={meta} />
      </StatusCard>,
    );
  }
  if (!cards.length) return <EmptyState>没有解析出任何订单。</EmptyState>;
  return <>{cards}</>;
}
