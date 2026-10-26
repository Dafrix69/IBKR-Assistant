#include "shell/entry_market.h"
#include <QDateTime>
#include <QTimeZone>
#include <QMap>
#include <QSet>
#include <cmath>
using namespace Qt::StringLiterals;
namespace ibkr::shell::fly {
namespace {
double n(QJsonValue v) { bool ok=false; double x=v.isDouble()?v.toDouble():v.toString().toDouble(&ok); return (v.isDouble()||ok)&&std::isfinite(x)?x:NAN; }
bool fresh(double at,double now,double ttl=60000) { return std::isfinite(at)&&at>0&&at<=now&&now-at<=ttl; }
struct Bars { QList<QJsonObject> rows; QString error; };
Bars closed(const QJsonObject& source,double now) {
    Bars out;
    if (!source["error"].toString().isEmpty()) { out.error=source["error"].toString(); return out; }
    if(source["feed"]!="live" || source["proxy"].toBool() || !fresh(n(source["asked_at"]),now,90000)) {
        out.error=u"缺少新鲜的实时原标的分钟线；延迟、代理、未知来源或过期数据不通过"_s; return out;
    }
    const QTimeZone zone("America/New_York");
    const auto today=QDateTime::fromMSecsSinceEpoch(qint64(now),zone).date();
    QMap<qint64,QJsonObject> sorted;
    for(const auto& v:source["bars"].toArray()) {
        auto b=v.toObject(); const auto local=QDateTime::fromString(b["time"].toString(),u"yyyy-MM-dd HH:mm"_s);
        const QDateTime dt(local.date(),local.time(),zone); const qint64 at=dt.toMSecsSinceEpoch();
        if(!dt.isValid() || dt.date()!=today || dt.time()<QTime(9,30) || dt.time()>=QTime(16,0) || at+60000>now) continue;
        if(!std::isfinite(n(b["open"]))||!std::isfinite(n(b["close"]))||!std::isfinite(n(b["high"]))||!std::isfinite(n(b["low"]))||n(b["low"])<=0||n(b["high"])<n(b["low"])) continue;
        b["at"]=double(at); sorted[at]=b;
    }
    if(sorted.isEmpty() || now-sorted.lastKey()-60000>90000) { out.error=u"当日已收盘分钟线缺失或滞后"_s; return out; }
    for(auto it=sorted.begin();it!=sorted.end();++it)out.rows<<it.value();
    return out;
}
}
QJsonArray entryMarketChecks(const QJsonObject& plan,const QJsonObject& e,double now) {
    QJsonArray out;
    auto add=[&](QString title,QString state,QString detail){out.append(QJsonObject{{"title",title},{"state",state},{"detail",detail}});};
    auto r=plan["result"].toObject(); const auto quotes=r["entry_quotes"].toArray();
    bool live=quotes.size()==3, timely=live, sizes=live, iv=live;
    const double qty=n(r["quantity"]);
    QSet<double> strikes;
    QStringList quoteDetails;
    for(const auto& v:quotes) {
        const auto q=v.toObject(); const double strike=n(q["strike"]); strikes.insert(strike);
        const bool middle=strike==n(r["center"]);
        live &= n(q["market_data_type"])==1 && q["error"].toString().isEmpty();
        auto age=[&](const char* key){const double at=n(q[key]);return std::isfinite(at)&&at<=now?QString::number((now-at)/1000,'f',1)+u"s"_s:u"missing"_s;};
        quoteDetails << QString("%1: type=%2, bid/ask age=%3/%4, size=%5/%6%7")
            .arg(strike).arg(std::isfinite(n(q["market_data_type"]))?QString::number(n(q["market_data_type"])):u"missing"_s)
            .arg(age("bid_at"),age("ask_at"),std::isfinite(n(q["bid_size"]))?QString::number(n(q["bid_size"])):u"missing"_s,
                 std::isfinite(n(q["ask_size"]))?QString::number(n(q["ask_size"])):u"missing"_s,q["error"].toString().isEmpty()?QString():u"; "+q["error"].toString());
        timely &= fresh(n(q["bid_at"]),now)&&fresh(n(q["ask_at"]),now);
        sizes &= fresh(n(q[middle?"bid_size_at":"ask_size_at"]),now) && n(q[middle?"bid_size":"ask_size"]) >= qty*(middle?2:1);
        iv &= fresh(n(q["iv_at"]),now) && n(q["iv_value"])>0;
    }
    const bool match=strikes.size()==3&&strikes.contains(n(r["lower"]))&&strikes.contains(n(r["center"]))&&strikes.contains(n(r["upper"]));
    add(u"逐腿实时类型"_s,live&&match?u"pass"_s:u"wait"_s,u"三腿必须由 IBKR marketDataType=1 确认；2冻结、3延迟、4延迟冻结。missing=缺失。"_s+quoteDetails.join(u"；"_s));
    add(u"逐腿报价年龄"_s,timely&&live&&match?u"pass"_s:u"wait"_s,u"分别核对 bid/ask 本机接收时间，均须在 60 秒内；不是交易所时间，重复推送不等于发生新成交"_s);
    add(u"可见一档数量"_s,sizes&&live&&timely&&match?u"pass"_s:u"wait"_s,u"买两翼用 ask size，卖中心用 bid size×2 比例；按计划组数核对。缺数量/过期明确待核实；不保证组合成交"_s);
    add(u"逐腿 IV 时效"_s,iv&&live&&match?u"pass"_s:u"wait"_s,u"IBKR 模型 IV 收到时间须在 60 秒内；手填 IV 不作为实时报价证据"_s);
    const auto ctx=plan["entry_context"].toObject();
    const auto spx=closed(ctx["SPX"].toObject(),now),spy=closed(ctx["SPY"].toObject(),now);
    const QString mode=e["mode"].toString(); const bool directional=mode=="up"||mode=="down"; const double sign=mode=="up"?1:-1, gate=n(e["trigger"]);
    if(directional) {
        int cross=-1; bool hold=false,retest=false;
        if(spx.error.isEmpty()&&std::isfinite(gate)) {
            for(int i=1;i<spx.rows.size();++i) {
                const auto& b=spx.rows[i]; const auto& prev=spx.rows[i-1];
                if(n(b["at"])-n(prev["at"])!=60000) {cross=-1; continue;}
                if((n(b["close"])-gate)*sign<=0) {cross=-1; continue;}
                if((n(prev["close"])-gate)*sign<=0 && (n(b["close"])-n(b["open"]))*sign>0)cross=i;
            }
            if(cross>=0) {
                hold=spx.rows.size()-cross>=5;
                for(int i=cross+1;i<spx.rows.size();++i) {
                    const auto& b=spx.rows[i];
                    if((n(b[sign>0?"low":"high"])-gate)*sign<=0 && (n(b["close"])-gate)*sign>0)retest=true;
                }
            }
        }
        const QString reason=spx.error.isEmpty()?u"SPX 当日已收盘 1 分钟线；仅价格证据，不代表主动买卖"_s:spx.error;
        add(u"门位突破（自动）"_s,cross>=0?u"pass"_s:u"wait"_s,reason+u"。须从位内收至位外且实体方向一致；未观察到完整突破过程则等待"_s);
        add(u"位外站稳五分钟（自动）"_s,hold?u"pass"_s:u"wait"_s,reason+u"。突破开始连续五根收盘在位外，缺分钟或收回则重置"_s);
        add(u"回踩收回位外（自动）"_s,retest?u"pass"_s:u"wait"_s,reason+u"。突破后的分钟高低触及门位且收盘在位外；不能确认主动成交持续"_s);
    }
    if(spy.error.isEmpty()&&spy.rows.size()>=21) {
        const auto& last=spy.rows.last(); double avg=0;bool valid=true;
        for(int i=spy.rows.size()-21;i<spy.rows.size()-1;++i) {
            avg+=n(spy.rows[i]["volume"]); valid &= n(spy.rows[i+1]["at"])-n(spy.rows[i]["at"])==60000 && n(spy.rows[i]["volume"])>=0;
        }
        avg/=20; const double ratio=n(last["volume"])/avg;
        add(u"SPY 最近分钟量比（代理）"_s,u"note"_s,valid&&std::isfinite(ratio)&&avg>0?u"最近完整分钟 / 前20分钟均量 = %1×；只是代理量能描述，不能当作 SPX 成交量或广度"_s.arg(ratio,0,'f',2):u"连续分钟成交量缺失，无法计算"_s);
    } else add(u"SPY 分钟量能（代理）"_s,u"note"_s,spy.error.isEmpty()?u"不足21根完整分钟线"_s:spy.error);
    double volume=0,weighted=0;bool full=spy.error.isEmpty()&&!spy.rows.isEmpty()&&spy.rows.first()["time"].toString().endsWith("09:30");
    for(int i=0;i<spy.rows.size();++i){const auto& b=spy.rows[i]; const double v=n(b["volume"]);full &= std::isfinite(v)&&v>=0&&(i==0||n(b["at"])-n(spy.rows[i-1]["at"])==60000);volume+=v;weighted+=(n(b["high"])+n(b["low"])+n(b["close"]))/3*v;}
    add(u"SPY 日内 VWAP（代理估算）"_s,u"note"_s,full&&volume>0?u"典型价×分钟量估算 VWAP %1；最近收盘 %2。不是 SPX VWAP，也不是全市场广度"_s.arg(weighted/volume,0,'f',2).arg(n(spy.rows.last()["close"]),0,'f',2):u"缺少从09:30开始的连续实时分钟量价，无法计算"_s);
    if(directional) add(u"市场广度 / 主动成交"_s,u"wait"_s,u"当前缺少全成分股广度及可信主动成交分类；SPY 的价格与量能不能代替，不要求手动勾选为已获取"_s);
    const auto calendar=plan["event_context"].toObject();
    const auto stop=QTime::fromString(e["exitTime"].toString(),"HH:mm");
    const QTimeZone zone("America/New_York");
    const auto date=QDateTime::fromMSecsSinceEpoch(qint64(now),zone).date();
    const double until=QDateTime(date,stop,zone).toMSecsSinceEpoch();
    QStringList nearby;
    for(const auto& value:calendar["events"].toArray()) {
        const auto event=value.toObject(); const double at=n(event["at"]);
        if(std::isfinite(at)&&at>=now&&at<=until) nearby<<event["title"].toString();
    }
    add(u"计划持有期内已知事件"_s,!nearby.isEmpty()?u"block"_s:u"note"_s,
        !nearby.isEmpty()?u"已登记日历与持有期重叠："_s+nearby.join(u"、"_s):
        calendar.isEmpty()?u"事件日历缺失，无法自动排除事件风险"_s:
        u"已登记日历未发现重叠；仅覆盖内置/已接入来源，不能排除突发事件或成分股财报。请核对退出计划"_s);
    return out;
}
}
