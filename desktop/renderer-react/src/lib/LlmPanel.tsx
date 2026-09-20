/** 接入页「大模型」那一节:选服务商与模型、填端点与密钥、测一条真请求。
 *
 * 2026-09-21 从 pages/Access.tsx 搬出来(函数体逐字未改)。它和 TWS / 富途两节没有共享状态,
 * 只共用一个 InfoCard(在 connectBits.tsx)。密钥只往 llm.patch 送,不落在这一层。
 */
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Input, InputNumber, Segmented, Select } from 'antd';
import { dafri, errorMessage } from '../bridge';
import type { LlmPatch, LlmTestResult } from '../bridge';
import { InfoCard } from './connectBits';
import { showBanner } from '../store/banner';
import { loadLlmCatalog, useLlmCatalog, type LlmProvider } from '../store/llm';
import { refreshStatus } from '../store/status';
import { Group, GroupRow, Notice, SectionTitle, Working } from '../ui/kit';

export function LlmPanel() {
  const catalog = useLlmCatalog();
  const [provider, setProvider] = useState<string>('');
  const [model, setModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [effort, setEffort] = useState('high');
  const [temperature, setTemperature] = useState<number | null>(null);
  const [maxTokens, setMaxTokens] = useState<number | null>(null);
  const [timeout, setTimeoutS] = useState<number | null>(null);
  const [apiKey, setApiKey] = useState('');
  // 引擎的回执按 ok 分两支(契约的 LlmTestResult);界面自己另有一个"正在测"的占位
  const [test, setTest] = useState<LlmTestResult | { pending: true } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void loadLlmCatalog();
  }, []);

  const meta: LlmProvider = catalog?.providers.find((p) => p.key === provider) || ({} as LlmProvider);
  const current = catalog?.current;
  const sameProvider = Boolean(current && provider === current.provider);

  // 目录到了 / 换了供应商:把表单填成当前配置(同供应商)或该供应商的默认值。
  // 只在**供应商或已存配置真的变了**时重填:目录对象每次读都是新的,照对象身份判断的话,
  // 保存一次 API Key(或引擎发一次 llm 事件)就会把用户还没保存的模型名、Base URL 静默冲掉。
  const seeded = useRef('');
  useEffect(() => {
    if (!catalog) return;
    const p = provider || catalog.current.provider;
    if (!provider) setProvider(p);
    const m = catalog.providers.find((x) => x.key === p) || ({} as LlmProvider);
    const same = p === catalog.current.provider;
    const sig = JSON.stringify([p, catalog.current]);
    if (seeded.current === sig) return;
    seeded.current = sig;
    setModel(same && catalog.current.model ? catalog.current.model : m.models?.[0] || m.default_model || '');
    setCustomModel('');
    setBaseUrl(same ? catalog.current.base_url || '' : m.default_base_url || '');
    setEffort(catalog.current.effort || 'high');
    setTemperature(catalog.current.temperature ?? null);
    setMaxTokens(catalog.current.max_tokens ?? null);
    setTimeoutS(catalog.current.timeout_s ?? null);
  }, [catalog, provider]);

  const models = [...(meta.models || [])];
  if (sameProvider && current?.model && !models.includes(current.model)) models.unshift(current.model);
  const configured = Boolean(catalog?.key_configured?.[provider]);

  function collect(): LlmPatch {
    const patch: LlmPatch = {
      provider,
      model: customModel.trim() || model,
      max_tokens: Number(maxTokens),
      timeout_s: Number(timeout),
    };
    if (meta.needs_base_url) patch.base_url = baseUrl.trim();
    if (meta.supports_effort) patch.effort = effort;
    if (meta.supports_temperature) patch.temperature = temperature === null ? null : Number(temperature);
    return patch;
  }

  /** 空着的数字框会变成 0 发出去:引擎那边 max_tokens 要 ≥ 1000,超时 0 秒等于当场取消。在这儿说清楚,别让人去猜供应商的报错。 */
  function invalidField(): string | null {
    if (maxTokens == null || maxTokens < 1000) return 'max_tokens 至少 1000,先把它填上';
    if (timeout == null || timeout < 1) return '超时(秒)至少 1,先把它填上';
    return null;
  }

  async function runTest() {
    const bad = invalidField();
    if (bad) return showBanner(bad, true);
    setTesting(true);
    setTest({ pending: true });
    try {
      // 允许带一把还没保存的 key 先试,试通了再保存
      setTest(await dafri.llmTest(collect(), apiKey.trim() || undefined));
    } catch (err) {
      setTest({ ok: false, error: errorMessage(err), provider, model: customModel.trim() || model });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    const bad = invalidField();
    if (bad) return showBanner(bad, true);
    try {
      await dafri.llmPatch(collect());
      await Promise.all([loadLlmCatalog(), refreshStatus()]);
      showBanner('模型配置已保存,提示词与解析引擎已重建。', true);
    } catch (err) {
      showBanner(`保存失败(配置未改动):${errorMessage(err)}`, false);
    }
  }

  async function saveKey() {
    const secret = apiKey.trim();
    if (!secret) return;
    try {
      await dafri.setApiKeyFor(secret, provider);
      setApiKey('');
      await loadLlmCatalog();
      showBanner(`已把 ${meta.label} 的 API Key 写入 Keychain。`, true);
    } catch (err) {
      showBanner(`写入失败:${errorMessage(err)}`, false);
    }
  }

  return (
    <section className="sub-panel active" id="panel-llm">
      <Notice>
        发给模型的只有指令原文、当前时间、行情快照、账户别名与限额;<strong>真实账号、余额、持仓、成交记录不出本机</strong>。
      </Notice>

      <SectionTitle>供应商</SectionTitle>
      <div className="seg-row">
        <Segmented
          options={(catalog?.providers || []).map((p) => ({ value: p.key, label: p.label }))}
          value={provider || undefined}
          onChange={(v) => {
            setProvider(String(v));
            setTest(null);
          }}
        />
      </div>

      <Group>
        <GroupRow label="模型">
          <Select className="grow" value={model || undefined} options={models.map((m) => ({ value: m, label: m }))} onChange={setModel} style={{ width: 320, maxWidth: '100%' }} />
        </GroupRow>
        <GroupRow stacked label="自定义模型" sub="留空则用上面选中的">
          <Input placeholder="如 deepseek-chat" value={customModel} onChange={(e) => setCustomModel(e.target.value)} />
        </GroupRow>
        {meta.needs_base_url ? (
          <GroupRow stacked label="Base URL" sub="OpenAI 兼容端点">
            <Input placeholder="https://api.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </GroupRow>
        ) : null}
      </Group>

      <SectionTitle>API Key</SectionTitle>
      <Group>
        <GroupRow stacked label="按供应商分开存于系统凭据库,不落配置、不进日志">
          <Input.Password placeholder="sk-..." autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </GroupRow>
        <GroupRow
          label="当前供应商 Key"
          sub={<Badge status={catalog ? (configured ? 'success' : 'warning') : 'default'} text={catalog ? (configured ? '已配置(存于 Keychain)' : '未配置') : '检测中…'} />}
        >
          <Button onClick={() => void saveKey()}>保存</Button>
        </GroupRow>
      </Group>

      <SectionTitle>调用参数</SectionTitle>
      <Group>
        {meta.supports_effort ? (
          <GroupRow label="推理档位" sub="effort,仅 Anthropic">
            <Select value={effort} options={['low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ value: v, label: v }))} onChange={setEffort} style={{ width: 190 }} />
          </GroupRow>
        ) : null}
        {meta.supports_temperature ? (
          <GroupRow label="temperature" sub="留空 = 不发送">
            <InputNumber min={0} max={2} step={0.1} placeholder="不发送" value={temperature} onChange={(v) => setTemperature(v == null ? null : Number(v))} style={{ width: 190 }} />
          </GroupRow>
        ) : null}
        <GroupRow label="max_tokens">
          <InputNumber min={1000} step={1000} value={maxTokens} onChange={(v) => setMaxTokens(v == null ? null : Number(v))} style={{ width: 190 }} />
        </GroupRow>
        <GroupRow label="超时(秒)">
          <InputNumber min={1} step={5} value={timeout} onChange={(v) => setTimeoutS(v == null ? null : Number(v))} style={{ width: 190 }} />
        </GroupRow>
      </Group>

      <div className="row tight">
        <Button loading={testing} onClick={() => void runTest()}>
          测试连接
        </Button>
        <Button type="primary" onClick={() => void save()}>
          保存配置
        </Button>
      </div>
      <div className="cards">
        {test === null ? null : 'pending' in test ? (
          <Working>正在测试…会真打一次最小请求</Working>
        ) : test.ok ? (
          <InfoCard tone="ok" title={`连通 · ${test.model}`} meta={[`${test.latency_ms} ms`, `结构化输出:${test.structured_mode}`, `in ${test.usage?.input_tokens ?? '—'} / out ${test.usage?.output_tokens ?? '—'}`]}>
            {test.structured_mode === 'json_object' ? <div className="reason">端点不支持 json_schema,已降级为 json_object + 提示词内嵌 schema,拒绝率可能升高。</div> : null}
          </InfoCard>
        ) : (
          <InfoCard tone="bad" title="测试失败" body={test.error} />
        )}
      </div>
      {meta.docs ? <p className="hint">{meta.docs}</p> : null}
    </section>
  );
}
