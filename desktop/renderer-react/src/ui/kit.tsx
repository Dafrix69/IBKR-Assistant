/**
 * 页面共用的构件:全部基于 Ant Design 的组件,按 macOS 的样子配好——各页只组装,不再各自手写卡片 / 空态 / 提示条。
 *
 *   PageHead      大标题 + 右侧一组操作(吸顶)
 *   SectionTitle  分组小标题(System Settings 那种 11px 二级色标签),可带条数
 *   StatusCard    带状态标(✓ / ! / ×)的卡片,状态用图标表达,不用彩色边条
 *   Meta          卡片里的一行元数据:二级色文字,不是一排胶囊
 *   Group / GroupRow / SwitchRow / NumberRow   内嵌分组列表与它的三种行
 *   Notice        提示条:说明类是中性的面,警告 / 错误 / 成功只淡染
 *   Primer        "这一页怎么用":一行三级色文字 + 折叠箭头,状态记在本地
 *   EmptyState / Working / LoadingBlock        空态、行内忙碌、骨架屏
 *   Feed          通知流
 *   StatTile      数字瓦片
 */
import { Children, type ReactNode, useId, useState } from 'react';
import { Alert, Badge, Card, Collapse, Empty, InputNumber, List, Skeleton, Spin, Statistic, Switch } from 'antd';
import { IconTile, type Tint } from './graphics';
import { CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled, RightOutlined } from '@ant-design/icons';

export type Tone = 'ok' | 'warn' | 'bad' | 'info';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 预览台的 data: 页面没有 localStorage */
  }
}

// ---- 标题 ----------------------------------------------------------------

export function PageHead({ title, extra }: { title: string; extra?: ReactNode }) {
  return (
    <header className="page-head">
      <h1>{title}</h1>
      {extra}
    </header>
  );
}

export function SectionTitle({ children, count, className, innerRef }: { children: ReactNode; count?: number; className?: string; innerRef?: React.Ref<HTMLHeadingElement> }) {
  return (
    <h3 className={cx('section-title', className)} ref={innerRef}>
      {children}
      {count !== undefined ? <Badge className="count-badge" count={count} showZero size="small" overflowCount={999} /> : null}
    </h3>
  );
}

// ---- 卡片 ----------------------------------------------------------------

const TONE_ICON: Record<Tone, ReactNode> = {
  ok: <CheckCircleFilled className="tone-icon ok" />,
  warn: <ExclamationCircleFilled className="tone-icon warn" />,
  bad: <CloseCircleFilled className="tone-icon bad" />,
  info: null,
};

export function ToneIcon({ tone }: { tone: Tone }) {
  return <>{TONE_ICON[tone]}</>;
}

/** 卡片不带彩色左边条(Apple 的卡片没有这个元素);状态用标题前一枚圆标表达,和 System Settings 的 ✓ / ! 一致。info 是中性的,不加标。 */
export function StatusCard({
  tone = 'info',
  title,
  extra,
  children,
  className,
  id,
  flash,
}: {
  tone?: Tone;
  title?: ReactNode;
  extra?: ReactNode;
  children?: ReactNode;
  className?: string;
  id?: string;
  flash?: boolean;
}) {
  return (
    <Card
      size="small"
      id={id}
      className={cx('status-card', `tone-${tone}`, flash && 'just-added', className)}
      title={
        title !== undefined && title !== null ? (
          <span className="status-card-title">
            <ToneIcon tone={tone} />
            <span className="status-card-text">{title}</span>
          </span>
        ) : undefined
      }
      extra={extra}
    >
      {children}
    </Card>
  );
}

/** 卡片里的元数据:一行二级色文字,项之间留 14px。空项自动跳过。 */
export function Meta({ items, className, title }: { items: ReactNode[]; className?: string; title?: string }) {
  const live = items.filter((m) => m !== null && m !== undefined && m !== false && m !== '');
  if (!live.length) return null;
  return (
    <div className={cx('card-meta', className)} title={title}>
      {live.map((m, i) => (
        <span key={i}>{m}</span>
      ))}
    </div>
  );
}

// ---- 内嵌分组列表 ----------------------------------------------------------

/** System Settings 那种内嵌分组列表:子项写成 <GroupRow> / <SwitchRow> / <NumberRow>。 */
export function Group({ children, className, hint }: { children: ReactNode; className?: string; hint?: ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <List
      bordered
      size="small"
      className={cx('group', className)}
      dataSource={rows}
      rowKey={(item) => String((item as { key?: string | number }).key ?? '')}
      renderItem={(item) => item as ReactNode}
      footer={hint ? <div className="group-hint">{hint}</div> : undefined}
    />
  );
}

/** 一行:左边标签(可带一行小字),右边控件;stacked 时控件占满下一行(长输入框)。 */
/** 行首的彩色图标瓦片(iOS 设置的每一行都有):icon 给了才画。 */
function RowIcon({ icon, tint }: { icon?: string; tint?: Tint }) {
  return icon ? <IconTile icon={icon} tint={tint} size={28} className="row-icon" /> : null;
}

export function GroupRow({ label, sub, children, className, stacked, icon, tint }: { label?: ReactNode; sub?: ReactNode; children?: ReactNode; className?: string; stacked?: boolean; icon?: string; tint?: Tint }) {
  return (
    <List.Item className={cx('group-row', stacked && 'stacked', className)}>
      {!stacked ? <RowIcon icon={icon} tint={tint} /> : null}
      {label !== undefined ? (
        <div className="group-label">
          {label}
          {sub ? <span className="sub">{sub}</span> : null}
        </div>
      ) : null}
      {children !== undefined ? <div className="group-control">{children}</div> : null}
    </List.Item>
  );
}

