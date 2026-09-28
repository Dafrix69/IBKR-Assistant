/**
 * 「关于」页的「支持」一节:出了问题时要用到的几样东西。
 *
 * 诊断信息是主进程拼的(desktop/diagnostics.js):版本与系统、引擎状态、脱敏后的配置、最近的日志;
 * 不含交易记录、成交、持仓、API Key,真实账号已打码。存到哪由主进程的保存对话框定。
 */
import { useEffect, useState } from 'react';
import { Button, Space } from 'antd';
import { dafri, errorMessage } from '../bridge';
import { showBanner } from '../store/banner';
import { showTerms } from '../store/consent';
import { Group, GroupRow } from '../ui/kit';

export async function exportDiagnostics(): Promise<void> {
  try {
    const done = await dafri.exportDiagnostics();
    if (done.ok) showBanner('诊断信息已导出,发出去之前建议自己先看一遍。', true);
  } catch (err) {
    showBanner(`导出没有成功:${errorMessage(err)}`, false);
  }
}

export function SupportPanel() {
  const [busy, setBusy] = useState(false);

  // 菜单里的「导出诊断信息…」和这里的按钮走同一条路
  useEffect(
    () => dafri.on('menu', ({ action }) => {
      if (action === 'export-diagnostics') void exportDiagnostics();
    }),
    [],
  );

  const open = (kind: 'logs' | 'config' | 'notices') => () =>
    void dafri.reveal(kind).catch((err) => showBanner(errorMessage(err), false));

  async function run() {
    setBusy(true);
    try {
      await exportDiagnostics();
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await dafri.copyDiagnostics();
      showBanner('已拷贝:版本、系统、引擎与券商连接状态。', true);
    } catch (err) {
      showBanner(errorMessage(err), false);
    }
  }

  return (
    <Group
      className="support-panel"
      hint="诊断信息里有版本与系统、引擎状态、脱敏后的配置、最近的日志;没有交易记录、成交、持仓与 API Key,真实账号已打码。"
    >
      <GroupRow key="diag" label="诊断信息" sub="遇到问题时导出一份,连同问题描述一起发给支持">
        <Space size={8} wrap>
          <Button size="small" type="primary" loading={busy} onClick={() => void run()}>
            导出诊断信息…
          </Button>
          <Button size="small" onClick={() => void copy()}>
            拷贝概要
          </Button>
        </Space>
      </GroupRow>
      <GroupRow key="files" label="文件位置" sub="日志、配置文件所在的文件夹">
        <Space size={8} wrap>
          <Button size="small" onClick={open('logs')}>
            打开日志所在位置
          </Button>
          <Button size="small" onClick={open('config')}>
            打开配置文件所在位置
          </Button>
        </Space>
      </GroupRow>
      <GroupRow key="legal" label="条款与许可" sub="风险揭示、使用条款、隐私说明;本软件用到的开源组件及其许可">
        <Space size={8} wrap>
          <Button size="small" onClick={showTerms}>
            查看条款
          </Button>
          <Button size="small" onClick={open('notices')}>
            第三方许可声明
          </Button>
        </Space>
      </GroupRow>
    </Group>
  );
}
