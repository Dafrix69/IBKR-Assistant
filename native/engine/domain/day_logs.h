// 交易库旁边两份"一天一个文件、一行一条 JSON"的底账(engine-ts 的 ivSamples.ts、playbookLog.ts 逐句搬):
//   IvSampleStore ← ivSamples.ts:当日到期期权的 IV 样本(fly-iv/),只有行情
//   PlaybookLog   ← playbookLog.ts:日内剧本的底账(playbook/):区间、事件、锚、状态机
// 两份同一条规矩:只追加(新建的文件 0600),坏的行(断电时写了半行、形状不对)读的时候跳过,别的照用;留最近 400 个文件。
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QString>
#include <QStringList>

#include <functional>

namespace ibkr::domain {

/// 共用的那一半:文件名 YYYY-MM-DD.jsonl
class JsonlDayFiles {
public:
    explicit JsonlDayFiles(QString dir) : dir_(std::move(dir)) {}
    const QString& dir() const { return dir_; }
    void append(const QString& date, const util::OJson& record) const;
    /// 一次打开写好几行(记盘那一路一秒刷一次,不为每一行开一次文件)
    void appendAll(const QString& date, const QList<util::OJson>& records) const;
    /// 读出来、形状对的那几行(原样的 JS 对象)
    QList<util::OJson> readValid(const QString& date, const std::function<bool(const util::OJson&)>& valid) const;
    /// 有文件的日子,从早到晚
    QStringList dates() const;
    /// 只留最近 keep 个文件;返回删了几个
    double prune(double keep) const;
    QString fileOf(const QString& date) const { return dir_ + u'/' + date + u".jsonl"; }

private:
    QString dir_;
};

class IvSampleStore : public JsonlDayFiles {
public:
    static constexpr double kKeepDays = 400;
    using JsonlDayFiles::JsonlDayFiles;
    /// 落在样本时刻的美东日期的文件里
    void append(const util::OJson& sample) const;
    /// 这一天的样本,按时刻排好;坏的行跳过
    QList<util::OJson> read(const QString& date) const;
    /// [{date, samples, bytes}]
    QList<util::OJson> days() const;
    double prune(double keep = kKeepDays) const { return JsonlDayFiles::prune(keep); }
};

class PlaybookLog : public JsonlDayFiles {
public:
    static constexpr double kKeepDays = 400;
    using JsonlDayFiles::JsonlDayFiles;
    void append(const QString& date, const util::OJson& record) const { JsonlDayFiles::append(date, record); }
    QList<util::OJson> read(const QString& date) const;
    double prune(double keep = kKeepDays) const { return JsonlDayFiles::prune(keep); }
};

}  // namespace ibkr::domain
