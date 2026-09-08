'use strict';
// 想法备忘与知识总结

// ======================================================================
// 想法备忘
// ======================================================================
async function loadIdeas() {
  try {
    const status = state.ideaFilter === 'all' ? undefined : state.ideaFilter;
    const { ideas } = await window.dafri.listIdeas(status);
    state.ideas = ideas;
    renderIdeas();
  } catch (err) {
    empty($('ideas-list'), `读取失败:${err.message}`);
  }
  loadIdeaDigests(); // 不阻塞想法列表;失败只记 console
}

const IDEA_STATUS_LABEL = { active: '进行中', done: '已完成', archived: '已归档' };

function renderIdeas() {
  const box = $('ideas-list');
  if (!state.ideas.length) {
    return empty(box, state.ideaFilter === 'active' ? '还没有进行中的想法。' : '还没有想法。');
  }
  clear(box);

  for (const idea of state.ideas) {
    const node = el('div', 'record');

    const head = el('div', 'record-head');
    head.appendChild(el('span', 'record-sym', (idea.symbols || []).join(' · ') || '想法'));
    head.appendChild(
      el(
        'span',
        `status ${idea.status === 'active' ? 'pending' : idea.status === 'done' ? 'filled' : 'rejected'}`,
        IDEA_STATUS_LABEL[idea.status] || idea.status
      )
    );
    node.appendChild(head);

    node.appendChild(el('div', null, idea.text));

    const meta = el('div', 'card-meta');
    const ideaWhen = el('span', null, fmtTimeShort(idea.created_at));
    ideaWhen.title = fmtTime(idea.created_at);
    meta.appendChild(ideaWhen);
    node.appendChild(meta);

    if (idea.analysis) node.appendChild(renderIdeaAnalysis(idea.analysis));

    const actions = el('div', 'row tight');
    if (idea.status === 'active') {
      const analyze = el('button', 'btn tiny primary', idea.analysis ? 'AI 重新分析' : 'AI 分析');
      analyze.addEventListener('click', () => analyzeIdea(idea, analyze));
      actions.appendChild(analyze);

      const send = el('button', 'btn tiny', '发到解析');
      send.addEventListener('click', () => {
        $('instruction').value = idea.text;
        document.querySelector('.tab[data-tab="trade"]').click();
        $('instruction').focus();
      });
      actions.appendChild(send);

      const done = el('button', 'btn tiny ghost', '完成');
      done.addEventListener('click', () => setIdeaStatus(idea.id, 'done'));
      actions.appendChild(done);

      const archive = el('button', 'btn tiny ghost', '归档');
      archive.addEventListener('click', () => setIdeaStatus(idea.id, 'archived'));
      actions.appendChild(archive);
    } else {
      const restore = el('button', 'btn tiny ghost', '恢复为进行中');
      restore.addEventListener('click', () => setIdeaStatus(idea.id, 'active'));
      actions.appendChild(restore);
    }
    node.appendChild(actions);
    box.appendChild(node);
  }
}

