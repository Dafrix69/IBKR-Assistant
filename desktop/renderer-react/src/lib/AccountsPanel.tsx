/**
 * 接入页「账户」那一节:给券商账户起别名、标明纸面还是实盘、挂到哪条连接上。
 *
 * 指令里说的「模拟」「主账户」就是这里的别名;大模型只见得到别名,见不到账号。
 * 保存不经过引擎:表单里的值交给主进程,它校验、弹一个原生确认框(写着将要写进配置的每一项)、
 * 写配置、重启引擎(desktop/accounts-setup.js)。账号只在提交的那一刻出现——列表里显示的是打了码的。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Segmented, Select, Space } from 'antd';
import { dafri, errorMessage, type Account, type AccountChange, type AccountsInfo } from '../bridge';
import { showBanner } from '../store/banner';
import { refreshStatus, useStatus } from '../store/status';
import { Pill } from '../ui/graphics';
import { EmptyState, Group, GroupRow, Notice, SectionTitle } from '../ui/kit';

interface Draft {
  /** 正在改的那个别名;null = 新加 */
  editing: string | null;
  alias: string;
  accountId: string;
  paper: boolean;
  connection: string;
  makeDefault: boolean;
}

const KIND = [
  { value: 'paper', label: '纸面(模拟)' },
  { value: 'live', label: '实盘' },
];

