// stdin 一行一行读进事件循环、stdout 一行一行写出去。
//
// 读 stdin 用一条单独的线程:Windows 上管道不能挂 QSocketNotifier,阻塞读又不能放在事件循环里(盯盘会停)。
// 那条线程只读字节、不碰引擎的任何状态,读到一行就投递回主线程;引擎自己的事全在主线程。
// 写只在主线程:一行写完立刻冲掉,界面那头按行读。
#pragma once

#include <QByteArray>
#include <QObject>

namespace ibkr::rpc {

class StdinLines : public QObject {
    Q_OBJECT
public:
    using QObject::QObject;
    /// 起读线程。读到的每一行在主线程里发 line;读到 EOF 发 eof
    void start();

signals:
    void line(const QByteArray& bytes);
    void eof();
};

/// 写一行到 stdout(补 \n、立刻冲掉)。Windows 上 stdout 先切成二进制,不让 CRT 把 \n 换成 \r\n
void writeStdoutLine(const QByteArray& line);
void prepareStdout();

}  // namespace ibkr::rpc