const BRIEF_LABELS = [
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

function renderIdeaAnalysis(analysis) {
  const box = el('div', 'result');
  const node = card('info', `AI 分析 · ${analysis.summary || ''}`);

  // 行情事实(代码计算)与 AI 叙事分开标注,别混为一谈
  if (analysis.brief && !analysis.brief.error) {
    const facts = BRIEF_LABELS
      .filter(([key]) => analysis.brief[key] != null)
      .map(([key, label, unit]) => `${label} ${analysis.brief[key]}${unit}`)
      .join(' · ');
    if (facts) {
      node.appendChild(el('div', 'stock-sub', `${analysis.symbol || ''} 行情(代码计算):${facts}`));
    }
    const anchor = analysis.brief.anchor;
    if (anchor) {
      const chg = anchor.chg_from_anchor_pct;
      node.appendChild(
        el('div', 'stock-sub',
          `价格锚点:${anchor.label} = ${anchor.price}${chg != null ? ` · 现价较锚点 ${chg >= 0 ? '+' : ''}${chg}%` : ''}`)
      );
    }
  } else if (analysis.brief && analysis.brief.error) {
    node.appendChild(el('div', 'stock-sub', `行情获取失败:${analysis.brief.error}`));
  } else if (analysis.symbol) {
    node.appendChild(el('div', 'stock-sub', '分析时未连接券商网关,无行情情报'));
  }

  if (analysis.thesis) node.appendChild(el('div', null, `逻辑:${analysis.thesis}`));

  const addList = (title, items) => {
    if (!items || !items.length) return;
    node.appendChild(el('div', null, title));
    const list = el('ul');
    items.forEach((item) => list.appendChild(el('li', null, item)));
    node.appendChild(list);
  };
  addList('下单前先核实:', analysis.checks);
  addList('风险:', analysis.risks);
  if (analysis.suggestion) node.appendChild(el('div', 'reason', `建议:${analysis.suggestion}`));

  const meta = el('div', 'card-meta');
  if (analysis.model) meta.appendChild(el('span', null, `模型 ${analysis.model}`));
  if (analysis.analyzed_at) {
    const at = el('span', null, `分析于 ${fmtTimeShort(analysis.analyzed_at)}`);
    at.title = fmtTime(analysis.analyzed_at);
    meta.appendChild(at);
  }
  meta.appendChild(el('span', null, '仅供参考,不构成投资建议'));
  node.appendChild(meta);
  box.appendChild(node);
  return box;
}

async function analyzeIdea(idea, button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '分析中…';
  try {
    await window.dafri.analyzeIdea(idea.id);
    await loadIdeas();
  } catch (err) {
    showBanner(`AI 分析失败:${err.message}`, false);
    button.disabled = false;
    button.textContent = original;
  }
}

async function setIdeaStatus(id, status) {
  try {
    await window.dafri.updateIdea(id, status);
    await loadIdeas();
  } catch (err) {
    showBanner(`更新想法失败:${err.message}`, false);
  }
}

async function addIdea() {
  const input = $('idea-input');
  const text = input.value.trim();
  if (!text) return;
  try {
    await window.dafri.addIdea(text);
    input.value = '';
    state.ideaFilter = 'active';
    syncIdeaFilterButtons();
    await loadIdeas();
  } catch (err) {
    showBanner(`记录想法失败:${err.message}`, false);
  }
}

function syncIdeaFilterButtons() {
  $('btn-ideas-active').className = state.ideaFilter === 'active' ? 'seg active' : 'seg';
  $('btn-ideas-all').className = state.ideaFilter === 'all' ? 'seg active' : 'seg';
}

// ---- 想法知识总结:归档不是丢弃,攒起来的想法能一键提炼成知识,总结历史落库可回看
async function loadIdeaDigests() {
  try {
    const { digests } = await window.dafri.listIdeaDigests();
    state.ideaDigests = digests || [];
    renderIdeaDigests();
  } catch (err) {
    console.warn('读取知识总结失败', err);
  }
}

function renderIdeaDigests() {
  const box = $('idea-digest-box');
  clear(box);
  const digests = state.ideaDigests || [];
  if (!digests.length) return;

  const latest = digests[0];
  const d = latest.digest || {};
  const node = card('info', `知识总结 · ${d.summary || ''}`);

  const addList = (title, items) => {
    if (!items || !items.length) return;
    node.appendChild(el('div', null, title));
    const list = el('ul');
    items.forEach((item) => list.appendChild(el('li', null, item)));
    node.appendChild(list);
  };
  addList('反复出现的主题:', d.themes);
  addList('经验教训:', d.lessons);
  addList('想法质量的规律:', d.patterns);
  addList('下一步:', d.actions);

  const meta = el('div', 'card-meta');
  meta.appendChild(el('span', null, `基于 ${latest.idea_count} 条想法`));
  if (d.model) meta.appendChild(el('span', null, `模型 ${d.model}`));
  const at = el('span', null, `总结于 ${fmtTimeShort(latest.created_at)}`);
  at.title = fmtTime(latest.created_at);
  meta.appendChild(at);
  if (digests.length > 1) meta.appendChild(el('span', null, `共 ${digests.length} 次总结,新的在上`));
  meta.appendChild(el('span', null, '仅供复盘参考,不构成投资建议'));
  node.appendChild(meta);
  box.appendChild(node);
}

async function digestIdeas() {
  const button = $('btn-ideas-digest');
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '总结中…';
  try {
    await window.dafri.digestIdeas('all');   // 已归档 + 已完成一起看,规律才完整
    await loadIdeaDigests();
  } catch (err) {
    showBanner(`知识总结失败:${err.message}`, false);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}
