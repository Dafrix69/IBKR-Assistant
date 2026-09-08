'use strict';
// 富途 OpenD 接入

// ======================================================================
// 富途 OpenD 接入
// ======================================================================
const BROKER_HINT = {
  ibkr: '需本机运行并登录 TWS 或 IB Gateway。支持组合单(价差 / 蝴蝶 / 铁鹰)。',
  futu: '需本机运行并登录富途 OpenD。不支持组合单,多腿结构会被拒绝。',
};

async function loadFutu() {
  await Promise.all([loadBrokerSwitch(), scanFutu()]);
}

async function loadBrokerSwitch() {
  const box = $('broker-switch');
  try {
    const catalog = await window.dafri.brokerCatalog();
    renderBrokerSwitch(catalog);
    renderTwsBrokerBanner(catalog);
    renderFutuUnlockState(catalog);
  } catch (err) {
    empty(box, `读取失败:${err.message}`);
  }
}

function renderBrokerSwitch(catalog) {
  const box = $('broker-switch');
  clear(box);
  for (const provider of catalog.providers || []) {
    const conns = Object.entries(provider.connections || {});
    const node = card(
      provider.current ? 'ok' : 'warn',
      `${provider.label}${provider.current ? ' · 当前生效' : ''}`,
      BROKER_HINT[provider.key] || ''
    );
    const meta = el('div', 'card-meta');
    meta.appendChild(
      el(
        'span',
        null,
        conns.length
          ? conns.map(([name, c]) => `${name} ${c.host}:${c.port}`).join(' · ')
          : '未配置连接'
      )
    );
    meta.appendChild(el('span', null, `${(provider.accounts || []).length} 个账户`));
    node.appendChild(meta);

    if (provider.config_snippet) {
      // 账户与连接不给界面通道(§9.6),那至少别让人去猜字段名和默认端口
      const tip = el('div', null, '尚未配置连接与账户。把下面这段并入 config/settings.json 后再切换:');
      tip.style.marginTop = '8px';
      node.appendChild(tip);
      const pre = el('pre', 'snippet', provider.config_snippet);
      node.appendChild(pre);
    } else if (!provider.current) {
      const btn = el('button', 'btn tiny', `切到${provider.label}`);
      btn.addEventListener('click', () => switchBroker(provider, btn));
      node.appendChild(btn);
    }
    box.appendChild(node);
  }
}

