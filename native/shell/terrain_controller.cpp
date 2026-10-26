#include "shell/terrain_controller.h"
#include <QDateTime>
#include <QTimeZone>
#include <QPointer>
#include <algorithm>
#include <cmath>
#include <limits>
namespace ibkr::shell {
using namespace Qt::StringLiterals;
namespace {
QString timeText(double t) { return QDateTime::fromMSecsSinceEpoch(qint64(t),QTimeZone("America/New_York")).toString(u"HH:mm:ss"_s); }
bool finite(const QJsonValue& v) { return v.isDouble() && std::isfinite(v.toDouble()); }
}
TerrainController::TerrainController(Bridge* bridge,QObject* parent):QObject(parent) {
    request = [this,bridge](const QJsonObject& p,Bridge::RpcDone done) {
        if (bridge) bridge->rpc(this,u"options.terrain"_s,p,std::move(done));
        else { EngineReply r; r.error=u"引擎未连接"_s; done(r); }
    };
    rebuild();
}
void TerrainController::refresh() { fetch(date_); }
void TerrainController::selectDate(const QString& date) { fetch(date); }
void TerrainController::fetch(const QString& date) {
    const int gen=++generation_;
    const bool preserve=date==date_;
    const double oldCursor=cursor_;
    date_=date; busy_=true; error_.clear(); records_={}; rejected_=0; begin_=end_=cursor_=0; rebuild();
    QPointer<TerrainController> self(this);
    request(date.isEmpty()?QJsonObject{}:QJsonObject{{u"date"_s,date}},[self,gen,preserve,oldCursor](const EngineReply& r) {
        if (!self || gen!=self->generation_) return;
        self->busy_=false;
        if (!r.ok) { self->error_=r.error; self->rebuild(); return; }
        const auto result=r.result.toObject(); self->demo_=result[u"demo"].toBool(); self->dates_=result[u"dates"].toArray();
        if (self->date_.isEmpty() && !self->dates_.isEmpty()) { self->fetch(self->dates_.last().toString()); return; }
        self->records_=result[u"records"].toArray(); self->rejected_=result[u"rejected_records"].toInt();
        if (!self->records_.isEmpty()) {
            self->begin_=self->records_.first()[u"received_at"].toDouble();
            self->end_=self->records_.last()[u"received_at"].toDouble();
            self->cursor_=preserve && oldCursor>=self->begin_ ? std::clamp(oldCursor,self->begin_,self->end_) : self->begin_;
        }
        self->low_=std::numeric_limits<double>::infinity(); self->high_=-self->low_; self->scale_=1;
        for (const auto& record:self->records_) for (const auto& cell:record[u"wall"][u"strikes"].toArray()) {
            if (finite(cell[u"strike"])) { self->low_=std::min(self->low_,cell[u"strike"].toDouble()); self->high_=std::max(self->high_,cell[u"strike"].toDouble()); }
            if (finite(cell[u"net_gex"])) self->scale_=std::max(self->scale_,std::abs(cell[u"net_gex"].toDouble()));
        }
        if (!std::isfinite(self->low_)) { self->low_=0; self->high_=1; }
        if (self->high_<=self->low_) { self->low_-=5; self->high_+=5; }
        self->rebuild();
    });
}
void TerrainController::seek(double time) { if (busy_ || records_.isEmpty() || !std::isfinite(time)) return; cursor_=std::clamp(time,begin_,end_); rebuild(); }
void TerrainController::step(int direction) {
    if (records_.isEmpty() || busy_) return;
    double target=direction>0?end_:begin_;
    if (direction>0) { for (const auto& r:records_) if (r[u"received_at"].toDouble()>cursor_) {target=r[u"received_at"].toDouble();break;} }
    else { for (const auto& r:records_) if (r[u"received_at"].toDouble()<cursor_) target=r[u"received_at"].toDouble(); }
    seek(target);
}
void TerrainController::rebuild() {
    QJsonObject record; int index=-1;
    for (qsizetype i=0;i<records_.size();++i) { const auto r=records_[i].toObject(); if (r[u"received_at"].toDouble()<=cursor_) {record=r;index=int(i);} }
    QString status=busy_?u"正在读取…"_s:!error_.isEmpty()?error_:u"当天暂无地形记录。开启日内剧本后会按刷新流程自动采集。"_s;
    QJsonArray rows;
    const double age=record.isEmpty()?0:cursor_-record[u"received_at"].toDouble();
    if (!record.isEmpty()) {
        status=record[u"status"].toString()==u"refresh_failed"?u"这次刷新失败，未沿用旧地形"_s:age>300000?u"观察帧已超过五分钟"_s:u"地形观察 · 行情真实年龄未知"_s;
        if (record[u"status"].toString()==u"observed") rows=record[u"wall"][u"strikes"].toArray();
    }
    if (demo_) status=u"演示数据 · "_s+status;
    if (rejected_>0) status+=u" · 日志不完整：%1 条记录不可读"_s.arg(rejected_);
    QJsonArray options; for (const auto& d:dates_) options.append(QJsonObject{{u"label"_s,d},{u"value"_s,d}});
    const auto wall=record[u"wall"].toObject();
    model_={{u"dates"_s,options},{u"date"_s,date_},{u"busy"_s,busy_},{u"status"_s,status},{u"rows"_s,rows},
        {u"cursor"_s,cursor_},{u"begin"_s,begin_},{u"end"_s,end_},{u"time"_s,record.isEmpty()?QString():timeText(cursor_)},
        {u"startTime"_s,records_.isEmpty()?QString():timeText(begin_)},{u"endTime"_s,records_.isEmpty()?QString():timeText(end_)},
        {u"frameTime"_s,record.isEmpty()?QString():timeText(record[u"received_at"].toDouble())},
        {u"ageSeconds"_s,age/1000},{u"index"_s,index+1},{u"count"_s,records_.size()},
        {u"low"_s,low_},{u"high"_s,high_},{u"scale"_s,scale_},{u"spot"_s,wall[u"spot"]},{u"coverage"_s,wall[u"coverage"]},
        {u"netGex"_s,wall[u"net_gex"]}};
    emit changed();
}
}
