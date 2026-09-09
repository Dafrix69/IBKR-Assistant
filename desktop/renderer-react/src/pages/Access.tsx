import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Card, Input, InputNumber, List, Segmented, Select, Space, Steps } from 'antd';
import { dafri, errorMessage } from '../bridge';
import { showBanner } from '../store/banner';
import { toggleBrokerConnection } from '../store/broker';
import { loadLlmCatalog, useLlmCatalog, type LlmProvider } from '../store/llm';
import { setSubtab, useSubtab } from '../store/nav';
import { pushNotification } from '../store/notify';
import { refreshStatus, useStatus } from '../store/status';
import { EmptyState, Group, GroupRow, LoadingBlock, Meta, Notice, PageHead, Primer, SectionTitle, StatusCard, SwitchRow, Working, type Tone } from '../ui/kit';

// 接入:TWS、富途 OpenD、大模型。不接触任何券商账号密码——登录在券商程序自己的窗口完成,
// 这里只检测本机端口、诊断握手、核对账户别名。

const SUBTABS = [
  { value: 'tws', label: 'TWS' },
  { value: 'futu', label: '富途 OpenD' },
  { value: 'llm', label: '大模型' },
];

interface App {
  key: string;
  name: string;
  installed: boolean;
  running: boolean;
  paths: string[];
}
interface Port {
  port: number;
  label: string;
  open: boolean;
  latency_ms?: number | null;
  error?: string;
  configured_as?: string;
}
interface GuideStep {
  title: string;
  detail: string;
}

function InfoCard({ tone, title, body, meta, children }: { tone: Tone; title: string; body?: string | null; meta?: string[]; children?: ReactNode }) {
  return (
    <StatusCard tone={tone} title={title}>
      {body ? <div>{body}</div> : null}
      {meta && meta.length ? <Meta items={meta} /> : null}
      {children}
    </StatusCard>
  );
}

/** 程序检测卡:装没装、跑没跑,没跑就给一个启动按钮 */
function AppsCards({ apps, missingText, onLaunch }: { apps: App[]; missingText: string; onLaunch: (app: App) => Promise<void> }) {
  const [launching, setLaunching] = useState<string | null>(null);
  return (
    <>
      {apps.map((app) => (
        <InfoCard
          key={app.key}
          tone={app.running ? 'ok' : app.installed ? 'warn' : 'bad'}
          title={app.name}
          body={app.running ? '正在运行' : app.installed ? '已安装,未运行' : missingText}
          meta={app.paths.length ? [app.paths[0]] : []}
        >
          {app.installed && !app.running ? (
            <Button
              size="small"
              className="card-action"
              loading={launching === app.key}
              onClick={async () => {
                setLaunching(app.key);
                try {
                  await onLaunch(app);
                } finally {
                  setLaunching(null);
                }
              }}
            >
              {`启动 ${app.name}`}
            </Button>
          ) : null}
        </InfoCard>
      ))}
    </>
  );
}

