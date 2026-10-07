/** 接入页「Discord 跟单」那一节:存 bot token、选频道与信任的发送者、定上限、开关,以及最近的信号。
 *
 * 表单的检查与拼装在 lib/followForm.ts(纯逻辑,引擎那边的测试直接跑)。
 * 打开、放宽都要过主进程的原生确认框(purpose: gate.follow):框上的字由主进程对着要存的那一份写,这里改不了。
 * 关是当场生效的,不等「保存」。bot token 只往 follow.set_token 送(它写系统凭证库),不落在这一层。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Input, Space, Tag } from 'antd';
import { dafri, errorMessage } from '../bridge';
import type { FollowLink, FollowStatus } from '../bridge';
import { showBanner } from '../store/banner';
import { useStatus } from '../store/status';
import { EmptyState, Group, GroupRow, LoadingBlock, Notice, NumberRow, Primer, SectionTitle, StepList, SwitchRow } from '../ui/kit';
import { fmtTime } from './format';
import { OUTCOME_LABEL, addAuthor, formProblems, isDirty, outcomeTone, toConfig, toForm, type FollowForm } from './followForm';

const SETUP_STEPS = [
  { title: '建一个 bot', detail: 'Discord Developer Portal → New Application → 左侧 Bot → Reset Token,把那一整段复制到下面保存。' },
  { title: '打开 Message Content Intent', detail: '同一页往下:Privileged Gateway Intents → Message Content Intent。不开的话 bot 看不到消息正文。' },
  { title: '把 bot 拉进一个你能管理的服务器', detail: 'OAuth2 → URL Generator 勾 bot,权限只要 View Channels 与 Read Message History;打开生成的链接,选你自己的服务器。' },
  { title: '让单子出现在 bot 看得到的频道里', detail: '对方的频道是公告频道:点它的「关注」,转到你服务器的一个频道。不是公告频道:请对方同时在你的服务器里发一份,或者请那边的管理员把 bot 拉进去。' },
  { title: '填频道 ID、挑信任的发送者', detail: 'Discord 设置 → 高级 → 开发者模式;之后右键频道 →「复制频道 ID」。存好之后等对方发一条消息,在下面「频道里最近看到的消息」里点「信任」。' },
];

const INBOX_STEPS = [
  { title: '让 Discord 把消息暴露给辅助功能', detail: '退出 Discord,在终端里用 open -a Discord --args --force-renderer-accessibility 重新打开。不带这个参数时,窗口里的消息读不到(脚本会说明)。' },
  { title: '给终端辅助功能权限', detail: '系统设置 → 隐私与安全性 → 辅助功能,把你运行脚本用的终端加进去。' },
  { title: '运行脚本,停在那个频道', detail: '脚本在仓库的 desktop/tools/discord-window-follow.swift:swift 那个文件 --channel 频道名 --out 下面显示的收件文件路径。Discord 要一直开着并停在这个频道,电脑不能锁屏、不能睡。' },
  { title: '信任显示名', detail: '对方发一条之后,在「频道里最近看到的消息」里点「信任」(条目是 local:显示名)。注意:频道里别人把昵称改成一样的,软件分不出来——只适合私密小群。' },
];

function linkText(link: FollowLink, tokenSaved: boolean, inboxOn: boolean): { tone: 'ok' | 'warn' | 'bad' | 'info'; text: string } {
  if (link.state === 'off' && inboxOn) return { tone: 'info', text: '没有填频道 ID,不连 Discord;消息只来自本地收件。' };
  if (link.state === 'ready') {
    if (link.channel_known === false) return { tone: 'warn', text: `已连上(bot:${link.bot ?? '—'}),但 bot 所在的服务器里没有这个频道 ID:它听不到那里的消息。` };
    return { tone: 'ok', text: `已连上(bot:${link.bot ?? '—'}),正在听这个频道。` };
  }
  if (link.state === 'connecting') return { tone: 'info', text: link.error ?? '正在连接 Discord…' };
  if (link.state === 'failed') return { tone: 'bad', text: link.error ?? '连接失败。' };
  if (link.state === 'no_token') return { tone: 'warn', text: '还没有保存 bot token。' };
  return { tone: 'info', text: tokenSaved ? '还没有填频道 ID,没有连接 Discord。' : '还没有配置,没有连接 Discord。' };
}

export function FollowPanel() {
  const appStatus = useStatus();
  const accounts = appStatus?.accounts ?? [];
  const [status, setStatus] = useState<FollowStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FollowForm | null>(null);
  const [token, setToken] = useState('');
  const [newAuthor, setNewAuthor] = useState('');
  const [busy, setBusy] = useState<'token' | 'save' | 'reconnect' | null>(null);
  const [checked, setChecked] = useState(false);

  /** 读状态;resetForm = 表单也回到已保存的那一份(刚打开、刚保存之后)。平时刷新不动表单:人可能正填到一半。 */
  const load = useCallback(async (resetForm: boolean) => {
    try {
      const next = await dafri.followStatus();
      setStatus(next);
      setForm((f) => (f === null || resetForm ? toForm(next.config) : f));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load(true);
    return dafri.on('engine-event', ({ event }) => {
      if (event === 'follow') void load(false);
    });
  }, [load]);

  const patch = (part: Partial<FollowForm>) => setForm((f) => (f ? { ...f, ...part } : f));
  const problems = form ? formProblems(form) : [];
  const dirty = form && status ? isDirty(form, status.config) : false;

  async function saveToken() {
    if (!token.trim()) return;
    setBusy('token');
    try {
      setStatus(await dafri.setFollowToken(token.trim()));
      setToken('');
      showBanner('bot token 已写入系统凭证库。', true);
    } catch (err) {
      showBanner(`没有存上:${errorMessage(err)}`, false);
    } finally {
      setBusy(null);
    }
  }

  async function reconnect() {
    setBusy('reconnect');
    try {
      setStatus(await dafri.reconnectFollow());
    } catch (err) {
      showBanner(`重新连接失败:${errorMessage(err)}`, false);
    } finally {
      setBusy(null);
    }
  }

  /** 开关:关是当场生效的(和「设置」页的执行闸门一样);开只改表单,跟着「保存」走确认框。 */
  async function setEnabled(on: boolean) {
    patch({ enabled: on });
    if (on || !status?.config.enabled) return;
    try {
      await dafri.patchSettings({ follow: { enabled: false } });
      showBanner('已关闭自动跟单,当场生效。频道照常在听,只观察、不发单。', true);
      await load(false);
    } catch (err) {
      patch({ enabled: true });
      showBanner(`没有关掉:${errorMessage(err)}`, false);
    }
  }

  async function save() {
    if (!form) return;
    setChecked(true);
    if (problems.length) {
      showBanner(`还不能保存:${problems[0]}${problems.length > 1 ? `(另有 ${problems.length - 1} 处)` : ''}`, false);
      return;
    }
    const next = toConfig(form);
    if (next.enabled) {
      // 从关到开、换频道、多信任一个人、换账户、调大上限,主进程都要一张确认凭据;只是往紧了改时它不弹框、直接回 true
      const ok = await dafri.confirm({ purpose: 'gate.follow', binding: next, title: '打开 Discord 自动跟单', message: '', confirmLabel: '我明白,打开跟单' });
      if (!ok) return;
    }
    setBusy('save');
    try {
      await dafri.patchSettings({ follow: next });
      showBanner(next.enabled ? '已保存:自动跟单开着。' : '已保存:只观察,不发单。', true);
      setChecked(false);
      await load(true);
    } catch (err) {
      showBanner(`保存失败(配置未改动):${errorMessage(err)}`, false);
    } finally {
      setBusy(null);
    }
  }

  if (loadError && !status) return <section className="sub-panel active" id="panel-follow"><EmptyState>读取失败:{loadError}</EmptyState></section>;
  if (!status || !form) return <section className="sub-panel active" id="panel-follow"><LoadingBlock rows={4} /></section>;

  const link = linkText(status.link, status.token_configured, form.localInbox);
  const inbox = status.inbox;
  const inboxText = inbox.error
    ? inbox.error
    : inbox.watching
      ? `正在读。这次启动以来收到 ${inbox.received} 条${inbox.last_at ? `,最近一条 ${fmtTime(inbox.last_at)}` : ''}`
      : form.localInbox ? '保存之后开始读' : '关着';
  const strangers = status.seen.filter((s) => !form.authorIds.includes(s.author_id));

  return (
    <section className="sub-panel active" id="panel-follow">
      <Notice tone="warn" title="信任的人在频道里发的蝴蝶单,不经确认直接发到券商。">
        只认本地速记完整接住的写法(如「1.8 挂15蝴蝶 15CM」),接不住的只提醒、不交给大模型猜。开关关着时只观察:照样解析、照样记在下面,但一张单都不发。
        <br />
        对方发错一条、或者对方的 Discord 账号被盗,都会变成你账户里的订单——先只观察几天,再打开。
      </Notice>

      <SectionTitle>1 · Bot 与连接</SectionTitle>
      <Group>
        <GroupRow stacked label={<>bot token 只存在系统凭证库(Keychain / 凭据管理器),不写配置、不进日志。<strong>不要填你自己账号的 token</strong>:用个人账号跑自动化违反 Discord 的条款,会被封号。</>}>
          <Input.Password placeholder={status.token_configured ? '已保存;要换就粘贴新的' : '粘贴 bot token'} autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </GroupRow>
        <GroupRow label="连接" sub={link.text} className={`follow-link tone-${link.tone}`}>
          <Space size={6}>
            <Button loading={busy === 'token'} disabled={!token.trim()} onClick={() => void saveToken()}>保存 token</Button>
            <Button loading={busy === 'reconnect'} disabled={!status.token_configured} onClick={() => void reconnect()}>重新连接</Button>
          </Space>
        </GroupRow>
      </Group>
      <Primer id="follow-setup" summary="第一次配置:五步" defaultOpen={!status.token_configured}>
        <StepList items={SETUP_STEPS} />
      </Primer>

      <SectionTitle>2 · 听哪个频道、信任谁</SectionTitle>
      <Group>
        <GroupRow icon="sf-antenna" tint="indigo" label="频道 ID" sub="bot 加入的服务器里的一个频道">
          <Input style={{ width: 230 }} placeholder="一串数字" value={form.channelId} onChange={(e) => patch({ channelId: e.target.value })} />
        </GroupRow>
        <GroupRow stacked label="信任的发送者" sub="只有这些人在这个频道发的消息才会被当成单子。关注过来的公告频道,发送者是那条关注本身(信任它 = 信任能在源频道发公告的人)。">
          <Space size={[6, 6]} wrap>
            {form.authorIds.map((id) => {
              const name = status.seen.find((s) => s.author_id === id)?.author_name;
              return <Tag key={id} closable onClose={() => patch({ authorIds: form.authorIds.filter((x) => x !== id) })}>{name ? `${name} · ${id}` : id}</Tag>;
            })}
            {!form.authorIds.length ? <span className="muted">还没有信任任何人</span> : null}
          </Space>
        </GroupRow>
        <GroupRow label="手动添加" sub="右键对方头像 →「复制用户 ID」;本地收件的写成 local:显示名">
          <Space size={6}>
            <Input style={{ width: 200 }} placeholder="用户 ID 或 local:显示名" value={newAuthor} onChange={(e) => setNewAuthor(e.target.value)} />
            <Button disabled={addAuthor(form, newAuthor) === form} onClick={() => { setForm(addAuthor(form, newAuthor)); setNewAuthor(''); }}>添加</Button>
          </Space>
        </GroupRow>
      </Group>
      <Group>
        <SwitchRow icon="sf-doc" tint="teal" label="本地收件" sub="对方的私密频道拉不进 bot 时:本机脚本从你屏幕上的 Discord 窗口把新消息抄进收件文件,软件读文件。不用任何 token,Discord 那边什么都收不到。" checked={form.localInbox} onChange={(v) => patch({ localInbox: v })} />
        <GroupRow label="收件文件" sub={inboxText} className={`follow-inbox tone-${inbox.error ? 'warn' : inbox.watching ? 'ok' : 'info'}`}>
          <span className="muted mono" style={{ wordBreak: 'break-all' }}>{inbox.path}</span>
        </GroupRow>
      </Group>
      <Primer id="follow-inbox-setup" summary="本地收件怎么用:四步" defaultOpen={false}>
        <StepList items={INBOX_STEPS} />
      </Primer>
      <p className="hint">频道里最近看到的消息(只在内存里,重启引擎就清空):</p>
      {status.seen.length ? (
        <Group>
          {status.seen.slice(0, 8).map((s, i) => (
            <GroupRow key={`${s.at}-${i}`} label={<>{s.author_name || '(没有名字)'} <span className="muted mono">{s.author_id}</span>{s.source === 'local' ? <Tag>本地收件</Tag> : null}</>} sub={`${fmtTime(s.at)} · ${s.text || '(没有文字内容)'}`}>
              {form.authorIds.includes(s.author_id) ? <Tag color="success">已信任</Tag> : <Button size="small" onClick={() => setForm(addAuthor(form, s.author_id))}>信任</Button>}
            </GroupRow>
          ))}
        </Group>
      ) : (
        <EmptyState compact>{status.link.state === 'ready' || inbox.watching ? '还没有收到新消息' : '连上 Discord(或打开本地收件)之后,这里会列出频道里的新消息'}</EmptyState>
      )}
      {strangers.length && !form.authorIds.length ? <p className="hint">点某一条右边的「信任」,就把它的发送者加进名单;保存之后才生效。</p> : null}

      <SectionTitle>3 · 发到哪、最多亏多少</SectionTitle>
      <Group hint="这三个上限是跟单多加的一道;「设置」里的限额、保护规则、熔断照常生效,取更严的那个。">
        <GroupRow stacked label="发到这些账户" sub="一个都不勾 = 默认账户。勾两个就每单各发一份,上限各算各的;实盘账户还要「允许实盘账户下单」开着。">
          <Checkbox.Group
            value={form.accounts}
            onChange={(v) => patch({ accounts: v.map(String) })}
            options={accounts.map((a) => ({ value: a.alias, label: `${a.alias}(${a.is_paper ? '纸面' : '实盘'}${a.default ? ',默认' : ''})` }))}
          />
        </GroupRow>
        <NumberRow icon="sf-dollar" tint="red" label="每单最坏亏损上限" sub="USD = 张数 × 100 × 权利金上限;没写权利金的按翼宽算" min={1} step={50} value={form.maxRisk} onChange={(v) => patch({ maxRisk: v })} />
        <NumberRow icon="sf-layers" tint="purple" label="每天最多跟几单" sub={`美东一天;今天已跟 ${status.today.sent} 单`} min={1} max={100} step={1} value={form.perDay} onChange={(v) => patch({ perDay: v })} />
        <NumberRow icon="sf-clock" tint="gray" label="消息多旧就不跟" sub="秒。断线之后补到的旧消息不追" min={1} max={600} step={5} value={form.maxAge} onChange={(v) => patch({ maxAge: v })} />
      </Group>

      <SectionTitle>4 · 开关</SectionTitle>
      <Group>
        <SwitchRow icon="sf-bolt" tint="orange" label="自动跟单" sub="关着 = 只观察。关是当场生效的,开要点保存并在确认框里确认" checked={form.enabled} onChange={(v) => void setEnabled(v)} />
      </Group>
      {form.enabled && appStatus && !appStatus.auto_execute ? <Notice tone="warn">「设置 → 允许自动执行」现在关着:打开跟单之后信号仍然发不出去,会记成「闸门关着」。</Notice> : null}
      {checked && problems.length ? (
        <Notice tone="warn" title="还不能保存">
          <ul className="hint-list">{problems.map((text) => <li key={text}>{text}</li>)}</ul>
        </Notice>
      ) : null}
      <div className="row tight">
        <Button type="primary" disabled={!dirty} loading={busy === 'save'} onClick={() => void save()}>保存</Button>
        {dirty ? <span className="muted">有未保存的修改</span> : null}
      </div>

      <SectionTitle count={status.recent.length}>最近的信号</SectionTitle>
      {status.recent.length ? (
        <Group>
          {status.recent.map((e) => (
            <GroupRow key={e.message_id} label={<>{e.summary || e.text}</>} sub={`${fmtTime(e.at)} · ${e.author_name || e.author_id} ·「${e.text}」${e.detail ? ` · ${e.detail}` : ''}`}>
              <Tag color={outcomeTone(e.outcome)}>{OUTCOME_LABEL[e.outcome]}</Tag>
            </GroupRow>
          ))}
        </Group>
      ) : (
        <EmptyState compact>信任的发送者发来像蝴蝶单的消息之后,每一条跟了没有、为什么,都记在这里</EmptyState>
      )}
    </section>
  );
}
