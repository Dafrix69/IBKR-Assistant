'use strict';
/**
 * 提醒弹窗的页面逻辑(设计:优质股追踪 §C4)。纯 DOM,不用框架——一张列表、三种按钮,犯不上拉一个 React。
 *
 * 内容全部来自行情和用户填的标的:只用 createElement + textContent 拼节点,任何字符串都不当标记解析。
 * 主进程已经逐字段清洗过一遍,这里仍按"不可信"处理——弹窗页不该依赖上游永远正确。
 */
(() => {
  const api = window.dafriPopup;
  const root = document.getElementById('app');
  const list = document.getElementById('list');
  const countEl = document.getElementById('count');
  const clearBtn = document.getElementById('clear-all');
  if (!api || !root || !list || !countEl || !clearBtn) return;

  const TONES = new Set(['up', 'down', 'info']);
  // 上一次画过的 id:只有新进来的那几条闪一下,关掉一条引起的重画不该让其余的再闪
  let seen = new Set();
  /**
   * 列表刚换过顺序 / 条数,这段时间里的点击一律不认。
   * 关一条要走一圈主进程再回来重画,新提醒又是插在最前面的——指针底下那张卡片随时会换成另一只股票,
   * 手已经按下去了才发现关错、看错的,只能怪这一下点得太快。300ms 大约是"眼睛看见了变化"的量级。
   */
  const CLICK_GUARD_MS = 300;
  /**
   * 只是少了几条(用户自己关的)引起的上移,护得短一些:只为吞掉手滑双击的第二下。
   * 这里不能再用 300ms,更不能看 event.detail——一条条连点「×」清列表时,下一张卡的「×」正好滑到指针底下,
   * 浏览器把同一位置的连点一路记成 detail = 2、3、4……按"第几下"拦,只要点得够快就一条也关不掉。
   */
  const DISMISS_GUARD_MS = 150;
  let guardUntil = 0;
  let lastOrder = '';

  const pad2 = (n) => String(n).padStart(2, '0');

  function clock(ms) {
    const d = new Date(typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now());
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  /** title 形如「RKLB 5分钟放量 6.3×」:代码已经单独加粗,胶囊里只放后半截(类型 + 数值)。 */
  function tagText(item) {
    const title = String(item.title || '');
    const symbol = String(item.symbol || '');
    if (symbol && title.startsWith(`${symbol} `)) return title.slice(symbol.length + 1);
    return title === symbol ? '' : title;
  }

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = String(text);
    return el;
  }

  function button(className, text, action, label) {
    const el = node('button', className, text);
    el.type = 'button';
    el.dataset.action = action;
    el.title = label;
    el.setAttribute('aria-label', label);
    return el;
  }

  function renderItem(item, fresh) {
    const tone = TONES.has(item.tone) ? item.tone : 'info';
    const li = node('li', `item tone-${tone}${fresh ? ' is-new' : ''}`);
    li.dataset.id = String(item.id);

    const top = node('div', 'item-top');
    if (item.symbol) top.append(node('span', 'sym', item.symbol));
    const tag = tagText(item);
    if (tag) top.append(node('span', `tag ${tone}`, tag));
    top.append(node('span', 'spacer'));
    top.append(node('span', 'time', clock(item.at)));
    top.append(button('close', '×', 'dismiss', '关闭这条提醒'));

    const bottom = node('div', 'item-bottom');
    bottom.append(node('p', 'body', item.body));
    const where = item.page === 'sectors' ? '板块页' : '优质股页';
    bottom.append(button('view', '查看', 'open', `回主窗口的${where}查看`));

    li.append(top, bottom);
    return li;
  }

  function render(payload) {
    const raw = payload && Array.isArray(payload.items) ? payload.items : [];
    const items = raw.filter((it) => it && typeof it === 'object' && it.id);
    document.documentElement.dataset.updown = payload && payload.updown === 'red-up' ? 'red-up' : 'green-up';
    countEl.textContent = `${items.length} 条`;

    const next = new Set();
    const order = [];
    const nodes = items.map((item) => {
      const id = String(item.id);
      next.add(id);
      order.push(id);
      return renderItem(item, !seen.has(id));
    });
    list.replaceChildren(...nodes);
    const grew = order.some((id) => !seen.has(id));
    seen = next;

    // 顺序或条数变了 = 指针底下的卡片可能已经不是刚才那张:护一小会儿。
    // 有新卡片插进来的护足 300ms;只是少了几条的是用户自己刚关的,短护一下就放行(只延不缩)
    const key = order.join('\n');
    if (key !== lastOrder) guardUntil = Math.max(guardUntil, Date.now() + (grew ? CLICK_GUARD_MS : DISMISS_GUARD_MS));
    lastOrder = key;

    reportSize();
  }

  /**
   * 报"内容本身"的高度,而不是 documentElement.scrollHeight:后者至少等于当前窗口高度,
   * 关掉几条之后窗口就再也缩不回去。每次重画都报——主进程要靠这一下决定何时露面。
   */
  function reportSize() {
    api.size(Math.ceil(root.getBoundingClientRect().height));
  }

  list.addEventListener('click', (event) => {
    if (Date.now() < guardUntil) return; // 刚重排过,等这一眼看清了再说
    const target = event.target;
    const btn = target instanceof Element ? target.closest('button[data-action]') : null;
    if (!btn) return;
    // 「查看」双击的第二下不认:第一下已经把这张卡关掉,后面的整体上移,第二下会把主窗口带到别的股票上。
    // 「×」不看这个数:连点清列表是正经用法(见 DISMISS_GUARD_MS),手滑双击由那段短护窗吞掉
    if (btn.dataset.action === 'open' && event.detail > 1) return;
    const li = btn.closest('li.item');
    const id = li ? li.dataset.id : '';
    if (!id) return;
    if (btn.dataset.action === 'dismiss') api.dismiss(id);
    else if (btn.dataset.action === 'open') api.open(id);
  });

  clearBtn.addEventListener('click', () => api.clear());

  api.onItems(render);
  api.ready();
})();
