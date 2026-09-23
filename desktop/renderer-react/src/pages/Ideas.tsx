import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Checkbox, Input, Segmented, Space } from 'antd';
import { dafri, errorMessage } from '../bridge';
import type {
  Idea, IdeaAnalysis, IdeaBriefMetric, IdeaDigest, IdeaDigestRow, IdeaMatch,
} from '../bridge';
import { tradeText } from '../lib/tradeFacts';
import { fmtTime, fmtTimeShort } from '../lib/format';
import { showBanner } from '../store/banner';
import { navigate } from '../store/nav';
import { setTradeDraft } from '../store/trade';
import { EmptyState, Meta, PageHead, Primer, StatusCard } from '../ui/kit';

// 想法备忘:随手记,不解析、不下单。归档不是丢弃,攒起来的想法能一键提炼成知识,总结历史落库可回看。
// 想法、分析、总结的形状在引擎契约里(engine-ts/src/contract/ideas.ts),从 bridge 拿;analysis 与 digest 是库里的两列 JSON,
// 契约把它们标成 Partial——老版本写进去的可能缺键,所以下面每一项都按"可能没有"来画。

const IDEA_STATUS_LABEL: Record<string, string> = { active: '进行中', done: '已完成', archived: '已归档' };
const MATCH_LABEL: Record<IdeaMatch, string> = { symbol: '标的命中', text: '原文命中', semantic: '语义相近', recent: '近期' };
const BRIEF_LABELS: [IdeaBriefMetric, string, string][] = [
  ['last', '现价', ''],
  ['chg_1d_pct', '1日', '%'],
  ['chg_20d_pct', '20日', '%'],
  ['chg_60d_pct', '60日', '%'],
  ['rsi14', 'RSI14', ''],
  ['vs_sma50_pct', '对50日线', '%'],
  ['vs_sma200_pct', '对200日线', '%'],
  ['vol20_annual_pct', '年化波动', '%'],
  ['from_52w_high_pct', '距52周高', '%'],
];

function BulletList({ title, items }: { title: string; items?: string[] }) {
  if (!items || !items.length) return null;
  return (
    <>
      <div>{title}</div>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </>
  );
}

