/** 接入页「TWS」那一节:检测程序与 API 端口、诊断握手、核对账户别名。
 *
 * 2026-09-21 从 pages/Access.tsx 搬出来(函数体逐字未改)。**不接触任何券商账号密码**——
 * 登录在 TWS 自己的窗口完成,这里只看本机端口通不通、握手回了什么、别名对不对得上。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from 'antd';
import { dafri, errorMessage } from '../bridge';
import type { DiagnoseResult, TwsScanResult } from '../bridge';
import { AppsCards, ConnectRow, Diagnosis, Guide, PortsGrid, type App } from './connectBits';
import { showBanner } from '../store/banner';
import { pushNotification } from '../store/notify';
import { useStatus } from '../store/status';
import { EmptyState, LoadingBlock, Notice, SectionTitle, Working } from '../ui/kit';

export function TwsPanel() {
  const status = useStatus();
  const connected = Boolean(status?.broker_connected);
  const [scan, setScan] = useState<TwsScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [diag, setDiag] = useState<DiagnoseResult[] | null>(null);
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
