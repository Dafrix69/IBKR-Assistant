#include "shell/records_controller.h"

#include "shell/bridge.h"
#include "shell/jsvalue.h"
#include "shell/keyed_list_model.h"
#include "shell/order_stores.h"
#include "shell/ordered_json.h"
#include "shell/records_rules.h"
#include "shell/status_store.h"

#include <QDateTime>
#include <QDir>
#include <QPointer>
#include <QSettings>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

RecordsController::RecordsController(Bridge* bridge, RecordsStore* records, StatusStore* status, QString settingsPath, QObject* parent)
    : QObject(parent), bridge_(bridge), records_(records), status_(status), rows_(new KeyedListModel(u"id"_s, this)), collator_(QLocale::system()),
      settingsPath_(std::move(settingsPath)) {
    now = [] { return double(QDateTime::currentMSecsSinceEpoch()); };
    compact_ = QSettings(settingsPath_, QSettings::IniFormat).value(u"records/density"_s).toString() == u"compact";
    connect(records_, &ListStore::changed, this, &RecordsController::rebuild);
    connect(&timer_, &QTimer::timeout, this, [this] { records_->load(); });
    rebuild();
}

QObject* RecordsController::rows() const { return rows_; }

void RecordsController::setVisible(bool on) {
    // 进页即刷,停留期间 15 秒一轮
    if (on) {
        records_->load();
        timer_.start(refreshMs);
    } else {
        timer_.stop();
        // 详情开着的是页面自己的状态(原版的 useState):离开这一页就收起,回来是收起的
        close();
    }
}

void RecordsController::setFilter(const QString& key) {
    if (!records::filterKeys().contains(key) || key == filter_) return;
    filter_ = key;
    rebuild();
}

void RecordsController::setKeyword(const QString& text) {
    if (text == keyword_) return;
    keyword_ = text;
    rebuild();
}

void RecordsController::setCompact(bool on) {
    if (on == compact_) return;
    compact_ = on;
    QSettings(settingsPath_, QSettings::IniFormat).setValue(u"records/density"_s, on ? u"compact"_s : u"cozy"_s);
    rebuild();
}

void RecordsController::sortBy(const QString& key) {
    const records::Sort next = records::nextSort({sortKey_, sortOrder_}, key);
    sortKey_ = next.key;
    sortOrder_ = next.order;
    rebuild();
}

void RecordsController::open(const QString& id) {
    if (id.isEmpty()) return;
    openId_ = id;
    detailState_ = u"loading"_s;
    detailError_.clear();
    detailRaw_.clear();
    const int seq = ++detailSeq_;
    rebuildDetail();
    rebuild();
    QPointer<RecordsController> self(this);
    bridge_->rpc(this, u"records.get"_s, QJsonObject{{u"id"_s, id}}, [self, seq](const EngineReply& r) {
        // 回来之前换了一行(或者收起了):这一份作废(同原版 effect 的 cancelled)
        if (!self || seq != self->detailSeq_) return;
        if (!r.ok) {
            self->detailState_ = u"error"_s;
            self->detailError_ = r.error;
        } else if (!jsTruthy(r.result.toObject().value("record"_L1))) {
            self->detailState_ = u"gone"_s;
        } else {
            self->detailState_ = u"ok"_s;
            self->detailRaw_ = r.raw;
        }
        self->rebuildDetail();
    });
}

void RecordsController::close() {
    if (openId_.isEmpty()) return;
    openId_.clear();
    ++detailSeq_;
    rebuildDetail();
    rebuild();
}

void RecordsController::exportAll() {
    const QString dir = downloadsDir.isEmpty() ? QDir::homePath() : downloadsDir;
    const QString target = pickSavePath ? pickSavePath(u"导出全部交易数据"_s, QDir(dir).filePath(u"dafri-trades.json"_s), u"JSON (*.json)"_s) : QString();
    if (target.isEmpty()) return;
    // 引擎写到哪由这一步定:桥只放行刚在对话框里选的这一个路径,用一次作废
    bridge_->setPickedExportPath(target);
    QPointer<RecordsController> self(this);
    bridge_->rpc(this, u"data.export"_s, QJsonObject{{u"path"_s, target}}, [self](const EngineReply& r) {
        if (!self || !self->status_) return;
        if (!r.ok) return self->status_->showError(u"导出失败:"_s + r.error);
        const QJsonObject res = r.result.toObject();
        // 导出的是库里的原样,账号没有打码(界面上的是打了码的)——当场说一声,免得被当成可以直接发给别人的东西
        self->status_->showInfo(u"已导出 %1 条记录到 %2。文件里的账号是完整的,请自己保管"_s.arg(res.value("records"_L1).toVariant().toString(),
                                                                                         res.value("path"_L1).toVariant().toString()));
    });
}

void RecordsController::rebuild() {
    records::PageInput in;
    in.records = records_->items();
    in.error = records_->error();
    in.filter = filter_;
    in.keyword = keyword_;
    in.compact = compact_;
    in.sort = {sortKey_, sortOrder_};
    in.openId = openId_;
    in.nowMs = now();
    in.zone = zone;
    in.collator = &collator_;
    page_ = records::pageModel(in);
    rows_->setItems(page_.value("rows"_L1).toArray());
    emit pageChanged();
}

void RecordsController::rebuildDetail() {
    if (openId_.isEmpty()) {
        detail_ = {};
        emit detailChanged();
        return;
    }
    records::DetailInput in;
    in.state = detailState_;
    in.error = detailError_;
    in.zone = zone;
    in.nowMs = now();
    if (detailState_ == u"ok") {
        // 保序读回包:原始记录照引擎的键序写(同 JSON.stringify(record, null, 2))
        const std::optional<OJson> reply = parseOJson(QString::fromUtf8(detailRaw_));
        const OJson* result = reply ? reply->get(u"result"_s) : nullptr;
        const OJson* record = result ? result->get(u"record"_s) : nullptr;
        if (record) in.record = *record;
    }
    detail_ = records::detailModel(in);
    emit detailChanged();
}

}  // namespace ibkr::shell