export function IdeasPage() {
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [digests, setDigests] = useState<IdeaDigestRow[]>([]);
  const [text, setText] = useState('');
  const [digesting, setDigesting] = useState(false);
  // 总结时附带真实成交算出的结局(成 / 败 / 收益率由引擎算,模型只解读)
  const [withTrades, setWithTrades] = useState(true);
  // 检索:回车才生效(每分钟那一轮刷新也按它取),清空即回到列表
  const [query, setQuery] = useState('');
  const [matched, setMatched] = useState<Record<string, IdeaMatch[]>>({});

  const loadDigests = useCallback(async () => {
    try {
      const { digests: list } = await dafri.listIdeaDigests();
      setDigests(list || []);
    } catch (err) {
      console.warn('读取知识总结失败', err);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const status = filter === 'all' ? undefined : filter;
      if (query) {
        const { hits } = await dafri.searchIdeas({ q: query, status, limit: 200 });
        setIdeas((hits || []).map((h) => h.idea));
        setMatched(Object.fromEntries((hits || []).map((h) => [h.idea.id, h.matched_by])));
      } else {
        const { ideas: list } = await dafri.listIdeas(status);
        setIdeas(list || []);
        setMatched({});
      }
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
    void loadDigests(); // 不阻塞想法列表;失败只记 console
  }, [filter, query, loadDigests]);

  // 进页即刷,停留期间每分钟一轮
  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function add() {
    const t = text.trim();
    if (!t) return;
    try {
      await dafri.addIdea(t);
      setText('');
      setFilter('active');
      if (filter === 'active') await load();
    } catch (err) {
      showBanner(`记录想法失败:${errorMessage(err)}`, false);
    }
  }

  async function setStatus(id: string, status: string) {
    try {
      await dafri.updateIdea(id, status);
      await load();
    } catch (err) {
      showBanner(`更新想法失败:${errorMessage(err)}`, false);
    }
  }

  async function digest() {
    setDigesting(true);
    try {
      // 已归档 + 已完成一起看,规律才完整;有检索词时改成「命中的按时间分层抽 + 最近的一批」
      await dafri.digestIdeas('all', query ? { q: query } : undefined, withTrades);
      await loadDigests();
    } catch (err) {
      showBanner(`知识总结失败:${errorMessage(err)}`, false);
    } finally {
      setDigesting(false);
    }
  }

  /** 「发到解析」把文本带到「交易指令」页 */
  function sendToTrade(idea: Idea) {
    setTradeDraft(idea.text);
    navigate('trade');
  }

  const latest = digests[0];
  const d: Partial<IdeaDigest> = latest?.digest || {};

  return (
    <section className="tab-panel active" id="page-ideas">
      <PageHead title="想法" extra={<span className="muted">随手记,不解析、不下单</span>} />
      <div className="row tight">
        <Input className="grow" placeholder="例:AXTI 周五尾盘买入" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} onPressEnter={() => void add()} />
        <Button type="primary" onClick={() => void add()}>
          记下
        </Button>
      </div>
      <Primer id="intro-ideas" intro summary="「AI 分析」和「发到解析」是什么">
        <p className="hint">
          「AI 分析」用配置的大模型解读逻辑、待核实点与风险,<strong>仅供参考,不会下单</strong>;
          「发到解析」把文本带到「交易指令」页。
        </p>
      </Primer>
      <div className="row tight">
        <Segmented
          size="small"
          options={[
            { label: '进行中', value: 'active' },
            { label: '全部', value: 'all' },
          ]}
          value={filter}
          onChange={(v) => setFilter(v as 'active' | 'all')}
        />
        <Input.Search
          size="small"
          className="grow"
          allowClear
          placeholder="检索想法:蝴蝶 结算 / RKLB(回车)"
          onSearch={(v) => setQuery(v.trim())}
        />
        <Checkbox checked={withTrades} onChange={(e) => setWithTrades(e.target.checked)}>
          附带交易结果
        </Checkbox>
        <Button size="small" loading={digesting} onClick={() => void digest()}>
          {digesting ? '总结中…' : query ? '按检索总结' : '总结知识'}
        </Button>
      </div>

      {latest ? (
        <StatusCard title={`知识总结 · ${d.summary || ''}`} className="digest-card">
          <BulletList title="反复出现的主题:" items={d.themes} />
          <BulletList title="经验教训:" items={d.lessons} />
          <BulletList title="想法质量的规律:" items={d.patterns} />
          <BulletList title="下一步:" items={d.actions} />
          <BulletList title="对照的交易(引擎从真实成交算出):" items={latest.trades?.map(tradeText)} />
          <Meta
            items={[
              `基于 ${latest.idea_count} 条想法`,
              latest.trades ? `附带 ${latest.trades.length} 笔交易结果` : null,
              latest.focus ? `检索:${[latest.focus.q, ...(latest.focus.symbols || [])].filter(Boolean).join(' ')}` : null,
              d.model ? `模型 ${d.model}` : null,
              <span title={fmtTime(latest.created_at)}>{`总结于 ${fmtTimeShort(latest.created_at)}`}</span>,
              digests.length > 1 ? `共 ${digests.length} 次总结,新的在上` : null,
              '仅供复盘参考,不构成投资建议',
            ]}
          />
        </StatusCard>
      ) : null}

      <div className="cards">
        {loadError ? (
          <EmptyState>读取失败:{loadError}</EmptyState>
        ) : !ideas.length ? (
          <EmptyState>{query ? `没有命中「${query}」的想法。` : filter === 'active' ? '还没有进行中的想法。' : '还没有想法。'}</EmptyState>
        ) : (
          ideas.map((idea) => (
            <IdeaCard key={idea.id} idea={idea} matchedBy={matched[idea.id]} onStatus={setStatus} onSend={sendToTrade} onChanged={load} />
          ))
        )}
      </div>
    </section>
  );
}

