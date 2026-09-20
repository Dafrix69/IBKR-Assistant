/** 接入页三节(TWS / 富途 OpenD / 大模型)共用的展示构件。
 *
 * 2026-09-21 从 pages/Access.tsx 搬出来(函数体逐字未改)。三节各自成了 lib/ 下的一个文件,
 * 公用的这几样放这里,页面与三节都从这里拿(page → lib 是允许的方向)。
 */
import type { ReactNode } from 'react';
import { Meta, StatusCard, type Tone } from '../ui/kit';

export function InfoCard({ tone, title, body, meta, children }: { tone: Tone; title: string; body?: string | null; meta?: string[]; children?: ReactNode }) {
  return (
    <StatusCard tone={tone} title={title}>
      {body ? <div>{body}</div> : null}
      {meta && meta.length ? <Meta items={meta} /> : null}
      {children}
    </StatusCard>
  );
}
