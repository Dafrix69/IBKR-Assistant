/**
 * 「提醒方式」:弹窗 + 提示音两个开关。板块页的价位提醒和优质股页的异动提醒共用这一份偏好——
 * 两处各摆一组同样的开关,拨哪一处都是同一个值,不会出现"这边开着那边关着"的困惑。
 */
import type { ReactNode } from 'react';
import { Button } from 'antd';
import { previewAlertTone, setSoundEnabled, useSoundEnabled } from '../store/alerts';
import { setPopupEnabled, testPopup, usePopupEnabled } from '../store/popup';
import { Group, SwitchRow } from '../ui/kit';

export function AlertMethods({ popupSub, soundSub, hint }: { popupSub: ReactNode; soundSub: ReactNode; hint?: ReactNode }) {
  const popup = usePopupEnabled();
  const sound = useSoundEnabled();
  return (
    <Group className="alert-methods" hint={hint}>
      <SwitchRow
        key="popup"
        label="弹窗提醒"
        sub={popupSub}
        checked={popup}
        onChange={setPopupEnabled}
        before={
          <Button size="small" onClick={() => testPopup()}>
            试弹
          </Button>
        }
      />
      <SwitchRow
        key="sound"
        label="提示音"
        sub={soundSub}
        checked={sound}
        onChange={setSoundEnabled}
        before={
          <Button size="small" onClick={() => previewAlertTone()}>
            试听
          </Button>
        }
      />
    </Group>
  );
}