async function switchBroker(provider, btn) {
  // 换券商 = 换下单出口。不该点一下就生效,先把后果讲清楚
  const ok = await window.dafri.confirm({
    message: `把下单出口切到「${provider.label}」?`,
    detail:
      '现有的券商连接会先断开,选择会写进配置文件。' +
      (provider.key === 'futu' ? ' 富途不支持组合单:价差 / 蝴蝶 / 铁鹰会被引擎拒绝。' : ''),
    confirmLabel: '切换',
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    await window.dafri.selectBroker(provider.key);
    showBanner(`已切到 ${provider.label}。请在下面点「连接 / 断开交易引擎」重新连接。`, true);
    await loadBrokerSwitch();
    await refreshStatus();
  } catch (err) {
    showBanner(`切换失败:${err.message}`, false);
  } finally {
    btn.disabled = false;
  }
}

function renderTwsBrokerBanner(catalog) {
  const box = $('tws-broker-banner');
  if (!box) return;
  clear(box);
  if (catalog.current === 'ibkr') {
    box.className = 'notice';
    box.appendChild(el('strong', null, '当前券商接入:IBKR。'));
    box.appendChild(el('span', null, ' 引擎正通过此通道下单。'));
    return;
  }
  box.className = 'notice warn';
  box.appendChild(el('strong', null, '当前券商接入:富途 OpenD。'));
  box.appendChild(
    el('span', null, ' 本页仅检测 IBKR,引擎不经此下单;切换请到「富途 OpenD」页。')
  );
}

function renderFutuUnlockState(catalog) {
  const node = $('futu-unlock-state');
  if (!node) return;
  const saved = catalog.futu && catalog.futu.unlock_password_saved;
  node.textContent = saved
    ? '已存密码(md5),连接引擎后点「交易解锁」'
    : '未存密码,模拟盘不受影响,实盘单会被拦下';
}

async function scanFutu() {
  const appsBox = $('futu-apps');
  const portsBox = $('futu-ports');
  try {
    const scan = await window.dafri.scanFutu();
    renderFutuApps(scan.apps, scan.sdk_installed);
    renderPortsInto(portsBox, scan.ports, scan.connected);
    renderGuideInto($('futu-guide'), scan.guide);
  } catch (err) {
    empty(appsBox, `检测失败:${err.message}`);
    empty(portsBox, '—');
  }
}

function renderFutuApps(apps, sdkInstalled) {
  const box = $('futu-apps');
  clear(box);

  // SDK 没装的话,后面几步全都会卡在同一个地方。先把它摆在最前面,给按钮
  if (sdkInstalled === false) {
    box.appendChild(card(
      'bad',
      'futu-api(npm 包)未安装',
      '连接 OpenD 必需:在 engine-ts 目录执行 npm install,然后在「关于」里重启引擎。'
    ));
  }

  for (const app of apps || []) {
    const kind = app.running ? 'ok' : app.installed ? 'warn' : 'bad';
    const stateText = app.running
      ? '正在运行'
      : app.installed
        ? '已安装,未运行'
        : '未找到(绿色包放在非常见目录时检测不到,可手动启动)';
    const node = card(kind, app.name, stateText, app.paths.length ? [app.paths[0]] : []);

    if (app.installed && !app.running) {
      const btn = el('button', 'btn tiny', `启动 ${app.name}`);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await window.dafri.launchFutu();
          pushNotification(`已启动 ${app.name}`, '请在它自己的窗口里登录');
          setTimeout(scanFutu, 4000);
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

async function diagnoseFutu() {
  const box = $('futu-diagnosis');
  const restore = busy($('btn-futu-diagnose'));
  working(box, '正在握手…(OpenD 需已登录,否则超时)');
  try {
    const { results } = await window.dafri.diagnoseFutu();
    clear(box);
    for (const result of results) box.appendChild(renderFutuDiagnosis(result));
  } catch (err) {
    empty(box, `诊断失败:${err.message}`);
  } finally {
    restore();
  }
}

function renderFutuDiagnosis(result) {
  const kind = result.connected && !result.error ? 'ok' : result.connected ? 'warn' : 'bad';
  const title = `连接 ${result.connection} · ${result.host ?? '—'}:${result.port ?? '—'}`;
  const node = card(kind, title, result.connected ? '握手成功' : '未连接');

  if (result.connected) {
    const meta = el('div', 'card-meta');
    meta.appendChild(el('span', null, `OpenD 版本 ${result.server_version ?? '—'}`));
    meta.appendChild(el('span', null, `行情登录 ${loginText(result.qot_logined)}`));
    meta.appendChild(el('span', null, `交易登录 ${loginText(result.trd_logined)}`));
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

  const rows = (result.accounts || []).filter((a) => a.connection === result.connection);
  if (rows.length) {
    const list = el('div');
    list.style.marginTop = '8px';
    for (const account of rows) {
      const row = el('div', 'acct-row');
      row.appendChild(el('span', null, `${account.alias} → ${account.account_masked}`));
      row.appendChild(
        el(
          'span',
          account.resolved ? 'acct-ok' : 'acct-bad',
          account.resolved ? '✓ 对得上' : '✗ 不在可管账户里'
        )
      );
      list.appendChild(row);
    }
    node.appendChild(list);
  }
  return node;
}

function loginText(value) {
  if (value === true) return '已登录';
  if (value === false) return '未登录';
  return '未知';
}

async function saveFutuPassword() {
  const input = $('futu-password');
  if (!input.value) return;
  const btn = $('btn-futu-save-password');
  btn.disabled = true;
  try {
    await window.dafri.setFutuPassword(input.value, $('futu-password-md5').checked);
    input.value = '';
    await loadBrokerSwitch();
    showBanner('交易密码已写入 Keychain(只存 md5)。', true);
  } catch (err) {
    showBanner(`写入失败:${err.message}`, false);
  } finally {
    btn.disabled = false;
  }
}

async function unlockFutu() {
  const btn = $('btn-futu-unlock');
  btn.disabled = true;
  try {
    const result = await window.dafri.unlockFutu();
    const failed = Object.entries(result.failed || {}).map(([name, msg]) => `${name}(${msg})`);
    if ((result.unlocked || []).length) {
      const tail = failed.length ? `;失败:${failed.join('、')}` : '';
      showBanner(`已解锁:${result.unlocked.join('、')}${tail}`, !failed.length);
    } else {
      showBanner(`解锁失败:${failed.join('、') || '没有可解锁的连接'}`, false);
    }
  } catch (err) {
    showBanner(`解锁失败:${err.message}`, false);
  } finally {
    btn.disabled = false;
  }
}
