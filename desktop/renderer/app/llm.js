'use strict';
// 大模型接入

// ======================================================================
// 大模型接入
// ======================================================================
const llm = { catalog: null, provider: null };

async function loadLlm() {
  try {
    const catalog = await window.dafri.llmCatalog();
    llm.catalog = catalog;
    llm.provider = llm.provider || catalog.current.provider;
    renderProviderPicker();
    fillLlmForm();
  } catch (err) {
    showBanner(`读取模型配置失败:${err.message}`, false);
  }
}

function providerMeta(key) {
  return (llm.catalog?.providers || []).find((p) => p.key === key) || {};
}

function renderProviderPicker() {
  const box = $('llm-providers');
  clear(box);
  for (const provider of llm.catalog.providers) {
    const btn = el('button', 'tab' + (provider.key === llm.provider ? ' active' : ''), provider.label);
    btn.addEventListener('click', () => {
      llm.provider = provider.key;
      renderProviderPicker();
      fillLlmForm({ providerChanged: true });
    });
    box.appendChild(btn);
  }
}

function fillLlmForm(options = {}) {
  const current = llm.catalog.current;
  const meta = providerMeta(llm.provider);
  const sameProvider = llm.provider === current.provider;

  // 模型下拉:预设 + 当前值(当前值不在预设里也要能选中)
  const select = $('llm-model');
  clear(select);
  const models = [...(meta.models || [])];
  if (sameProvider && current.model && !models.includes(current.model)) models.unshift(current.model);
  for (const model of models) {
    const option = el('option', null, model);
    option.value = model;
    select.appendChild(option);
  }
  if (sameProvider && current.model) select.value = current.model;

  $('llm-model-custom').value = '';
  $('llm-base-url').value = sameProvider ? current.base_url || '' : meta.default_base_url || '';
  $('llm-base-url-row').classList.toggle('hidden', !meta.needs_base_url);
  $('llm-effort-row').classList.toggle('hidden', !meta.supports_effort);
  $('llm-temp-row').classList.toggle('hidden', !meta.supports_temperature);
  $('llm-effort').value = current.effort || 'high';
  $('llm-temperature').value = current.temperature ?? '';
  $('llm-max-tokens').value = current.max_tokens;
  $('llm-timeout').value = current.timeout_s;
  $('llm-provider-docs').textContent = meta.docs || '';

  const configured = llm.catalog.key_configured?.[llm.provider];
  const status = $('llm-key-status');
  status.textContent = configured ? '已配置(存于 Keychain)' : '未配置';
  status.style.color = configured ? 'var(--green)' : 'var(--orange)';
  // 就绪检查表要用它。这个信息只有大模型面板拿得到,拿到了就顺手告诉检查表——
  // 否则用户填完 Key,首页那条"还差一步"还挂在那里。
  state.llmKeyConfigured = Boolean(configured);
  renderReadiness();

  if (options.providerChanged) empty($('llm-test-result'), '');
}

function collectLlmForm() {
  const meta = providerMeta(llm.provider);
  const custom = $('llm-model-custom').value.trim();
  const patch = {
    provider: llm.provider,
    model: custom || $('llm-model').value,
    max_tokens: Number($('llm-max-tokens').value),
    timeout_s: Number($('llm-timeout').value),
  };
  if (meta.needs_base_url) patch.base_url = $('llm-base-url').value.trim();
  if (meta.supports_effort) patch.effort = $('llm-effort').value;
  if (meta.supports_temperature) {
    const raw = $('llm-temperature').value.trim();
    patch.temperature = raw === '' ? null : Number(raw);
  }
  return patch;
}

async function testLlm() {
  const box = $('llm-test-result');
  const btn = $('btn-llm-test');
  btn.disabled = true;
  clear(box);
  box.appendChild(card('info', '正在测试…', '会真打一次最小请求'));
  try {
    // 允许带一把还没保存的 key 先试,试通了再保存
    const key = $('llm-key').value.trim() || undefined;
    const result = await window.dafri.llmTest(collectLlmForm(), key);
    clear(box);
    if (result.ok) {
      const meta = [
        `${result.latency_ms} ms`,
        `结构化输出:${result.structured_mode}`,
        `in ${result.usage?.input_tokens ?? '—'} / out ${result.usage?.output_tokens ?? '—'}`,
      ];
      const node = card('ok', `连通 · ${result.model}`, null, meta);
      if (result.structured_mode === 'json_object') {
        node.appendChild(
          el('div', 'reason', '端点不支持 json_schema,已降级为 json_object + 提示词内嵌 schema,拒绝率可能升高。')
        );
      }
      box.appendChild(node);
    } else {
      box.appendChild(card('bad', '测试失败', result.error));
    }
  } catch (err) {
    clear(box);
    box.appendChild(card('bad', '测试失败', err.message));
  } finally {
    btn.disabled = false;
  }
}

async function saveLlm() {
  try {
    await window.dafri.llmPatch(collectLlmForm());
    await Promise.all([loadLlm(), refreshStatus()]);
    showBanner('模型配置已保存,提示词与解析引擎已重建。', true);
  } catch (err) {
    showBanner(`保存失败(配置未改动):${err.message}`, false);
  }
}

async function saveLlmKey() {
  const input = $('llm-key');
  const secret = input.value.trim();
  if (!secret) return;
  try {
    await window.dafri.setApiKeyFor(secret, llm.provider);
    input.value = '';
    await loadLlm();
    showBanner(`已把 ${providerMeta(llm.provider).label} 的 API Key 写入 Keychain。`, true);
  } catch (err) {
    showBanner(`写入失败:${err.message}`, false);
  }
}
