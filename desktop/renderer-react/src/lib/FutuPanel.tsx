/** 接入页「富途 OpenD」那一节:换券商、检测程序与端口、诊断握手、交易解锁。
 *
 * 2026-09-21 从 pages/Access.tsx 搬出来(函数体逐字未改)。
 * 注意「0 · 当前券商接入」(换下单出口)原本就长在这一节里,**搬家照原样没动**——
 * 它该不该属于富途这一节是另一件事,不在这一刀的范围里。
 * 交易解锁密码只往 futu.set_password 送(它写系统凭证库),不落在这一层。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Space } from 'antd';
import { dafri, errorMessage } from '../bridge';
import type { BrokerCatalog, BrokerProviderEntry, DiagnoseResult, FutuScanResult } from '../bridge';
import { AppsCards, ConnectRow, Diagnosis, Guide, InfoCard, PortsGrid, type App } from './connectBits';
import { showBanner } from '../store/banner';
import { pushNotification } from '../store/notify';
import { refreshStatus, useStatus } from '../store/status';
import { EmptyState, Group, GroupRow, LoadingBlock, Notice, SectionTitle, SwitchRow, Working } from '../ui/kit';

const BROKER_HINT: Record<string, string> = {
  ibkr: '需本机运行并登录 TWS 或 IB Gateway。支持组合单(价差 / 蝴蝶 / 铁鹰)。',
  futu: '需本机运行并登录富途 OpenD。不支持组合单,多腿结构会被拒绝。',
};

function loginText(v: unknown): string {
  if (v === true) return '已登录';
  if (v === false) return '未登录';
  return '未知';
}

export function FutuPanel() {
  const status = useStatus();
  const connected = Boolean(status?.broker_connected);
  const [catalog, setCatalog] = useState<BrokerCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [scan, setScan] = useState<FutuScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [diag, setDiag] = useState<DiagnoseResult[] | null>(null);
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
  // 2026-09-21:原来标的是 `LlmProvider | any`——换券商的函数挂着大模型的类型,而且 `| any`
  // 把整个类型化掉了。唯一的调用方传的就是券商目录里的一项,按实际改成 BrokerProviderEntry。
  async function switchTo(provider: BrokerProviderEntry) {
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
          (catalog.providers || []).map((provider: BrokerProviderEntry) => {
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
