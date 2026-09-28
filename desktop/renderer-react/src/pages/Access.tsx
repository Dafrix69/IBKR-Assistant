import { Segmented } from 'antd';
import { AccountsPanel } from '../lib/AccountsPanel';
import { FutuPanel } from '../lib/FutuPanel';
import { LlmPanel } from '../lib/LlmPanel';
import { TwsPanel } from '../lib/TwsPanel';
import { setSubtab, useSubtab } from '../store/nav';
import { PageHead } from '../ui/kit';

// 接入:TWS、富途 OpenD、账户、大模型。各自一个文件(lib/TwsPanel、lib/FutuPanel、lib/AccountsPanel、lib/LlmPanel),
// 共用的展示构件在 lib/connectBits。这一页自己只剩「在几个子页签之间切」这一件事。
// 整条路都不接触任何券商的登录密码——登录在券商程序自己的窗口完成。

const SUBTABS = [
  { value: 'tws', label: 'TWS' },
  { value: 'futu', label: '富途 OpenD' },
  { value: 'accounts', label: '账户' },
  { value: 'llm', label: '大模型' },
];


export function AccessPage() {
  const sub = useSubtab('access', 'tws');
  return (
    <section className="tab-panel active" id="page-access">
      <PageHead title="接入" extra={<Segmented options={SUBTABS} value={sub} onChange={(v) => setSubtab('access', String(v))} />} />
      {sub === 'tws' ? <TwsPanel /> : null}
      {sub === 'futu' ? <FutuPanel /> : null}
      {sub === 'accounts' ? <AccountsPanel /> : null}
      {sub === 'llm' ? <LlmPanel /> : null}
    </section>
  );
}