// 端口栅格和指引两家券商长得一样,只是数据来源不同——共用一份渲染
function PortsGrid({ ports, connected }: { ports: Port[]; connected: string[] }) {
  const AS: Record<string, string> = { live: '实盘', paper: '模拟' };
  return (
    <div className="port-grid">
      {ports.map((port) => (
        <Card size="small" className={`port ${port.open ? 'open' : 'closed'}`} key={port.port}>
          <div className="port-num">{String(port.port)}</div>
          <div className="port-label">{port.label}</div>
          <div className="port-state">
            <Badge status={port.open ? 'success' : 'default'} text={port.open ? `开放 · ${port.latency_ms ?? '?'} ms` : port.error || '未监听'} />
          </div>
          {port.configured_as ? (
            <span className="port-badge">{`配置为${AS[port.configured_as] || port.configured_as}${connected.includes(port.configured_as) ? ' · 已连接' : ''}`}</span>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

/** 「连不上时照着做」:需要它的时候(没连上)才默认展开;手动点过一次就记住用户的选择 */
function Guide({ id, steps, connected }: { id: string; steps: GuideStep[]; connected: boolean }) {
  return (
    <Primer id={id} summary="连不上时照着做" defaultOpen={!connected}>
      <Steps direction="vertical" size="small" progressDot className="guide" items={steps.map((s) => ({ title: s.title, description: s.detail, status: 'process' }))} />
    </Primer>
  );
}

function AccountRows({ accounts, connection }: { accounts: any[]; connection: string }) {
  const rows = accounts.filter((a) => a.connection === connection);
  if (!rows.length) return null;
  return (
    <List
      size="small"
      className="acct-list"
      dataSource={rows}
      renderItem={(a, i) => (
        <List.Item key={i} className="acct-row">
          <span>{`${a.alias} → ${a.account_masked}`}</span>
          <Badge status={a.resolved ? 'success' : 'error'} text={a.resolved ? '对得上' : '不在可管账户里'} />
        </List.Item>
      )}
    />
  );
}

function ConnectRow() {
  const status = useStatus();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <SectionTitle>4 · 连接引擎</SectionTitle>
      <div className="row tight">
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await toggleBrokerConnection();
            } finally {
              setBusy(false);
            }
          }}
        >
          {status?.broker_connected ? '断开交易引擎' : '连接交易引擎'}
        </Button>
      </div>
      <p className="hint">「检测连接」是一次性只读探测;这里才是引擎下单用的长连接。</p>
    </>
  );
}

export function AccessPage() {
  const sub = useSubtab('access', 'tws');
  return (
    <section className="tab-panel active" id="page-access">
      <PageHead title="接入" extra={<Segmented options={SUBTABS} value={sub} onChange={(v) => setSubtab('access', String(v))} />} />
      {sub === 'tws' ? <TwsPanel /> : null}
      {sub === 'futu' ? <FutuPanel /> : null}
      {sub === 'llm' ? <LlmPanel /> : null}
    </section>
  );
}

// ---- TWS ------------------------------------------------------------------

function TwsPanel() {
  const status = useStatus();
  const connected = Boolean(status?.broker_connected);
  const [scan, setScan] = useState<any>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [diag, setDiag] = useState<any[] | null>(null);
  const [diagState, setDiagState] = useState<'idle' | 'working' | 'error'>('idle');
  const [diagError, setDiagError] = useState('');

  const doScan = useCallback(async () => {
    try {
      setScan(await dafri.scanTws());
      setScanError(null);
    } catch (err) {
      setScanError(errorMessage(err));
    }
    try {
      const catalog = await dafri.brokerCatalog();
      setCurrent(catalog?.current || null);
    } catch {
      /* 横幅只是提示,读不到就不显示 */
    }
  }, []);

  useEffect(() => {
    void doScan();
  }, [doScan]);

  async function diagnose() {
    setDiagState('working');
    try {
      const { results } = await dafri.diagnoseTws();
      setDiag(results || []);
      setDiagState('idle');
    } catch (err) {
      setDiagError(errorMessage(err));
      setDiagState('error');
    }
  }

  async function launch(app: App) {
    try {
      await dafri.launchTws(app.key);
      pushNotification(`已启动 ${app.name}`, '请在它自己的窗口里登录');
      setTimeout(() => void doScan(), 4000);
    } catch (err) {
      showBanner(`启动失败:${errorMessage(err)}`, false);
    }
  }

  return (
    <section className="sub-panel active" id="panel-tws">
      {current === 'ibkr' ? (
        <Notice title="当前券商接入:IBKR。">引擎正通过此通道下单。</Notice>
      ) : current ? (
        // 当前生效的券商不是这一页讲的那一家:这条说的是"你在看的不是引擎实际在用的通道",必须一眼看出来
        <Notice tone="warn" title="当前券商接入:富途 OpenD。">本页仅检测 IBKR,引擎不经此下单;切换请到「富途 OpenD」页。</Notice>
      ) : null}
      <Notice title="不接触你的 IBKR 账号密码。">登录在 TWS / IB Gateway 自己的窗口完成;这里只检测本机 API 端口、诊断握手、核对账户别名。</Notice>
      <div className="row tight">
        <Button onClick={() => void doScan()}>重新检测</Button>
        <Button type="primary" loading={diagState === 'working'} onClick={() => void diagnose()}>
          检测连接
        </Button>
      </div>

      <SectionTitle>1 · 程序</SectionTitle>
      <div className="cards">
        {scanError ? <EmptyState>检测失败:{scanError}</EmptyState> : !scan ? <LoadingBlock rows={2} /> : <AppsCards apps={scan.apps || []} missingText="未安装(请从 IBKR 官网下载)" onLaunch={launch} />}
      </div>

      <SectionTitle>2 · API 端口</SectionTitle>
      {scan ? <PortsGrid ports={scan.ports || []} connected={scan.connected || []} /> : scanError ? <EmptyState>—</EmptyState> : <LoadingBlock rows={2} />}

      <SectionTitle>3 · 握手与账户</SectionTitle>
      <div className="cards">
        {diagState === 'working' ? (
          <Working>正在握手…(首次连接 TWS 会弹确认框,点 Yes)</Working>
        ) : diagState === 'error' ? (
          <EmptyState>诊断失败:{diagError}</EmptyState>
        ) : !diag ? (
          <EmptyState>点「检测连接」做一次只读握手</EmptyState>
        ) : (
          diag.map((r, i) => <Diagnosis key={i} result={r} versionLabel="服务器版本" extraMeta={[`clientId ${r.client_id}`]} />)
        )}
      </div>

      <ConnectRow />
      <Guide id="tws-primer" steps={scan?.guide || []} connected={connected} />
    </section>
  );
}

function Diagnosis({ result, versionLabel, extraMeta }: { result: any; versionLabel: string; extraMeta: string[] }) {
  const tone: Tone = result.connected && !result.error ? 'ok' : result.connected ? 'warn' : 'bad';
  const meta = result.connected
    ? [`${versionLabel} ${result.server_version ?? '—'}`, ...extraMeta, ...(result.port_latency_ms != null ? [`${result.port_latency_ms} ms`] : [])]
    : [];
  return (
    <InfoCard tone={tone} title={`连接 ${result.connection} · ${result.host ?? '—'}:${result.port ?? '—'}`} body={result.connected ? '握手成功' : '未连接'} meta={meta}>
      {result.error ? <div className="reason">{result.error}</div> : null}
      {result.hint ? <div style={{ marginTop: 6 }}>{result.hint}</div> : null}
      <AccountRows accounts={result.accounts || []} connection={result.connection} />
    </InfoCard>
  );
}

// ---- 富途 OpenD -------------------------------------------------------------

const BROKER_HINT: Record<string, string> = {
  ibkr: '需本机运行并登录 TWS 或 IB Gateway。支持组合单(价差 / 蝴蝶 / 铁鹰)。',
  futu: '需本机运行并登录富途 OpenD。不支持组合单,多腿结构会被拒绝。',
};

function loginText(v: unknown): string {
  if (v === true) return '已登录';
  if (v === false) return '未登录';
  return '未知';
}

function FutuPanel() {
  const status = useStatus();
  const connected = Boolean(status?.broker_connected);
  const [catalog, setCatalog] = useState<any>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [scan, setScan] = useState<any>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [diag, setDiag] = useState<any[] | null>(null);
  const [diagState, setDiagState] = useState<'idle' | 'working' | 'error'>('idle');
  const [diagError, setDiagError] = useState('');
  const [switching, setSwitching] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [isMd5, setIsMd5] = useState(false);
  const [saving, setSaving] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await dafri.brokerCatalog());
      setCatalogError(null);
    } catch (err) {
      setCatalogError(errorMessage(err));
    }
  }, []);
  const doScan = useCallback(async () => {
    try {
      setScan(await dafri.scanFutu());
      setScanError(null);
    } catch (err) {
      setScanError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
    void doScan();
  }, [loadCatalog, doScan]);

  async function diagnose() {
    setDiagState('working');
    try {
      const { results } = await dafri.diagnoseFutu();
      setDiag(results || []);
      setDiagState('idle');
    } catch (err) {
      setDiagError(errorMessage(err));
      setDiagState('error');
    }
  }

  async function launch(app: App) {
    try {
      await dafri.launchFutu();
      pushNotification(`已启动 ${app.name}`, '请在它自己的窗口里登录');
      setTimeout(() => void doScan(), 4000);
    } catch (err) {
      showBanner(`启动失败:${errorMessage(err)}`, false);
    }
  }

  // 换券商 = 换下单出口。不该点一下就生效,先把后果讲清楚
  async function switchTo(provider: LlmProvider | any) {
    const ok = await dafri.confirm({
      title: '切换券商',
      message: `把下单出口切到「${provider.label}」?`,
      detail: '现有的券商连接会先断开,选择会写进配置文件。' + (provider.key === 'futu' ? ' 富途不支持组合单:价差 / 蝴蝶 / 铁鹰会被引擎拒绝。' : ''),
      confirmLabel: '切换',
    });
    if (!ok) return;
    setSwitching(provider.key);
    try {
      await dafri.selectBroker(provider.key);
      showBanner(`已切到 ${provider.label}。请在下面点「连接 / 断开交易引擎」重新连接。`, true);
      await loadCatalog();
      await refreshStatus();
    } catch (err) {
      showBanner(`切换失败:${errorMessage(err)}`, false);
    } finally {
      setSwitching(null);
    }
  }

  async function savePassword() {
    if (!password) return;
    setSaving(true);
    try {
      await dafri.setFutuPassword(password, isMd5);
      setPassword('');
      await loadCatalog();
      showBanner('交易密码已写入 Keychain(只存 md5)。', true);
    } catch (err) {
      showBanner(`写入失败:${errorMessage(err)}`, false);
    } finally {
      setSaving(false);
    }
  }

  async function unlock() {
    setUnlocking(true);
    try {
      const result = await dafri.unlockFutu();
      const failed = Object.entries(result?.failed || {}).map(([name, msg]) => `${name}(${msg})`);
      if ((result?.unlocked || []).length) {
        showBanner(`已解锁:${result.unlocked.join('、')}${failed.length ? `;失败:${failed.join('、')}` : ''}`, !failed.length);
      } else {
        showBanner(`解锁失败:${failed.join('、') || '没有可解锁的连接'}`, false);
      }
    } catch (err) {
      showBanner(`解锁失败:${errorMessage(err)}`, false);
    } finally {
      setUnlocking(false);
    }
  }

  const unlockState = catalog ? (catalog.futu?.unlock_password_saved ? '已存密码(md5),连接引擎后点「交易解锁」' : '未存密码,模拟盘不受影响,实盘单会被拦下') : '检测中…';

  return (
    <section className="sub-panel active" id="panel-futu">
      <Notice title="IBKR API 跑不起来时的备用通道。">
        同样不接触你的富途账号密码,登录在 OpenD 自己的窗口完成;这里只检测端口、诊断握手、核对账户别名。
        <br />
        <strong>不支持组合单</strong>:价差 / 蝴蝶 / 铁鹰拆单有腿风险,引擎会直接拒绝,请切回 IBKR。
        <br />
        <strong>没有原生条件单</strong>:条件单由本软件盯盘,<em>软件关掉就不会触发</em>(IBKR 的条件单挂在券商服务器,掉线仍有效)。
      </Notice>

      <SectionTitle>0 · 当前券商接入</SectionTitle>
      <div className="cards">
        {catalogError ? (
          <EmptyState>读取失败:{catalogError}</EmptyState>
        ) : !catalog ? (
          <LoadingBlock rows={2} />
        ) : (
          (catalog.providers || []).map((provider: any) => {
            const conns = Object.entries(provider.connections || {}) as [string, any][];
            return (
              <InfoCard
                key={provider.key}
                tone={provider.current ? 'ok' : 'warn'}
                title={`${provider.label}${provider.current ? ' · 当前生效' : ''}`}
                body={BROKER_HINT[provider.key] || ''}
                meta={[conns.length ? conns.map(([name, c]) => `${name} ${c.host}:${c.port}`).join(' · ') : '未配置连接', `${(provider.accounts || []).length} 个账户`]}
              >
                {provider.config_snippet ? (
                  <>
                    {/* 账户与连接不给界面通道(§9.6),那至少别让人去猜字段名和默认端口 */}
                    <div style={{ marginTop: 8 }}>尚未配置连接与账户。把下面这段并入 config/settings.json 后再切换:</div>
                    <pre className="snippet">{provider.config_snippet}</pre>
                  </>
                ) : !provider.current ? (
                  <Button size="small" className="card-action" loading={switching === provider.key} onClick={() => void switchTo(provider)}>
                    {`切到${provider.label}`}
                  </Button>
                ) : null}
              </InfoCard>
            );
          })
        )}
      </div>
      <p className="hint">同一时刻只连一家。切换会断开现有连接并写入配置;别名、限额、校验层不变。</p>

      <div className="row tight">
        <Button
          onClick={() => {
            void loadCatalog();
            void doScan();
          }}
        >
          重新检测
        </Button>
        <Button type="primary" loading={diagState === 'working'} onClick={() => void diagnose()}>
          检测连接
        </Button>
      </div>

      <SectionTitle>1 · 程序</SectionTitle>
      <div className="cards">
        {scanError ? (
          <EmptyState>检测失败:{scanError}</EmptyState>
        ) : !scan ? (
          <LoadingBlock rows={2} />
        ) : (
          <>
            {/* SDK 没装的话,后面几步全都会卡在同一个地方。先把它摆在最前面 */}
            {scan.sdk_installed === false ? <InfoCard tone="bad" title="futu-api(npm 包)未安装" body="连接 OpenD 必需:在 engine-ts 目录执行 npm install,然后在「关于」里重启引擎。" /> : null}
            <AppsCards apps={scan.apps || []} missingText="未找到(绿色包放在非常见目录时检测不到,可手动启动)" onLaunch={launch} />
          </>
        )}
      </div>

      <SectionTitle>2 · API 端口</SectionTitle>
      {scan ? <PortsGrid ports={scan.ports || []} connected={scan.connected || []} /> : scanError ? <EmptyState>—</EmptyState> : <LoadingBlock rows={2} />}

      <SectionTitle>3 · 握手与账户</SectionTitle>
      <div className="cards">
        {diagState === 'working' ? (
          <Working>正在握手…(OpenD 需已登录,否则超时)</Working>
        ) : diagState === 'error' ? (
          <EmptyState>诊断失败:{diagError}</EmptyState>
        ) : !diag ? (
          <EmptyState>点「检测连接」做一次只读握手</EmptyState>
        ) : (
          diag.map((r, i) => <Diagnosis key={i} result={r} versionLabel="OpenD 版本" extraMeta={[`行情登录 ${loginText(r.qot_logined)}`, `交易登录 ${loginText(r.trd_logined)}`]} />)
        )}
      </div>

      <ConnectRow />

      <SectionTitle>5 · 交易解锁(仅实盘需要)</SectionTitle>
      <Group>
        <GroupRow stacked label={<><strong>只存 md5</strong>于 Keychain / DPAPI,明文算完即丢,不写配置、不进日志。模拟盘无需解锁。</>}>
          <Input.Password placeholder="富途交易密码" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </GroupRow>
        <SwitchRow label="我填的已经是 md5" sub="不勾则由引擎本机计算" checked={isMd5} onChange={setIsMd5} />
        <GroupRow label="解锁状态" sub={unlockState}>
          <Space size={6}>
            <Button loading={saving} onClick={() => void savePassword()}>
              保存
            </Button>
            <Button type="primary" loading={unlocking} onClick={() => void unlock()}>
              交易解锁
            </Button>
          </Space>
        </GroupRow>
      </Group>
      <p className="hint">解锁随 OpenD 会话失效,重启 OpenD 后需重新解锁;未解锁时实盘单会在引擎侧被拦下。</p>

      <Guide id="futu-primer" steps={scan?.guide || []} connected={connected} />
    </section>
  );
}

// ---- 大模型 ----------------------------------------------------------------

function LlmPanel() {
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
  const [test, setTest] = useState<any>(null);
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

  function collect() {
    const patch: Record<string, unknown> = {
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
      setTest({ ok: false, error: errorMessage(err) });
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
        {test?.pending ? (
          <Working>正在测试…会真打一次最小请求</Working>
        ) : test && test.ok ? (
          <InfoCard tone="ok" title={`连通 · ${test.model}`} meta={[`${test.latency_ms} ms`, `结构化输出:${test.structured_mode}`, `in ${test.usage?.input_tokens ?? '—'} / out ${test.usage?.output_tokens ?? '—'}`]}>
            {test.structured_mode === 'json_object' ? <div className="reason">端点不支持 json_schema,已降级为 json_object + 提示词内嵌 schema,拒绝率可能升高。</div> : null}
          </InfoCard>
        ) : test ? (
          <InfoCard tone="bad" title="测试失败" body={test.error} />
        ) : null}
      </div>
      {meta.docs ? <p className="hint">{meta.docs}</p> : null}
    </section>
  );
}