export function AccountsPanel() {
  const status = useStatus();
  const accounts: Account[] = status?.accounts || [];
  const [info, setInfo] = useState<AccountsInfo | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await dafri.accountsInfo());
    } catch {
      setInfo({ placeholders: [], connections: [] });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connections = info?.connections || [];
  const placeholders = new Set(info?.placeholders || []);
  const brokerOf = (name: string) => connections.find((c) => c.name === name)?.broker || 'ibkr';

  function open(account: Account | null) {
    setDraft({
      editing: account?.alias ?? null,
      alias: account?.alias ?? '',
      accountId: '',
      paper: account ? account.is_paper : true,
      connection: account?.connection ?? connections[0]?.name ?? '',
      makeDefault: account ? account.default : accounts.length === 0,
    });
  }

  async function submit(change: AccountChange) {
    setBusy(true);
    try {
      const done = await dafri.changeAccount(change);
      if (!done.ok) return;
      setDraft(null);
      showBanner('账户已保存,交易引擎正在重启。', true);
      // 引擎重启要几秒:等它起来再读状态
      setTimeout(() => {
        void refreshStatus();
        void load();
      }, 2500);
    } catch (err) {
      showBanner(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  const save = () => {
    if (!draft) return;
    void submit({
      action: 'upsert', alias: draft.alias.trim(), account_id: draft.accountId.trim(),
      is_paper: draft.paper, connection: draft.connection, make_default: draft.makeDefault,
    });
  };

  // 走 IBKR 的账户:账号不是 D 开头却选了纸面,保存一定会被拒——填的时候就说,不等点了保存
  const idText = draft?.accountId.trim() || '';
  const paperMismatch = Boolean(draft && draft.paper && idText && brokerOf(draft.connection) === 'ibkr' && !/^D/i.test(idText));

  return (
    <section className="sub-panel active" id="panel-accounts">
      <Notice title="别名是给指令用的,账号留在本机。">
        指令里写「模拟」「主账户」就是指这里的别名;发给大模型的只有别名,没有账号。纸面还是实盘决定这份订单要不要过「允许实盘账户下单」这道闸,请如实选。
      </Notice>
      {placeholders.size ? (
        <Notice tone="warn" title="还有账户用的是示例里的占位账号">
          {`「${[...placeholders].join('」「')}」的账号还是全零的占位。点「修改」填上你自己的账号(TWS 右上角、或「账户」窗口里看得到),不用的别名可以删掉。`}
        </Notice>
      ) : null}

      <SectionTitle count={accounts.length}>已配置的账户</SectionTitle>
      {!accounts.length ? (
        <EmptyState>{status ? '还没有配置账户。' : '交易引擎起来之后这里才读得到。'}</EmptyState>
      ) : (
        <Group>
          {accounts.map((a) => (
            <GroupRow
              key={a.alias}
              label={
                <span>
                  {a.alias} {a.default ? <Pill tint="blue">默认</Pill> : null}{' '}
                  <Pill tint={a.is_paper ? 'gray' : 'orange'}>{a.is_paper ? '纸面' : '实盘'}</Pill>
                </span>
              }
              sub={`${a.account_masked} · 连接 ${a.connection}${placeholders.has(a.alias) ? ' · 占位账号,还没填' : ''}`}
            >
              <Space size={8}>
                <Button size="small" onClick={() => open(a)}>
                  修改
                </Button>
                <Button size="small" danger disabled={busy} onClick={() => void submit({ action: 'remove', alias: a.alias })}>
                  删除
                </Button>
              </Space>
            </GroupRow>
          ))}
        </Group>
      )}

      {!draft ? (
        <div className="row tight">
          <Button type="primary" disabled={!connections.length} onClick={() => open(null)}>
            添加账户
          </Button>
        </div>
      ) : (
        <>
          <SectionTitle>{draft.editing ? `修改「${draft.editing}」` : '添加账户'}</SectionTitle>
          <Group hint="连接(端口、client id)不能从这里改:账户只能挂到配置里已有的连接上。保存时会弹出确认框,请对着它核对账号。">
            <GroupRow label="别名" sub="指令里怎么称呼它,如「模拟」「主账户」">
              <Input style={{ width: 220 }} maxLength={24} value={draft.alias} disabled={Boolean(draft.editing)} onChange={(e) => setDraft({ ...draft, alias: e.target.value })} />
            </GroupRow>
            <GroupRow label="账号" sub={draft.editing ? '为了不把账号显示出来,修改时要重新填一遍' : 'IBKR:U 或 DU 开头加数字;富途:纯数字'}>
              <Input style={{ width: 220 }} maxLength={15} autoComplete="off" spellCheck={false} placeholder="如 DU1234567" value={draft.accountId} onChange={(e) => setDraft({ ...draft, accountId: e.target.value })} />
            </GroupRow>
            <GroupRow label="类别" sub={paperMismatch ? <span className="warn-text">这个账号不是模拟账号的样子(模拟账号以 D 开头),不能标成纸面</span> : '实盘账户的订单要过「允许实盘账户下单」这道闸'}>
              <Segmented size="small" options={KIND} value={draft.paper ? 'paper' : 'live'} onChange={(v) => setDraft({ ...draft, paper: v === 'paper' })} />
            </GroupRow>
            <GroupRow label="连接" sub="经哪条连接下单">
              <Select
                size="small"
                style={{ width: 220 }}
                value={draft.connection}
                onChange={(v) => setDraft({ ...draft, connection: v })}
                options={connections.map((c) => ({ value: c.name, label: `${c.name} · ${c.broker === 'futu' ? '富途' : 'IBKR'}${c.port ? ` · 端口 ${c.port}` : ''}` }))}
              />
            </GroupRow>
            <GroupRow label="默认账户" sub="指令里没点名账户时发到它">
              <Segmented size="small" options={[{ value: 'yes', label: '是' }, { value: 'no', label: '否' }]} value={draft.makeDefault ? 'yes' : 'no'} onChange={(v) => setDraft({ ...draft, makeDefault: v === 'yes' })} />
            </GroupRow>
          </Group>
          <div className="row tight">
            <Button type="primary" loading={busy} disabled={!draft.alias.trim() || !idText || !draft.connection || paperMismatch} onClick={save}>
              保存…
            </Button>
            <Button onClick={() => setDraft(null)}>取消</Button>
          </div>
        </>
      )}
    </section>
  );
}
