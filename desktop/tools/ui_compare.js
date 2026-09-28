// 界面对比:升级界面框架 / 组件库 / 构建工具之后,证明"界面没变"。
//
//   node tools/ui_compare.js <预览目录> [<预览目录> …]     → 在每个目录里写一份 ui-compare.js
//
// 用法(沙箱里起不了 Electron、capture_pages.js 用不上的时候):
//   1. 改动前后各 `npm run ui:preview` 一次,产物(renderer-react/dist-preview)分别拷到同一个父目录下,
//      比如 /tmp/ui/before 与 /tmp/ui/after;换场景就换目录里的 mock-bridge.js(empty / stress 那两份)。
//   2. `node tools/ui_compare.js /tmp/ui/before /tmp/ui/after`,再在父目录起一个静态服务
//      (`python3 -m http.server 5199 --bind 127.0.0.1`)。必须是同一个源:快照存在 localStorage 里,两份构建要读得到同一份。
//   3. 浏览器窗口固定一个尺寸(1360×900),先开 before:清掉 localStorage、刷新,然后在控制台里
//        const s = document.createElement('script'); s.src = './ui-compare.js'; document.head.appendChild(s);
//        await __ui.capture('before');  await __ui.captureOverlays('before-ov');
//      再开 after,做同样的事(标签换成 after),最后
//        __ui.compare('before', 'after');  __ui.compare('before-ov', 'after-ov');
//   4. 条款同意页另采:地址后面加 ?consent=0,`await __ui.captureConsent('before')`。
//
// 每个状态记两样:
//   · 带文字的元素——文字、内容区的左边与纵向中线、字号、字重、颜色、字体;
//   · 看得见的盒子——有底色、边框或投影(box-shadow / filter)的元素,外加输入框的内容区、图标、画布。
//     盒子按位置与样式配对,不看 DOM 结构:组件库换了内部结构也比得出来。
// 被祖先裁掉的、透明的、空的输入框不记——它们占着位置但什么都不画。
//
// 比不出来的:悬停态(要真的把鼠标移上去,再用 __ui.dump 看)、字体渲染、titleBarOverlay、Windows 的缩放。
// 这个办法能证明"没变",不能代替真机上看一眼。经过与口径见 docs/features/dependencies.md「界面升级怎么验证」。
'use strict';
/* global window, document, getComputedStyle, NodeFilter, MouseEvent, PointerEvent, KeyboardEvent, HTMLInputElement, HTMLTextAreaElement */
const fs = require('node:fs');
const path = require('node:path');

/** 各页的演示动作:取自 capture_pages.js 的 DEMO,不另抄一份。那边是字符串(Electron 直接执行),页面里不许 eval,这里转成函数。 */
function demoActions() {
  const src = fs.readFileSync(path.join(__dirname, 'capture_pages.js'), 'utf8');
  const start = src.indexOf('const DEMO = {');
  const end = src.indexOf('};', start);
  if (start < 0 || end < 0) throw new Error('capture_pages.js 里找不到 DEMO');
  const demo = new Function(`return ${src.slice(start + 'const DEMO = '.length, end + 1)}`)();
  return `{${Object.entries(demo).map(([tab, code]) => `${JSON.stringify(tab)}: () => { ${code} }`).join(',\n')}}`;
}