export function SwitchRow({
  label,
  sub,
  checked,
  onChange,
  disabled,
  before,
  className,
  icon,
  tint,
}: {
  icon?: string;
  tint?: Tint;
  label: ReactNode;
  sub?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** 开关左边再放一组小控件(如「试听」) */
  before?: ReactNode;
  className?: string;
}) {
  // label 必须用 htmlFor 指名开关:不指名时它绑的是**第一个**可标注的后代,
  // 有 before 按钮的行里那就是「试听 / 试弹」——点一下文字,拨不动开关,反倒弹出一扇示例窗
  const id = useId();
  return (
    <List.Item className={cx('group-row', className)}>
      {/* 整行是一个 label:点文字也能拨开关,和 System Settings 一样 */}
      <label className="switch-row" htmlFor={id}>
        <RowIcon icon={icon} tint={tint} />
        <span className="group-label">
          {label}
          {sub ? <span className="sub">{sub}</span> : null}
        </span>
        <span className="group-control">
          {before}
          <Switch id={id} checked={checked} onChange={onChange} disabled={disabled} />
        </span>
      </label>
    </List.Item>
  );
}

export function NumberRow({
  label,
  sub,
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  disabled,
  width = 190,
  icon,
  tint,
}: {
  icon?: string;
  tint?: Tint;
  label: ReactNode;
  sub?: ReactNode;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  disabled?: boolean;
  width?: number;
}) {
  return (
    <GroupRow label={label} sub={sub} icon={icon} tint={tint}>
      <InputNumber
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={(v) => onChange(v === null || v === undefined ? null : Number(v))}
        style={{ width }}
      />
    </GroupRow>
  );
}

// ---- 提示与说明 ------------------------------------------------------------

const ALERT_TYPE: Record<Tone, 'success' | 'warning' | 'error' | 'info'> = { ok: 'success', warn: 'warning', bad: 'error', info: 'info' };

/** 提示条。有 title 时正文进 description;没有就整段当 message。 */
export function Notice({ tone = 'info', title, children, className, closable }: { tone?: Tone; title?: ReactNode; children?: ReactNode; className?: string; closable?: boolean }) {
  return (
    <Alert
      className={cx('notice', className)}
      type={ALERT_TYPE[tone]}
      showIcon
      closable={closable}
      message={title ?? children}
      description={title !== undefined && title !== null ? children : undefined}
    />
  );
}

/**
 * 参考资料:默认收起(intro:一行三级色文字,不是一个盒子)或按需展开;手动点过一次就记住用户的选择。
 * localStorage 的键沿用旧界面(dafri-primer-<id>),迁移不丢用户的选择。
 */
export function Primer({ id, summary, intro, defaultOpen, children, className }: { id: string; summary: ReactNode; intro?: boolean; defaultOpen?: boolean; children: ReactNode; className?: string }) {
  const key = `dafri-primer-${id}`;
  const [open, setOpen] = useState<boolean | null>(() => {
    const saved = read(key);
    return saved === null ? null : saved === '1';
  });
  const active = open === null ? Boolean(defaultOpen) : open;
  return (
    <Collapse
      ghost
      size="small"
      className={cx('primer', intro && 'intro', className)}
      activeKey={active ? ['p'] : []}
      onChange={(keys) => {
        const next = (Array.isArray(keys) ? keys : [keys]).length > 0;
        setOpen(next);
        write(key, next ? '1' : '0');
      }}
      expandIcon={({ isActive }) => <RightOutlined rotate={isActive ? 90 : 0} />}
      items={[{ key: 'p', label: summary, children }]}
    />
  );
}

// ---- 空态 / 忙碌 ----------------------------------------------------------

/** 空态就是一句二级色的话 + 一个淡淡的托盘,不画虚线框——那是网页后台的习惯。 */
export function EmptyState({ children, className, compact }: { children: ReactNode; className?: string; compact?: boolean }) {
  return <Empty className={cx('empty-state', compact && 'compact', className)} image={Empty.PRESENTED_IMAGE_SIMPLE} description={children} />;
}

/** 行内的"正在做某事":小圈 + 一句话。 */
export function Working({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx('working', className)}>
      <Spin size="small" />
      <span>{children}</span>
    </span>
  );
}

/** 数据还没到时的骨架:比一句「加载中…」稳,不会在到位那一刻跳版。 */
export function LoadingBlock({ rows = 3, className }: { rows?: number; className?: string }) {
  return <Skeleton active title={false} paragraph={{ rows, width: ['62%', '48%', '54%', '40%', '58%'].slice(0, rows) }} className={cx('loading-block', className)} />;
}

// ---- 通知流 ----------------------------------------------------------------

export function Feed({ items, empty, className }: { items: { at: string; text: string }[]; empty: ReactNode; className?: string }) {
  return (
    <List
      className={cx('feed', className)}
      size="small"
      split={false}
      dataSource={items}
      locale={{ emptyText: <EmptyState compact>{empty}</EmptyState> }}
      renderItem={(item, i) => (
        <List.Item className="feed-item" key={i}>
          <time>{item.at}</time>
          <span>{item.text}</span>
        </List.Item>
      )}
    />
  );
}

// ---- 数字瓦片 --------------------------------------------------------------

/** 一个数 + 它的名字。值已格式化成字符串,颜色只在有方向时才给(0 不着色)。 */
export function StatTile({ label, value, tone, mono }: { label: ReactNode; value: ReactNode; tone?: 'pos' | 'neg' | 'hot' | 'cold' | '' | null; mono?: boolean }) {
  return (
    <div className={cx('stat-tile', tone || undefined, mono && 'mono')}>
      <Statistic title={label} value={typeof value === 'string' || typeof value === 'number' ? value : undefined} formatter={typeof value === 'string' || typeof value === 'number' ? undefined : () => value} />
    </div>
  );
}
