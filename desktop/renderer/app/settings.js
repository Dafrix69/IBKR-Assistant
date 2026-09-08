'use strict';
// 设置

// ======================================================================
// 设置
// ======================================================================
async function loadSettings() {
  try {
    const settings = await window.dafri.getSettings();
    state.settings = settings;
    // 少一个字段就整页崩掉、只留一句 JS 报错,不是可交付的失败方式:
    // 缺什么就空着那一格,其余照常可用。
    const policies = settings.policies || {};
    const limits = settings.limits || {};
    $('opt-auto-execute').checked = Boolean(policies.auto_execute);
    $('opt-live').checked = Boolean(policies.allow_live_trading);
    $('opt-trigger-verify').checked = Boolean(policies.require_trigger_price_verification);
    $('opt-notional').value = limits.max_order_notional ?? '';
    $('opt-contracts').value = limits.max_option_contracts ?? '';
    $('opt-mkt-shares').value = limits.max_mkt_shares ?? '';
    $('opt-slippage').value = limits.max_spread_slippage ?? '';
    $('opt-dupe').value = limits.duplicate_window_minutes ?? '';
  } catch (err) {
    showBanner(`读取设置失败:${err.message}`, false);
  }
}

async function saveSettings() {
  const autoExecute = $('opt-auto-execute').checked;
  const allowLive = $('opt-live').checked;

  if (autoExecute && !(state.settings && state.settings.policies.auto_execute)) {
    const ok = await window.dafri.confirm({
      title: '打开自动执行',
      message: `打开后,解析通过的订单会被直接发送到${brokerShortName()},没有人工确认环节。`,
      detail: '建议先在纸面账户跑够回归测试再打开。',
      confirmLabel: '我明白,打开',
    });
    if (!ok) return ($('opt-auto-execute').checked = false);
  }
  if (allowLive && !(state.settings && state.settings.policies.allow_live_trading)) {
    const ok = await window.dafri.confirm({
      title: '允许实盘下单',
      message: '打开后,指向实盘账户的订单将不再被拦截,会用真钱成交。',
      confirmLabel: '我明白,打开实盘',
    });
    if (!ok) return ($('opt-live').checked = false);
  }

  const patch = {
    policies: {
      auto_execute: autoExecute,
      allow_live_trading: allowLive,
      require_trigger_price_verification: $('opt-trigger-verify').checked,
    },
    limits: {
      max_order_notional: Number($('opt-notional').value),
      max_option_contracts: Number($('opt-contracts').value),
      max_mkt_shares: Number($('opt-mkt-shares').value),
      max_spread_slippage: Number($('opt-slippage').value),
      duplicate_window_minutes: Number($('opt-dupe').value),
    },
  };

  try {
    await window.dafri.patchSettings(patch);
    showBanner('设置已保存,提示词与限额已同步更新。', true);
    await Promise.all([loadSettings(), refreshStatus()]);
  } catch (err) {
    showBanner(`保存失败(配置未改动):${err.message}`, false);
  }
}
