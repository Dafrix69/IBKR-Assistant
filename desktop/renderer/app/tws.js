'use strict';
// TWS 连接检测

// ======================================================================
// TWS 连接检测
// ======================================================================
async function scanTws() {
  const appsBox = $('tws-apps');
  const portsBox = $('tws-ports');
  try {
    const scan = await window.dafri.scanTws();
    renderApps(scan.apps);
    renderPorts(scan.ports, scan.connected);
    renderGuide(scan.guide);
  } catch (err) {
    empty(appsBox, `检测失败:${err.message}`);
    empty(portsBox, '—');
  }
}

function renderApps(apps) {
  const box = $('tws-apps');
  clear(box);
  for (const app of apps) {
    const kind = app.running ? 'ok' : app.installed ? 'warn' : 'bad';
    const stateText = app.running
      ? '正在运行'
      : app.installed
        ? '已安装,未运行'
        : '未安装(请从 IBKR 官网下载)';
    const node = card(kind, app.name, stateText, app.paths.length ? [app.paths[0]] : []);

    if (app.installed && !app.running) {
      const btn = el('button', 'btn tiny', `启动 ${app.name}`);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await window.dafri.launchTws(app.key);
          pushNotification(`已启动 ${app.name}`, '请在它自己的窗口里登录');
          setTimeout(scanTws, 4000);
        } catch (err) {
          showBanner(`启动失败:${err.message}`, false);
        } finally {
          btn.disabled = false;
        }
      });
      node.appendChild(btn);
    }
    box.appendChild(node);
  }
}

function renderPorts(ports, connected) {
  renderPortsInto($('tws-ports'), ports, connected);
}

// 端口栅格和指引两家券商长得一样,只是数据来源不同——共用一份渲染,
// 免得改了 TWS 那边、富途这边悄悄长成另一个样子。
function renderPortsInto(box, ports, connected) {
  clear(box);
  for (const port of ports) {
    const node = el('div', `port ${port.open ? 'open' : 'closed'}`);
    node.appendChild(el('div', 'port-num', String(port.port)));
    node.appendChild(el('div', 'port-label', port.label));
    node.appendChild(
      el(
        'div',
        `port-state ${port.open ? 'open' : 'closed'}`,
        port.open ? `开放 · ${port.latency_ms ?? '?'} ms` : port.error || '未监听'
      )
    );
    if (port.configured_as) {
      const badge = el('span', 'port-badge', `配置为${{ live: '实盘', paper: '模拟' }[port.configured_as] || port.configured_as}`);
      if ((connected || []).includes(port.configured_as)) badge.textContent += ' · 已连接';
      node.appendChild(badge);
    }
    box.appendChild(node);
  }
}

function renderGuide(steps) {
  renderGuideInto($('tws-guide'), steps);
}

function renderGuideInto(box, steps) {
  clear(box);
  for (const step of steps || []) {
    const li = el('li');
    li.appendChild(el('strong', null, step.title));
    li.appendChild(el('span', null, step.detail));
    box.appendChild(li);
  }
}

async function diagnoseTws() {
  const box = $('tws-diagnosis');
  const restore = busy($('btn-tws-diagnose'));
  working(box, '正在握手…(首次连接 TWS 会弹确认框,点 Yes)');
  try {
    const { results } = await window.dafri.diagnoseTws();
    clear(box);
    for (const result of results) {
      box.appendChild(renderDiagnosis(result));
    }
  } catch (err) {
    empty(box, `诊断失败:${err.message}`);
  } finally {
    restore();
  }
}

function renderDiagnosis(result) {
  const kind = result.connected && !result.error ? 'ok' : result.connected ? 'warn' : 'bad';
  const title = `连接 ${result.connection} · ${result.host}:${result.port}`;
  const node = card(kind, title, result.connected ? '握手成功' : '未连接');

  if (result.connected) {
    const meta = el('div', 'card-meta');
    meta.appendChild(el('span', null, `服务器版本 ${result.server_version ?? '—'}`));
    meta.appendChild(el('span', null, `clientId ${result.client_id}`));
    if (result.port_latency_ms !== null && result.port_latency_ms !== undefined) {
      meta.appendChild(el('span', null, `${result.port_latency_ms} ms`));
    }
    node.appendChild(meta);
  }

  if (result.error) node.appendChild(el('div', 'reason', result.error));
  if (result.hint) {
    const hint = el('div', null, result.hint);
    hint.style.marginTop = '6px';
    node.appendChild(hint);
  }

  if (result.accounts && result.accounts.length) {
    const list = el('div');
    list.style.marginTop = '8px';
    for (const account of result.accounts.filter((a) => a.connection === result.connection)) {
      const row = el('div', 'acct-row');
      const left = el('span', null, `${account.alias} → ${account.account_masked}`);
      row.appendChild(left);
      row.appendChild(
        el(
          'span',
          account.resolved ? 'acct-ok' : 'acct-bad',
          account.resolved ? '✓ 对得上' : '✗ 不在可管账户里'
        )
      );
      list.appendChild(row);
    }
    if (list.children.length) node.appendChild(list);
  }
  return node;
}
