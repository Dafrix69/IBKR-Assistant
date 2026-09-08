'use strict';
/**
 * 界面逻辑。刻意不用任何框架:CSP 只允许 'self',不加载任何远程脚本。
 *
 * 一条硬规则:**任何来自引擎/模型/用户的文本都只用 textContent 写进 DOM**,
 * 绝不拼 innerHTML。指令原文和模型输出都是不可信内容,界面不该成为它的执行面。
 */

const $ = (id) => document.getElementById(id);

/** 建元素的小工具,天然只走 textContent。 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function empty(node, message) {
  clear(node);
  node.appendChild(el('p', 'empty', message));
}

/** 定点小数,不带千分位——量表里要看清 0.0500 这种小数。 */
function fmtNum(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function fmtMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 列表里的紧凑时间:今天只显示时分,其余显示月-日 时分。年份在这里没有信息量。 */
function fmtTimeShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear()
    && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (sameDay) return hm;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN', { hour12: false });
}

const state = {
  status: null,
  settings: null,
  records: [],
  ideas: [],
  ideaFilter: 'active',
  sectors: [],
  sectorQuotes: {},
  connected: false,
  breakerEngaged: false,
  busy: false,
};

// ======================================================================
// 通知流
// ======================================================================
function pushNotification(title, body) {
  const feed = $('notifications');
  if (feed.querySelector('.empty')) clear(feed);
  const item = el('div', 'feed-item');
  const time = el('time', null, new Date().toLocaleTimeString('zh-CN', { hour12: false }));
  item.appendChild(time);
  item.appendChild(el('span', null, `${title}${body ? ' · ' + body : ''}`));
  feed.insertBefore(item, feed.firstChild);
  while (feed.children.length > 60) feed.removeChild(feed.lastChild);
}
