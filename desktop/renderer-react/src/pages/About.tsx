import { useEffect, useState } from 'react';
import { Button, Descriptions } from 'antd';
import { dafri, errorMessage, type AppInfo, type Selftest } from '../bridge';
import { useEngineLog } from '../store/engineLog';
import { refreshStatus } from '../store/status';
import { isMac } from '../theme/appearance';
import { EmptyState, LoadingBlock, PageHead, SectionTitle } from '../ui/kit';

// 注册在案的快捷键。别在这里编不存在的——列表本身就是承诺。
const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ['mod', 'Enter'], what: '解析当前指令(不发送)' },
  { keys: ['mod', 'Shift', 'Enter'], what: '解析并发送(有确认框)' },
  { keys: ['mod', 'Shift', 'H'], what: '暂停全部自动执行(熔断)' },
  { keys: ['mod', 'R'], what: '刷新状态' },
  { keys: ['Esc'], what: '收起打开的记录详情' },
  { keys: ['↑', '↓'], what: '侧栏导航移动(焦点在侧栏时)' },
  { keys: ['mod', '1 ~ 9'], what: '按侧栏顺序切换页面' },
];

export function AboutPage() {
  const [info, setInfo] = useState<{ app: AppInfo; self: Selftest } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const log = useEngineLog();

  async function load() {
    try {
      const [app, self] = await Promise.all([dafri.appInfo(), dafri.selftest()]);
      setInfo({ app, self });
      setError(null);
    } catch (err) {
      setError(`读取失败:${errorMessage(err)}`);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function restart() {
    await dafri.restartEngine();
    setTimeout(() => {
      void refreshStatus();
      void load();
    }, 1200);
  }

  const mod = isMac ? '⌘' : 'Ctrl';
  const accounts = info?.self.accounts.map((a) => `${a.alias}(${a.account_masked}${a.is_paper ? ' 纸面' : ' 实盘'})`).join('、');

  return (
    <section className="tab-panel active" id="page-about">
      <PageHead title="关于" />
      <div className="about">
        {error ? (
          <EmptyState>{error}</EmptyState>
        ) : !info ? (
          <LoadingBlock rows={5} />
        ) : (
          <Descriptions
            column={1}
            size="small"
            colon={false}
            labelStyle={{ width: 96 }}
            items={[
              { key: 'v', label: '应用版本', children: info.app.version },
              { key: 'e', label: 'Electron', children: info.app.electron },
              { key: 'c', label: 'Chromium', children: info.app.chrome },
              { key: 'n', label: 'Node', children: info.app.node },
              { key: 'p', label: '配置文件', children: info.app.configPath },
              ...(info.app.logPath ? [{ key: 'lg', label: '日志文件', children: String(info.app.logPath) }] : []),
              { key: 'pv', label: '提示词', children: `${info.self.prompt_version} · ${info.self.prompt_fingerprint}` },
              { key: 'sp', label: '系统提示词', children: `${info.self.system_prompt_chars} 字 / ${info.self.fewshot_pairs} 组少样本` },
              { key: 'a', label: '账户', children: accounts || '—' },
              {
                // lightweight-charts 是 Apache-2.0 + NOTICE:署名与指向 tradingview.com 的链接要放在用户看得到的地方。
                // 图上的 TradingView 角标关掉了(每张图左下角一个外链),署名集中放在这里
                key: 'lwc',
                label: '图表',
                children: (
                  <>
                    TradingView Lightweight Charts™ · Copyright (c) 2025 TradingView, Inc. ·{' '}
                    <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
                      https://www.tradingview.com/
                    </a>
                  </>
                ),
              },
            ]}
          />
        )}
      </div>
      <SectionTitle>键盘快捷键</SectionTitle>
      <Descriptions
        className="keys"
        column={1}
        size="small"
        colon={false}
        labelStyle={{ width: 150 }}
        items={SHORTCUTS.map((item) => ({
          key: item.what,
          label: (
            <span className="keycaps">
              {item.keys.map((k, i) => (
                <kbd key={i}>{k === 'mod' ? mod : k}</kbd>
              ))}
            </span>
          ),
          children: item.what,
        }))}
      />
      <SectionTitle>引擎日志</SectionTitle>
      <pre className="log">{log}</pre>
      <Button size="small" onClick={() => void restart()}>
        重启交易引擎
      </Button>
    </section>
  );
}
