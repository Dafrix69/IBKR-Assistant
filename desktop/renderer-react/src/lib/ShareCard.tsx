/**
 * 绩效体检的「分享卡片」:按当前范围把核心数字画成一张图,拷贝或另存(画法与口径见 lib/shareCardDraw.ts)。
 *
 * 默认不带金额——比例就够说明系统好不好,账户多大是隐私;要带金额得自己拨开。
 * 图在本机画、交给主进程写剪贴板或存盘,不经过任何网络。
 */
import { useMemo, useState } from 'react';
import { App, Button, Modal, Space, Switch } from 'antd';
import { dafri, errorMessage } from '../bridge';
import type { PerformanceKind, PerformanceScope, ReviewPerformanceResult } from '../bridge';
import { useUpDown } from '../store/appearance';
import { drawShareCard } from './shareCardDraw';

export function ShareCardButton({ data, scope, kind, days }: {
  data: ReviewPerformanceResult; scope: PerformanceScope; kind: PerformanceKind; days: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)} disabled={!data.stats.trades}>
        分享卡片
      </Button>
      {open ? <ShareCardModal data={data} scope={scope} kind={kind} days={days} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ShareCardModal({ data, scope, kind, days, onClose }: {
  data: ReviewPerformanceResult; scope: PerformanceScope; kind: PerformanceKind; days: number; onClose: () => void;
}) {
  const { message } = App.useApp();
  const updown = useUpDown();
  const [showAmounts, setShowAmounts] = useState(false);
  const [busy, setBusy] = useState<'copy' | 'save' | null>(null);
  // 每换一个选项重画一次;画一张 1080×1350 的图是几毫秒的事
  const dataUrl = useMemo(
    () => drawShareCard(data, { scope, kind, days, showAmounts, redUp: updown === 'red-up' }).toDataURL('image/png'),
    [data, scope, kind, days, showAmounts, updown],
  );

  async function run(action: 'copy' | 'save') {
    setBusy(action);
    try {
      const res = await dafri.exportImage(action, dataUrl, `交易体检-${new Date().toISOString().slice(0, 10)}`);
      if (res.ok) message.success(action === 'copy' ? '已拷贝到剪贴板,可以直接粘贴' : `已保存:${res.path ?? ''}`);
    } catch (err) {
      message.error(`${action === 'copy' ? '拷贝' : '保存'}失败:${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      open
      title="分享卡片"
      onCancel={onClose}
      width={460}
      footer={
        <Space>
          <Button loading={busy === 'save'} onClick={() => void run('save')}>
            存为 PNG
          </Button>
          <Button type="primary" loading={busy === 'copy'} onClick={() => void run('copy')}>
            拷贝图片
          </Button>
        </Space>
      }
    >
      <div className="share-card">
        <img className="share-card-preview" src={dataUrl} alt="分享卡片预览" />
        <label className="share-card-toggle">
          <Switch size="small" checked={showAmounts} onChange={setShowAmounts} />
          <span>显示金额(净盈亏与最大回撤)</span>
        </label>
        <div className="share-card-hint">
          默认只有比例,不含金额、账户与持仓明细;账本里有模拟盘交易会写明,笔数不到 20 会注明样本偏少。图在本机生成,不上传。
        </div>
      </div>
    </Modal>
  );
}
