/**
 * 页面级的错误边界。某一页渲染时抛了异常,以前的结局是整棵 React 树被卸掉:窗口一片空白,
 * 顶栏的「暂停自动执行」也跟着没了——而渲染进程并没有崩,主进程那条"崩了就重载"的路不会走到。
 *
 * 现在只有出事的那一页换成一张说明卡,壳(顶栏、侧栏、熔断按钮)照常可用;切到别的页再切回来会重试。
 * 视觉层的组件,不认识业务:出了错之后能做的事(重新载入、导出诊断信息)由壳从 actions 递进来。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Result, Space } from 'antd';

interface Props {
  /** 换了它就重试(壳传当前页的 key) */
  resetKey: string;
  /** 说明卡下面的按钮 */
  actions?: { label: string; onClick: () => void; primary?: boolean }[];
  children: ReactNode;
}

interface State {
  error: Error | null;
  resetKey: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // console.error 会被主进程收进日志(main.js 的 console-message),诊断信息里看得到
    console.error(`[页面出错] ${this.props.resetKey}: ${error.stack || error.message}\n${info.componentStack ?? ''}`);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Result
        className="page-crash"
        status="warning"
        title="这一页出错了"
        subTitle="其它页面与顶栏的「暂停自动执行」不受影响;持仓追踪在交易引擎里照常运行。"
        extra={
          <Space direction="vertical" size={12}>
            <code className="page-crash-detail selectable">{error.message || String(error)}</code>
            <Space size={8} wrap>
              <Button onClick={() => this.setState({ error: null })}>重试这一页</Button>
              {(this.props.actions || []).map((a) => (
                <Button key={a.label} type={a.primary ? 'primary' : 'default'} onClick={a.onClick}>
                  {a.label}
                </Button>
              ))}
            </Space>
          </Space>
        }
      />
    );
  }
}