/** 在页面里跑的那一份。整个函数体被原样写进 ui-compare.js,不引用这个文件里的任何东西。 */
function inPage(DEMO) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const R = Math.round;
  const clear = (color) => color === 'rgba(0, 0, 0, 0)' || color === 'transparent' || /\/ 0\)$/.test(color);
  const classOf = (el) => (el.className.baseVal ?? el.className ?? '').toString();

  // 面板不在前台时浏览器不给 requestAnimationFrame 排帧:组件库的进出场动效停在起步、canvas 图画不出来。
  // 采集期间换成定时器版的;两份构建用的是同一套,不影响对比。
  const frames = new Map();
  let frameSeq = 1;
  window.requestAnimationFrame = (cb) => {
    const id = frameSeq++;
    frames.set(id, setTimeout(() => { frames.delete(id); cb(performance.now()); }, 16));
    return id;
  };
  window.cancelAnimationFrame = (id) => { clearTimeout(frames.get(id)); frames.delete(id); };

  /** 只要终态:过渡与动画一律关掉。页面给动态创建的 <style> 都补了 nonce(main.tsx),所以这一条过得了 CSP */
  function still() {
    if (document.getElementById('ui-compare-still')) return;
    const style = document.createElement('style');
    style.id = 'ui-compare-still';
    style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }';
    document.head.appendChild(style);
  }

  /** 动画关掉之后,组件库里靠 transitionend / animationend 收尾的进出场动效会卡在半路:替它把结束事件发了 */
  function finishMotions() {
    for (const el of document.querySelectorAll('[class*="-leave"], [class*="-enter"], [class*="-appear"]')) {
      for (const type of ['transitionend', 'animationend']) el.dispatchEvent(new Event(type, { bubbles: true }));
    }
  }
  const busy = () => [...document.querySelectorAll('.ant-btn-loading, .ant-spin-spinning, .ant-skeleton-active, [class*="-motion-"], [class*="-leave"], [class*="-enter"], [class*="-appear"]')]
    .some((el) => el.getBoundingClientRect().width > 0);

  function resetView() {
    window.scrollTo(0, 0);
    const content = document.querySelector('#root .content');
    if (content) content.scrollTop = 0;
  }

  /** 连着两次采到的一样、没有在转的东西,才算稳了。最多等 7 秒 */
  async function settle(keepFocus) {
    let prev = '';
    for (let i = 0; i < 24; i++) {
      if (!keepFocus) { resetView(); if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); }
      finishMotions();
      await sleep(300);
      const cur = JSON.stringify(snap());
      if (cur === prev && !busy()) return true;
      prev = cur;
    }
    return false;
  }

  /** 最近的组件类名(ant-xxx)与自家类名:报差异时说得出是哪个组件、在哪一块 */
  function componentOf(el) {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const hit = classOf(p).split(' ').find((c) => /^ant-/.test(c) && !/css-var|-(sm|lg|small|large|middle|medium|outlined|filled|borderless|ltr|rtl)$/.test(c));
      if (hit) return hit;
    }
    return '-';
  }
  function placeOf(el) {
    const out = [];
    for (let p = el, i = 0; p && p !== document.body && i < 3; i++, p = p.parentElement) {
      const own = classOf(p).split(' ').filter((c) => c && !/^ant-|^dafri$|^css-/.test(c)).slice(0, 2).join('.');
      if (own) out.push(own);
    }
    return out.join('<') || '-';
  }

  function clipped(el, rect) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const pr = p.getBoundingClientRect();
      if (pr.height < 0.5 || pr.width < 0.5 || rect.bottom <= pr.top + 0.5 || rect.top >= pr.bottom - 0.5 || rect.right <= pr.left + 0.5 || rect.left >= pr.right - 0.5) return true;
    }
    return false;
  }

  /** 当前页面(或其中一块)的一份快照:{ text: [...], box: [...], h } */
  function snap(root = document.body) {
    const text = [];
    const box = [];
    const seen = {};
    const sy = window.scrollY;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      const r = el.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      if (clipped(el, r)) continue;
      const tag = el.tagName.toLowerCase();

      let own = '';
      for (const node of el.childNodes) if (node.nodeType === 3) own += node.textContent;
      own = own.trim().replace(/\s+/g, ' ').slice(0, 40);
      // 带时分的文字(「上次检查 18:08:44」)每次都不一样,不记
      if (own && !/\d\d:\d\d/.test(own)) {
        const base = `${own}<${['td', 'th'].includes(tag) ? tag : ''}>`;
        seen[base] = (seen[base] || 0) + 1;
        // 横向用内容区的左边、纵向用中线:组件把内边距从里层挪到外层、把"行高撑满"换成"弹性居中"时,字没动
        const left = cs.display === 'inline' ? 0 : parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
        text.push([`${base}#${seen[base]}`, R(r.x + left), R(r.y + sy + r.height / 2), cs.fontSize, cs.fontWeight, cs.color, cs.fontFamily.slice(0, 24), cs.textDecorationLine, componentOf(el), placeOf(el)]);
      }

      const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(parseFloat);
      const colors = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];
      const hasBorder = cs.borderTopStyle !== 'none' && bw.some((w, i) => w > 0 && !clear(colors[i]));
      const hasBg = !clear(cs.backgroundColor) || cs.backgroundImage !== 'none';
      const hasFilter = Boolean(cs.filter) && cs.filter !== 'none';
      const hasShadow = cs.boxShadow !== 'none' || hasFilter;

      if (tag === 'input' || tag === 'textarea') {
        // 空的、没有占位字的输入框自己什么都不画(框是外层的盒子)
        if (el.value || el.placeholder) {
          const pl = parseFloat(cs.paddingLeft) + bw[3];
          const pr = parseFloat(cs.paddingRight) + bw[1];
          const pt = parseFloat(cs.paddingTop) + bw[0];
          const pb = parseFloat(cs.paddingBottom) + bw[2];
          box.push(['input', R(r.x + pl), R(r.y + sy + pt), R(r.width - pl - pr), R(r.height - pt - pb), `${cs.fontSize} ${cs.color} ${cs.textAlign}`, (el.value || el.placeholder).slice(0, 20), '', '', componentOf(el), placeOf(el)]);
        }
      } else if (tag === 'svg' || tag === 'canvas' || tag === 'img') {
        box.push([tag === 'svg' ? 'icon' : tag, R(r.x), R(r.y + sy), R(r.width), R(r.height), cs.color, cs.fill, '', '', componentOf(el), placeOf(el)]);
      }
      if (hasBorder || hasBg || hasShadow) {
        box.push(['box', R(r.x), R(r.y + sy), R(r.width), R(r.height),
          hasBg ? cs.backgroundColor + (cs.backgroundImage !== 'none' ? ' img' : '') : '-',
          hasBorder ? `${bw.join('/')} ${cs.borderTopColor}|${cs.borderBottomColor}` : '-',
          cs.borderRadius,
          hasShadow ? cs.boxShadow.slice(0, 70) + (hasFilter ? ` filter ${cs.filter.slice(0, 60)}` : '') : '-',
          componentOf(el), placeOf(el)]);
      }
    }
    return { text, box, h: document.documentElement.scrollHeight };
  }

  const load = (tag) => JSON.parse(localStorage.getItem(`ui-snap-${tag}`) || '{}');
  const save = (tag, states) => localStorage.setItem(`ui-snap-${tag}`, JSON.stringify(states));

  function setInput(id, value) {
    const el = document.getElementById(id);
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  /** 顶栏的「新版本」胶囊启动 30 秒后才出现,出现之后顶栏整体挪位:等它出来再开始采(没有这回事的场景传 wait: false) */
  async function waitUpdatePill() {
    for (let i = 0; i < 45; i++) {
      if (document.querySelector('.update-pill')) return true;
      await sleep(1000);
    }
    return false;
  }

  /**
   * 每个叶子页采一遍:默认态;把收着的参考资料(Primer)都点开之后(<页>+open);做完演示动作之后(<页>+demo)。
   * 采之前要清掉界面记住的状态(localStorage 里除 ui-snap-* 之外的键)并刷新,两份构建才是同一个起点。
   */
  async function capture(tag, { only = null, wait = true } = {}) {
    still();
    await sleep(300);
    if (wait) await waitUpdatePill();
    const states = load(tag);
    const unsettled = [];
    const shot = async (name) => {
      if (!(await settle(false))) unsettled.push(name);
      resetView();
      states[name] = snap();
    };
    for (const tab of (window.__dafriLeafTabs || []).filter((t) => !only || only.includes(t))) {
      window.__dafriNavigate(tab);
      await sleep(900);
      if (tab === 'market') {
        const symbol = document.getElementById('pa-symbol');
        if (symbol && !symbol.value) setInput('pa-symbol', 'NVDA');
        const run = document.getElementById('btn-pa-run');
        if (run) run.click();
        await sleep(2500);
      }
      await shot(tab);
      const closed = [...document.querySelectorAll('.primer .ant-collapse-item:not(.ant-collapse-item-active) > .ant-collapse-header')];
      if (closed.length) {
        for (const header of closed) { header.click(); await sleep(150); }
        await sleep(600);
        await shot(`${tab}+open`);
      }
      if (DEMO[tab]) {
        DEMO[tab]();
        await sleep(1500);
        await shot(`${tab}+demo`);
      }
    }
    save(tag, states);
    return { states: Object.keys(states).length, unsettled };
  }

  function fire(el, types) {
    const r = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
    for (const type of types) el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerType: 'mouse' }) : new MouseEvent(type, init));
  }
  async function closeAll() {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    fire(document.body, ['pointerdown', 'mousedown', 'mouseup', 'click']);
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    await sleep(500);
    finishMotions();
    await sleep(300);
  }

  /** 弹层与聚焦态:下拉框、日期选择器、提示气泡、分享卡片对话框,指令框 / 数字输入框 / 下拉框拿到焦点时 */
  async function captureOverlays(tag) {
    still();
    const states = {};
    const opened = {};
    const shot = async (name) => { await settle(true); states[name] = snap(); };

    window.__dafriNavigate('backtest');
    await sleep(1200);
    const select = document.querySelector('#page-backtest .ant-select') || document.querySelector('.ant-select');
    if (select) {
      const target = select.querySelector('.ant-select-selector') || select;
      fire(target, ['pointerdown', 'mousedown']);
      fire(target, ['pointerup', 'mouseup', 'click']);
      await sleep(800);
      opened.select = Boolean(document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)'));
      await shot('ov-select');
      await closeAll();
    }
    const picker = document.querySelector('.ant-picker');
    if (picker) {
      const input = picker.querySelector('input');
      fire(input, ['pointerdown', 'mousedown']);
      input.focus();
      fire(input, ['pointerup', 'mouseup', 'click']);
      await sleep(900);
      opened.picker = Boolean(document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)'));
      await shot('ov-picker');
      await closeAll();
    }

    window.__dafriNavigate('trade');
    await sleep(1000);
    const leaf = [...document.querySelectorAll('.topbar *')].find((e) => e.children.length === 0 && /已连接|未连接/.test(e.textContent));
    const host = leaf ? leaf.closest('.chip, .status-chip, span, div') : null;
    if (host) {
      fire(host, ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']);
      await sleep(900);
      opened.tooltip = Boolean(document.querySelector('.ant-tooltip:not(.ant-tooltip-hidden)'));
      // 气泡不走 settle:替进出场动效补发结束事件时,它偶尔会被一并收起来
      states['ov-tooltip'] = snap();
      fire(host, ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']);
      await closeAll();
    }

    const focusShot = async (el, name) => {
      if (!el) return;
      el.focus();
      await sleep(300);
      await shot(name);
      el.blur();
    };
    await focusShot(document.getElementById('instruction'), 'focus-textarea');
    window.__dafriNavigate('settings');
    await sleep(1200);
    await focusShot(document.querySelector('.ant-input-number input'), 'focus-number');
    window.__dafriNavigate('backtest');
    await sleep(1200);
    await focusShot(document.querySelector('#page-backtest .ant-select input'), 'focus-select');
    await closeAll();

    window.__dafriNavigate('performance');
    await sleep(2000);
    const share = [...document.querySelectorAll('button')].find((b) => /分享/.test(b.textContent));
    if (share) {
      share.click();
      await sleep(1200);
      opened.modal = Boolean(document.querySelector('.ant-modal'));
      await shot('ov-modal-share');
      const close = document.querySelector('.ant-modal-close');
      if (close) close.click();
      await closeAll();
    }
    save(tag, states);
    return { states: Object.keys(states).length, opened };
  }

  /** 条款同意页(地址带 ?consent=0):只记对话框里面的,背后那一页此刻在不在加载不归这里管 */
  async function captureConsent(tag) {
    still();
    await sleep(2500);
    const states = load(tag);
    const inside = () => {
      const modal = document.querySelector('.ant-modal');
      if (!modal) return snap();
      return { ...snap(modal), h: R(modal.getBoundingClientRect().height) };
    };
    await settle(true);
    states.consent = inside();
    const tabs = [...document.querySelectorAll('.ant-tabs-tab')];
    for (let i = 1; i < tabs.length; i++) {
      tabs[i].click();
      await sleep(600);
      await settle(true);
      states[`consent-tab${i + 1}`] = inside();
    }
    save(tag, states);
    return { states: Object.keys(states).length, modal: Boolean(document.querySelector('.ant-modal')), tabs: tabs.length };
  }

  const near = (a, b, tol) => [1, 2, 3, 4].every((i) => Math.abs(a[i] - b[i]) <= tol);

  /**
   * 两份快照逐个状态比。位置差 1px 以内算一样。每个状态只报最靠上的几处(per):
   * 上面的东西高度变了,下面的全跟着移——先修最上面那一处,再比。
   */
  function compare(a, b, { tol = 1, per = 4, only = null, width = 220 } = {}) {
    const A = load(a);
    const B = load(b);
    const out = {};
    let identical = 0;
    for (const state of Object.keys(A)) {
      if (only && !only.includes(state)) continue;
      const sa = A[state];
      const sb = B[state];
      if (!sb) { out[state] = `${b} 里没有这个状态`; continue; }
      const diffs = [];

      const newer = new Map(sb.text.map((row) => [row[0], row]));
      const older = new Set(sa.text.map((row) => row[0]));
      for (const ra of sa.text) {
        const rb = newer.get(ra[0]);
        if (!rb) { diffs.push([ra[2], ra[1], `text gone: ${ra[0]} @${ra[1]},${ra[2]} [${ra[8]} ${ra[9]}]`]); continue; }
        const d = [];
        if (Math.abs(ra[1] - rb[1]) > tol) d.push(`x ${ra[1]}→${rb[1]}`);
        if (Math.abs(ra[2] - rb[2]) > tol) d.push(`y ${ra[2]}→${rb[2]}`);
        ['size', 'weight', 'color', 'font', 'deco'].forEach((name, i) => { if (ra[i + 3] !== rb[i + 3]) d.push(`${name} ${ra[i + 3]}→${rb[i + 3]}`); });
        if (d.length) diffs.push([ra[2], ra[1], `text ${ra[0]}: ${d.join(', ')} [${rb[8]} ${rb[9]}]`]);
      }
      for (const rb of sb.text) if (!older.has(rb[0])) diffs.push([rb[2], rb[1], `text new: ${rb[0]} @${rb[1]},${rb[2]} [${rb[8]} ${rb[9]}]`]);

      const describe = (row) => (row[0] === 'box' ? `${row[5]} ${row[6]} r${row[7]} sh ${row[8]}` : row[5]);
      const rest = sb.box.slice();
      for (const ra of sa.box) {
        const exact = rest.findIndex((rb) => rb[0] === ra[0] && near(ra, rb, tol) && [5, 6, 7, 8].every((i) => ra[i] === rb[i]));
        if (exact >= 0) { rest.splice(exact, 1); continue; }
        const same = rest.findIndex((rb) => rb[0] === ra[0] && near(ra, rb, tol));
        if (same >= 0) {
          const rb = rest[same];
          rest.splice(same, 1);
          const names = ra[0] === 'box' ? ['bg', 'border', 'radius', 'shadow'] : ['style', 'value', '', ''];
          const d = [5, 6, 7, 8].filter((i) => ra[i] !== rb[i]).map((i) => `${names[i - 5]} ${ra[i]}→${rb[i]}`);
          diffs.push([ra[2], ra[1], `${ra[0]} @${ra.slice(1, 5).join(',')}: ${d.join(', ')} [${rb[9]} ${rb[10]}]`]);
          continue;
        }
        diffs.push([ra[2], ra[1], `${ra[0]} gone @${ra.slice(1, 5).join(',')} ${describe(ra)} [${ra[9]} ${ra[10]}]`]);
      }
      for (const rb of rest) diffs.push([rb[2], rb[1], `${rb[0]} new @${rb.slice(1, 5).join(',')} ${describe(rb)} [${rb[9]} ${rb[10]}]`]);

      if (!diffs.length && sa.h === sb.h) { identical += 1; continue; }
      diffs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      out[state] = { n: diffs.length, h: sa.h === sb.h ? 'same' : `${sa.h}→${sb.h}`, first: diffs.slice(0, per).map((d) => d[2].slice(0, width)) };
    }
    return { identical, differing: Object.keys(out).length, out };
  }

  /** 一个元素往下几层:类名、位置、几样计算出来的样式。查"这一块在新版里长什么样"用 */
  function dump(target, depth = 4, props = ['color', 'backgroundColor', 'fontWeight', 'fontSize', 'borderTopColor', 'borderRadius', 'padding', 'margin']) {
    const root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!root) return [`(没有 ${target})`];
    const out = [];
    const walk = (el, d) => {
      if (d > depth) return;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const cls = classOf(el).split(' ').filter(Boolean).slice(0, 7).join('.');
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('').slice(0, 16);
      const styles = props.map((p) => `${p}=${cs[p]}`).filter((s) => !/=(0px|normal|none|rgba\(0, 0, 0, 0\))$/.test(s)).join(' ');
      out.push(`${'  '.repeat(d)}${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${own ? ` "${own}"` : ''} [${R(r.x)},${R(r.y)} ${R(r.width)}x${R(r.height)}] ${styles}`);
      for (const child of el.children) walk(child, d + 1);
    };
    walk(root, 0);
    return out;
  }

  /** 哪几条规则在给这个元素定这几样属性:自家的(ours)还是组件库注入的(antd)。查"为什么我那条没生效"用 */
  function rulesFor(el, props) {
    const out = [];
    const walk = (rules, origin) => {
      for (const rule of rules) {
        if (rule.cssRules && rule.type !== 1) { walk(rule.cssRules, origin); continue; }
        if (rule.type !== 1) continue;
        let hit = false;
        try { hit = el.matches(rule.selectorText.replace(/::?(before|after)/g, '')); } catch { hit = false; }
        if (!hit) continue;
        for (const prop of props) {
          const value = rule.style.getPropertyValue(prop);
          if (value) out.push(`${origin} | ${rule.selectorText.slice(0, 140)} { ${prop}: ${value}${rule.style.getPropertyPriority(prop) ? ' !important' : ''} }`);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      walk(rules, sheet.href ? 'ours' : 'antd');
    }
    return out;
  }

  /** 清掉界面记住的状态(快照留着)。清完要刷新页面 */
  function fresh() {
    let n = 0;
    for (const key of Object.keys(localStorage)) if (!/^ui-snap-/.test(key)) { localStorage.removeItem(key); n += 1; }
    try { sessionStorage.clear(); } catch { /* 预览台的 data: 页面没有 sessionStorage */ }
    return n;
  }
  const forget = () => { for (const key of Object.keys(localStorage)) if (/^ui-snap-/.test(key)) localStorage.removeItem(key); };

  /** 采集要一两分钟,控制台之外的调用方(自动化)等不了那么久:后台跑,跑完结果在 __ui.job 里 */
  function start(what, ...args) {
    window.__ui.job = { done: false };
    const run = { capture, captureOverlays, captureConsent }[what];
    run(...args).then((result) => { window.__ui.job = { done: true, ...result }; }, (err) => { window.__ui.job = { done: true, error: String((err && err.stack) || err) }; });
    return 'started';
  }

  window.__ui = { capture, captureOverlays, captureConsent, compare, snap, dump, rulesFor, fresh, forget, start, job: null };
}

function build() {
  return `// 由 desktop/tools/ui_compare.js 生成,不进仓库。\n(${inPage.toString()})(${demoActions()});\n`;
}

if (require.main === module) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error('用法:node tools/ui_compare.js <预览目录> [<预览目录> …]');
    process.exit(1);
  }
  const script = build();
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(dir, 'index.html'))) {
      console.error(`${dir} 里没有 index.html:先 npm run ui:preview,再把 renderer-react/dist-preview 拷过去`);
      process.exit(1);
    }
    fs.writeFileSync(path.join(dir, 'ui-compare.js'), script);
    console.log(`已写入 ${path.join(dir, 'ui-compare.js')}`);
  }
}

module.exports = { build, demoActions };
