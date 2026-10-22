// 「交易记录」一页的接线(pages/Records.tsx + lib/RecordDetail.tsx):
//   · 进页即读、停在这一页时 15 秒一轮(读的是和订单看板共用的那份 RecordsStore);
//   · 筛选、关键词、表头排序是这一页自己的;疏密记在本机(React 版 localStorage 的 dafri-record-density,这里是 Settings 的 records/density);
//   · 点一行打开它的单据:records.get { id },回来之前换了一行的那份作废;原始记录照引擎回包的键序写;Esc / 「收起」关掉;
//   · 「导出」:系统的保存对话框选路径(界面递不进路径),再 data.export;导出的账号没打码,横幅当场说一声。
// 模型在 shell/records_rules。
#pragma once

#include <QCollator>
#include <QJsonObject>
#include <QObject>
#include <QTimeZone>
#include <QTimer>

#include <functional>

namespace ibkr::shell {

class Bridge;
class KeyedListModel;
class RecordsStore;
class StatusStore;

class RecordsController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject page READ page NOTIFY pageChanged)
    /// 表的每一行(按 id 原地更新:15 秒一轮刷新时打开着的那一行、悬停着的提示不重建)
    Q_PROPERTY(QObject* rows READ rows CONSTANT)
    Q_PROPERTY(QJsonObject detail READ detail NOTIFY detailChanged)
    Q_PROPERTY(QString openId READ openId NOTIFY detailChanged)

public:
    static constexpr int kRefreshMs = 15'000;

    /// settingsPath:疏密记在哪个 ini(壳给用户数据目录里的 qt-settings.ini,同交易指令页记勾选的那一份;测试给临时目录)
    RecordsController(Bridge* bridge, RecordsStore* records, StatusStore* status, QString settingsPath, QObject* parent = nullptr);

    QJsonObject page() const { return page_; }
    QObject* rows() const;
    QJsonObject detail() const { return detail_; }
    QString openId() const { return openId_; }

    Q_INVOKABLE void setVisible(bool on);
    Q_INVOKABLE void setFilter(const QString& key);
    Q_INVOKABLE void setKeyword(const QString& text);
    Q_INVOKABLE void setCompact(bool on);
    /// 点表头:升 → 降 → 不排
    Q_INVOKABLE void sortBy(const QString& key);
    Q_INVOKABLE void open(const QString& id);
    Q_INVOKABLE void close();
    Q_INVOKABLE void exportAll();
    /// 蝴蝶单的「分析这笔交易」:壳去交易分析页
    Q_INVOKABLE void review(const QString& id) { emit reviewRequested(id); }
    /// 点代码徽章:壳打开那只标的的档案
    Q_INVOKABLE void dossier(const QString& symbol) { emit dossierRequested(symbol); }

    std::function<double()> now;
    QTimeZone zone = QTimeZone::systemTimeZone();
    int refreshMs = kRefreshMs;
    /// 保存对话框:(标题, 默认路径, 过滤) → 选的路径,取消是空。壳给(QFileDialog);测试换成假的
    std::function<QString(const QString&, const QString&, const QString&)> pickSavePath;
    /// 默认存到哪(下载目录);测试换成临时目录
    QString downloadsDir;

signals:
    void pageChanged();
    void detailChanged();
    void reviewRequested(const QString& id);
    void dossierRequested(const QString& symbol);

private:
    void rebuild();
    void rebuildDetail();

    Bridge* bridge_;
    RecordsStore* records_;
    StatusStore* status_;
    KeyedListModel* rows_;
    QCollator collator_;
    QTimer timer_;
    QString filter_ = QStringLiteral("all");
    QString keyword_;
    bool compact_ = false;
    QString sortKey_ = QStringLiteral("created_at");
    QString sortOrder_ = QStringLiteral("descend");
    QString openId_;
    int detailSeq_ = 0;
    QString detailState_ = QStringLiteral("loading");
    QString detailError_;
    QByteArray detailRaw_;
    QJsonObject page_;
    QJsonObject detail_;
    QString settingsPath_;
};

}  // namespace ibkr::shell