function IdeaCard({
  idea,
  matchedBy,
  onStatus,
  onSend,
  onChanged,
}: {
  idea: Idea;
  matchedBy?: IdeaMatch[];
  onStatus: (id: string, status: string) => Promise<void>;
  onSend: (idea: Idea) => void;
  onChanged: () => Promise<void>;
}) {
  const [analyzing, setAnalyzing] = useState(false);

  async function analyze() {
    setAnalyzing(true);
    try {
      await dafri.analyzeIdea(idea.id);
      await onChanged();
    } catch (err) {
      showBanner(`AI 分析失败:${errorMessage(err)}`, false);
    } finally {
      setAnalyzing(false);
    }
  }

  const tone = idea.status === 'active' ? 'pending' : idea.status === 'done' ? 'filled' : 'rejected';
  return (
    <Card
      size="small"
      className="idea-card"
      title={<span className="record-sym">{(idea.symbols || []).join(' · ') || '想法'}</span>}
      extra={<span className={`status ${tone}`}>{IDEA_STATUS_LABEL[idea.status] || idea.status}</span>}
    >
      <div>{idea.text}</div>
      <Meta
        items={[
          <span title={fmtTime(idea.created_at)}>{fmtTimeShort(idea.created_at)}</span>,
          matchedBy?.length ? matchedBy.map((m) => MATCH_LABEL[m]).join(' · ') : null,
        ]}
      />
      {idea.analysis ? <Analysis analysis={idea.analysis} /> : null}
      <Space size={6} className="card-actions" wrap>
        {idea.status === 'active' ? (
          <>
            <Button size="small" type="primary" loading={analyzing} onClick={() => void analyze()}>
              {analyzing ? '分析中…' : idea.analysis ? 'AI 重新分析' : 'AI 分析'}
            </Button>
            <Button size="small" onClick={() => onSend(idea)}>
              发到解析
            </Button>
            <Button size="small" type="text" onClick={() => void onStatus(idea.id, 'done')}>
              完成
            </Button>
            <Button size="small" type="text" onClick={() => void onStatus(idea.id, 'archived')}>
              归档
            </Button>
          </>
        ) : (
          <Button size="small" type="text" onClick={() => void onStatus(idea.id, 'active')}>
            恢复为进行中
          </Button>
        )}
      </Space>
    </Card>
  );
}

function Analysis({ analysis }: { analysis: Partial<IdeaAnalysis> }) {
  const brief = analysis.brief;
  // 行情事实(代码计算)与 AI 叙事分开标注,别混为一谈
  let facts: ReactNode = null;
  if (brief && !brief.error) {
    const text = BRIEF_LABELS.filter(([key]) => brief[key] != null)
      .map(([key, label, unit]) => `${label} ${brief[key]}${unit}`)
      .join(' · ');
    const anchor = brief.anchor;
    facts = (
      <>
        {text ? <div className="stock-sub">{`${analysis.symbol || ''} 行情(代码计算):${text}`}</div> : null}
        {anchor ? (
          <div className="stock-sub">
            {`价格锚点:${anchor.label} = ${anchor.price}${anchor.chg_from_anchor_pct != null ? ` · 现价较锚点 ${anchor.chg_from_anchor_pct >= 0 ? '+' : ''}${anchor.chg_from_anchor_pct}%` : ''}`}
          </div>
        ) : null}
      </>
    );
  } else if (brief && brief.error) {
    facts = <div className="stock-sub">{`行情获取失败:${brief.error}`}</div>;
  } else if (analysis.symbol) {
    facts = <div className="stock-sub">分析时未连接券商网关,无行情情报</div>;
  }
  return (
    <div className="result">
      <StatusCard title={`AI 分析 · ${analysis.summary || ''}`}>
        {facts}
        {analysis.thesis ? <div>{`逻辑:${analysis.thesis}`}</div> : null}
        <BulletList title="下单前先核实:" items={analysis.checks} />
        <BulletList title="风险:" items={analysis.risks} />
        {analysis.suggestion ? <div className="reason">{`建议:${analysis.suggestion}`}</div> : null}
        <Meta
          items={[
            analysis.model ? `模型 ${analysis.model}` : null,
            analysis.analyzed_at ? <span title={fmtTime(analysis.analyzed_at)}>{`分析于 ${fmtTimeShort(analysis.analyzed_at)}`}</span> : null,
            '仅供参考,不构成投资建议',
          ]}
        />
      </StatusCard>
    </div>
  );
}
