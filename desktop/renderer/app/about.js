'use strict';
// 关于与快捷键

// ======================================================================
// 关于
// ======================================================================
// 注册在案的快捷键。别在这里编不存在的——列表本身就是承诺。
const SHORTCUTS = [
  { keys: ['mod', 'Enter'], what: '解析当前指令(不发送)' },
  { keys: ['mod', 'Shift', 'Enter'], what: '解析并发送(有确认框)' },
  { keys: ['mod', 'Shift', 'H'], what: '暂停全部自动执行(熔断)' },
  { keys: ['mod', 'R'], what: '刷新状态' },
  { keys: ['Esc'], what: '收起打开的记录详情' },
  { keys: ['↑', '↓'], what: '侧栏导航移动(焦点在侧栏时)' },
  { keys: ['mod', '1 ~ 9'], what: '按侧栏顺序切换页面' },
];

function renderShortcuts() {
  const box = document.getElementById('shortcuts');
  if (!box) return;
  clear(box);
  const mod = MOD_KEY === '⌘' ? '⌘' : 'Ctrl';
  for (const item of SHORTCUTS) {
    const dt = el('dt');
    item.keys.forEach((k) => dt.appendChild(el('kbd', null, k === 'mod' ? mod : k)));
    box.appendChild(dt);
    box.appendChild(el('dd', null, item.what));
  }
}
async function loadAbout() {
  renderShortcuts();
  try {
    const [info, selftest] = await Promise.all([window.dafri.appInfo(), window.dafri.selftest()]);
    const box = $('about');
    clear(box);
    const dl = el('dl');
    const rows = [
      ['应用版本', info.version],
      ['Electron', info.electron],
      ['Chromium', info.chrome],
      ['Node', info.node],
      ['配置文件', info.configPath],
      ['提示词', `${selftest.prompt_version} · ${selftest.prompt_fingerprint}`],
      ['系统提示词', `${selftest.system_prompt_chars} 字 / ${selftest.fewshot_pairs} 组少样本`],
      ['账户', selftest.accounts.map((a) => `${a.alias}(${a.account_masked}${a.is_paper ? ' 纸面' : ' 实盘'})`).join('、')],
    ];
    for (const [key, value] of rows) {
      dl.appendChild(el('dt', null, key));
      dl.appendChild(el('dd', null, value ?? '—'));
    }
    box.appendChild(dl);
  } catch (err) {
    empty($('about'), `读取失败:${err.message}`);
  }
}
