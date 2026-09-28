/**
 * 「关于」页的「更新」一节:当前版本、GitHub 上最新的正式版、下载链接、自动检查开关。
 *
 * 链接走 <a target="_blank">:主进程的 setWindowOpenHandler 把 https 链接交给系统浏览器,
 * 而这些地址在主进程里已经核对过只会是本仓库 releases 下的页面(desktop/update-check.js)。
 * 发布说明当文本显示——React 默认转义,这里不解析 Markdown。
 */
import { Button, Space } from 'antd';
import { checkUpdate, dismissUpdate, setAutoUpdateCheck, useUpdate } from '../store/update';
import { Group, GroupRow, SwitchRow } from '../ui/kit';

function fmtSize(bytes: number | null): string {
  if (!bytes || !Number.isFinite(bytes)) return '';
  return ` · ${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function UpdatePanel({ current }: { current: string | null }) {
  const { info, checking, error, auto, dismissed } = useUpdate();

  let status: string;
  if (checking && !info) status = '正在检查…';
  else if (error && !info) status = error;
  else if (!info) status = '还没检查过';
  else if (info.newer) status = `有新版本 ${info.latest}${info.publishedAt ? `(${fmtDate(info.publishedAt)} 发布)` : ''}`;
  else if (info.latest) status = `已是最新版本(GitHub 上最新是 ${info.latest})`;
  else status = '没读出最新的版本号';

  const newer = info?.newer ? info : null;
  const newerVersion = newer?.latest ?? null;

  return (
    <>
      <Group
        className="update-panel"
        hint="只读取 GitHub 上公开的发布信息;不下载、不安装、不上传任何数据。下载的安装包装上去会替换旧版,配置与交易记录都在用户目录里,不受影响。"
      >
        <GroupRow
          key="status"
          label={`当前版本 ${current || info?.current || '—'}`}
          sub={error && info ? `${status} · 上次检查失败:${error}` : status}
        >
          <Space size={8} wrap>
            {newer?.download ? (
              <Button type="primary" size="small" href={newer.download.url} target="_blank" rel="noreferrer">
                下载 {newer.latest}
                {fmtSize(newer.download.size)}
              </Button>
            ) : null}
            {newer ? (
              <Button size="small" href={newer.url} target="_blank" rel="noreferrer">
                {newer.download ? '发布页' : '去发布页下载'}
              </Button>
            ) : null}
            {newerVersion && newerVersion !== dismissed ? (
              <Button size="small" type="text" onClick={() => dismissUpdate(newerVersion)}>
                忽略这一版
              </Button>
            ) : null}
            <Button size="small" loading={checking} onClick={() => void checkUpdate(true)}>
              检查更新
            </Button>
          </Space>
        </GroupRow>
        <SwitchRow
          key="auto"
          label="自动检查更新"
          sub="启动后查一次,之后每 12 小时一次"
          checked={auto}
          onChange={setAutoUpdateCheck}
        />
      </Group>
      {newer?.notes ? <pre className="log update-notes">{newer.notes}</pre> : null}
    </>
  );
}
