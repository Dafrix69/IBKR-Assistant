/**
 * 条款同意页。两种出场:
 *  · 还没同意现行条款(首次启动、或条款改版之后):挡住整个界面,同意才能用,不同意就退出;
 *  · 从「关于 → 查看条款」点开重看:同一份文本,只有一个「关闭」。
 *
 * 为什么是挡住整个界面而不是只挡发单:风险揭示要在人开始依赖这个软件**之前**看到,
 * 不是在他第一次点「发送」、正急着成交的那一刻。钱路径主进程另外挡着(desktop/consent.js)。
 */
import { useState } from 'react';
import { Button, Checkbox, Modal, Tabs } from 'antd';
import { LEGAL_DOCS, legalVersion } from '../lib/legalText';
import { PlainDoc } from '../lib/PlainDoc';
import { acceptTerms, hideTerms, quitApp, useConsent } from '../store/consent';

export function ConsentGate() {
  const { consent, viewing, error } = useConsent();
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<Set<string>>(() => new Set(['risk']));

  if (consent === null) return null; // 还没问到:不闪一下同意页
  const must = !consent.accepted;
  if (!must && !viewing) return null;

  const version = legalVersion();
  const allSeen = LEGAL_DOCS.every((d) => seen.has(d.key));

  async function accept() {
    setBusy(true);
    try {
      await acceptTerms(version);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      centered
      width={760}
      className="consent-modal"
      title={must ? '开始之前:请阅读并确认' : '条款'}
      closable={!must}
      maskClosable={!must}
      keyboard={!must}
      onCancel={must ? undefined : hideTerms}
      footer={
        must ? (
          <div className="consent-foot">
            <Checkbox checked={read} disabled={!allSeen} onChange={(e) => setRead(e.target.checked)}>
              {allSeen ? '我已阅读并理解风险揭示、使用条款与隐私说明' : '三份文本都点开看过之后才能勾选'}
            </Checkbox>
            <span className="consent-actions">
              {error ? <span className="consent-error">{error}</span> : null}
              <Button onClick={quitApp}>不同意,退出</Button>
              <Button type="primary" disabled={!read || !version} loading={busy} onClick={() => void accept()}>
                同意并继续
              </Button>
            </span>
          </div>
        ) : (
          <Button type="primary" onClick={hideTerms}>
            关闭
          </Button>
        )
      }
    >
      {must ? (
        <p className="consent-lead">
          这个软件会把你的指令变成真实的订单。用它之前,有三份不长的文本需要你看一遍:它会在什么情况下出错、责任怎么划分、你的数据去了哪里。
        </p>
      ) : null}
      <Tabs
        size="small"
        defaultActiveKey="risk"
        onChange={(key) => setSeen((prev) => new Set(prev).add(key))}
        items={LEGAL_DOCS.map((doc) => ({
          key: doc.key,
          label: doc.title,
          children: <PlainDoc text={doc.text} className="consent-doc" />,
        }))}
      />
      <div className="consent-version">条款版本 {version || '读不出来'}{consent.acceptedAt ? ` · 已于 ${new Date(consent.acceptedAt).toLocaleString('zh-CN', { hour12: false })} 同意` : ''}</div>
    </Modal>
  );
}
