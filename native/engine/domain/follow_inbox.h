// 跟单的本地收件(engine-ts/src/followInbox.ts 逐句搬):本机脚本把 Discord 窗口里的新消息一行一个 JSON 追加进
// `<交易库目录>/follow-inbox.jsonl`,这里只管读文件——从此刻的末尾读起、文件变短就从头读、最后半行留到下一次、
// 认不出的行报一句人话就跳过。判定、信任、发单在 orchestrate 层的跟单服务里,和 bot 读来的消息走同一条路。
// 消息是 JS 对象(DiscordMessage:{id, channel_id, author_id, author_name, content, sentAtMs})。
#pragma once

#include "util/ordered_json.h"

#include <QObject>
#include <QPointer>
#include <QString>
#include <QTimer>

#include <functional>
#include <optional>

namespace ibkr::domain {

inline const QString kInboxFile = QStringLiteral("follow-inbox.jsonl");
inline const QString kLocalChannel = QStringLiteral("local");
inline constexpr int kLocalNameMax = 80;

QString inboxPath(const QString& dbPath);
/// 显示名 → 信任名单里的那一项:换行压成空格、掐头去尾、截到 80 字
QString localAuthorId(const QString& name);

struct ParsedInboxLine {
    bool ok = false;
    util::OJson message;  // ok 时
    QString error;        // 不 ok 时
};
ParsedInboxLine parseInboxLine(const QString& line);

class FollowInbox : public QObject {
public:
    struct Hooks {
        std::function<void(const util::OJson&)> onMessage;
        std::function<void(const QString&)> onError;
    };
    FollowInbox(QString path, Hooks hooks, int intervalMs = 1000, QObject* parent = nullptr);

    const QString& path() const { return path_; }
    const std::optional<QString>& error() const { return lastError_; }
    bool watching() const { return timer_.isActive(); }
    double received = 0;
    std::optional<QString> lastAt;

    /// 从文件此刻的末尾读起,之后每隔一会儿读一次新追加的内容
    void start();
    void stop();
    /// 读一次新内容(测试与「重新读一遍」直接调)
    void poll();

private:
    void fail(const QString& error);
    QString path_;
    Hooks hooks_;
    int intervalMs_;
    qint64 offset_ = 0;
    QString partial_;
    QTimer timer_;
    std::optional<QString> lastError_;
};

}  // namespace ibkr::domain
