/**
 * 「设置」页的「数据与备份」一节:交易库在哪、有哪些备份、现在备份一份、从某一份恢复。
 *
 * 备份是引擎出的(每天第一次打开、升级之前各一份,口径见 engine-ts/src/storeSafety.ts);
 * 恢复要停引擎、换库文件,由主进程做——这里只递一个文件名,确认框也是主进程弹的。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Space } from 'antd';
import { dafri, errorMessage, type BackupInfo, type DataBackupsResult } from '../bridge';
import { showBanner } from '../store/banner';
import { refreshStatus } from '../store/status';
import { Group, GroupRow, LoadingBlock } from '../ui/kit';
import { fmtTime } from './format';

type Backups = DataBackupsResult;
type Backup = BackupInfo;

const REASON: Record<Backup['reason'], string> = { daily: '每日自动', upgrade: '升级前', manual: '手动' };

function fmtBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function DataPanel() {
  const [info, setInfo] = useState<Backups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await dafri.listBackups());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function backupNow() {
    setBusy('backup');
    try {
      const { backup } = await dafri.backupNow();
      showBanner(`已备份:${backup.name}(${fmtBytes(backup.bytes)})`, true);
      await load();
    } catch (err) {
      showBanner(errorMessage(err), false);
    } finally {
      setBusy(null);
    }
  }

  async function restore(b: Backup) {
    setBusy(b.name);
    try {
      const done = await dafri.restoreBackup(b.name);
      if (done.ok) {
        showBanner('交易库已恢复,交易引擎正在重启。请核对追踪与挂单状态。', true);
        // 引擎重启要几秒:等它起来再读清单与状态
        setTimeout(() => {
          void load();
          void refreshStatus();
        }, 2500);
      }
    } catch (err) {
      showBanner(`恢复没有成功:${errorMessage(err)}`, false);
    } finally {
      setBusy(null);
    }
  }

  const reveal = () => void dafri.reveal('backups').catch((err) => showBanner(errorMessage(err), false));

  if (error) {
    return (
      <Group hint="交易引擎起来之后这里才读得到。">
        <GroupRow label="读不到备份清单" sub={error}>
          <Button size="small" onClick={() => void load()}>
            重试
          </Button>
        </GroupRow>
      </Group>
    );
  }
  if (!info) return <LoadingBlock rows={3} />;

  return (
    <Group
      className="data-panel"
      hint="每天第一次打开、每次升级之前,软件会自动给交易库留一份备份(每日 7 份、升级前 3 份、手动 5 份,旧的自动清掉)。备份和交易库在同一块盘上:换电脑、防硬盘损坏,请把备份目录另拷一份到别处。"
    >
      <GroupRow key="db" label="交易库" sub={<span className="mono selectable">{info.db_path}</span>}>
        <Space size={8} wrap>
          <Button size="small" loading={busy === 'backup'} onClick={() => void backupNow()}>
            立即备份
          </Button>
          <Button size="small" onClick={reveal}>
            打开备份目录
          </Button>
        </Space>
      </GroupRow>
      {info.backups.length === 0 ? (
        <GroupRow key="none" label="还没有备份" sub="第一份会在下一次启动时自动留下,也可以现在点「立即备份」" />
      ) : (
        info.backups.map((b) => (
          <GroupRow key={b.name} label={fmtTime(b.at)} sub={`${REASON[b.reason]} · ${fmtBytes(b.bytes)}`}>
            <Button size="small" loading={busy === b.name} disabled={busy !== null && busy !== b.name} onClick={() => void restore(b)}>
              恢复到这一份…
            </Button>
          </GroupRow>
        ))
      )}
    </Group>
  );
}
