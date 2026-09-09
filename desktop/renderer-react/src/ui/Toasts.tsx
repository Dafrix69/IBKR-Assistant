/**
 * 横幅 → 通知:store/banner.ts 的 showBanner / hideBanner 契约不变(各 store 都在调),
 * 显示改用 AntD 的 notification,从窗口顶部中央落下来——macOS 的通知就是这个位置和这个节奏。
 * 提示类 6 秒自己走(store 里的定时器),错误类留着等人看;两者都有关闭按钮。
 * 同一条消息反复来(熔断时每轮状态都会喊一次)store 不会重发,这里也就不会闪。
 */
import { useEffect } from 'react';
import { App as AntdApp } from 'antd';
import { hideBanner, useBanner } from '../store/banner';

const KEY = 'dafri-banner';

export function Toasts() {
  const { notification } = AntdApp.useApp();
  const banner = useBanner();

  useEffect(() => {
    if (!banner) {
      notification.destroy(KEY);
      return;
    }
    notification.open({
      key: KEY,
      message: banner.message,
      type: banner.info ? 'info' : 'error',
      placement: 'top',
      duration: 0,
      closable: true,
      onClose: hideBanner,
      className: 'toast',
    });
  }, [banner, notification]);

  return null;
}
