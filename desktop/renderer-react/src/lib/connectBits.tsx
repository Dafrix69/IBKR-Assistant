/** 接入页三节(TWS / 富途 OpenD / 大模型)共用的展示构件。
 *
 * 2026-09-21 从 pages/Access.tsx 搬出来(函数体逐字未改)。三节各自成了 lib/ 下的一个文件,
 * 公用的这几样放这里,页面与三节都从这里拿(page → lib 是允许的方向)。
 */
import { useState, type ReactNode } from 'react';
import { Badge, Button, Card, List, Steps } from 'antd';
import type { AppStatus, DiagnoseAccount, DiagnoseResult, GuideStep, PortStatus } from '../bridge';
import { toggleBrokerConnection } from '../store/broker';
import { useStatus } from '../store/status';
import { Meta, Primer, SectionTitle, StatusCard, type Tone } from '../ui/kit';

export function InfoCard({ tone, title, body, meta, children }: { tone: Tone; title: string; body?: string | null; meta?: string[]; children?: ReactNode }) {
  return (
    <StatusCard tone={tone} title={title}>
      {body ? <div>{body}</div> : null}
      {meta && meta.length ? <Meta items={meta} /> : null}
      {children}
    </StatusCard>
  );
}

// 程序、端口、指引这三样的形状在引擎契约里(engine-ts/src/contract/connection.ts),从 bridge 拿。
// 以前这里手抄过一份:Port 的 error / configured_as 抄成了可选,引擎给的其实是「有值或 null」。
export type App = AppStatus;
export type Port = PortStatus;

/** 程序检测卡:装没装、跑没跑,没跑就给一个启动按钮 */
export function AppsCards({ apps, missingText, onLaunch }: { apps: App[]; missingText: string; onLaunch: (app: App) => Promise<void> }) {
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
export function PortsGrid({ ports, connected }: { ports: Port[]; connected: string[] }) {
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
export function Guide({ id, steps, connected }: { id: string; steps: GuideStep[]; connected: boolean }) {
  return (
    <Primer id={id} summary="连不上时照着做" defaultOpen={!connected}>
      <Steps direction="vertical" size="small" progressDot className="guide" items={steps.map((s) => ({ title: s.title, description: s.detail, status: 'process' }))} />
    </Primer>
  );
}

export function AccountRows({ accounts, connection }: { accounts: DiagnoseAccount[]; connection: string }) {
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

export function ConnectRow() {
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

export function Diagnosis({ result, versionLabel, extraMeta }: { result: DiagnoseResult; versionLabel: string; extraMeta: string[] }) {
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
