#include "shell/fly_entry.h"
#include "shell/entry_market.h"
#include "shell/fly_rules.h"
#include <QDateTime>
#include <QJsonArray>
#include <QTimeZone>
#include <cmath>
#include <limits>
namespace ibkr::shell::fly {
using namespace Qt::StringLiterals;
namespace {
double number(const QJsonValue& v) {
    bool ok=false; const double n=v.isDouble()?v.toDouble():v.toString().toDouble(&ok);
    return (v.isDouble()||ok)&&std::isfinite(n)?n:std::numeric_limits<double>::quiet_NaN();
}
QString money(double n) { return std::isfinite(n)?u"$%1"_s.arg(n,0,'f',2):u"—"_s; }
QString text(double n) { return std::isfinite(n)?QString::number(n,'f',2):u"—"_s; }
}
QJsonObject entryReview(const QJsonObject& plan,const QJsonObject& e,double nowMs) {
    QJsonArray checks,manual,metrics; int blocked=0,pending=0;
    const auto add=[&](QString title,QString state,QString detail) {
        checks.append(QJsonObject{{u"title"_s,title},{u"state"_s,state},{u"detail"_s,detail}});
        if(state==u"block")++blocked; else if(state==u"wait")++pending;
    };
    const auto confirm=[&](QString key,QString title,QString source) {
        const double at=number(e.value(key+u"At"));
        // 五分钟仅为复核工作流的有效期,不是统计校准的入场阈值。每项独立计时。
        const bool checked=e.value(key).toBool()&&std::isfinite(at)&&nowMs>=at&&nowMs-at<=300000;
        manual.append(QJsonObject{{u"key"_s,key},{u"label"_s,title},{u"source"_s,source},{u"checked"_s,checked}});
        if(!checked)++pending;
    };
    const auto metric=[&](QString label,QString value){metrics.append(QJsonObject{{u"label"_s,label},{u"value"_s,value}});};
    const auto r=plan.value(u"result"_s).toObject(),form=plan.value(u"form"_s).toObject();
    const auto target=r.value(u"target"_s).toObject();
    const QString mode=e.value(u"mode"_s).toString(),regime=e.value(u"regime"_s).toString();
    const bool directional=mode==u"up"||mode==u"down";
    const double sign=mode==u"up"?1:-1;
    const double spot=number(r.value(u"spot"_s)),goal=number(target.value(u"spot"_s));
    const double cost=number(r.value(u"cost"_s)),width=number(r.value(u"width"_s));
    const double qty=number(r.value(u"quantity"_s)),mult=number(r.value(u"multiplier"_s));
    const double lower=number(r.value(u"lower"_s)),upper=number(r.value(u"upper"_s)),center=number(r.value(u"center"_s));
    const double quoteAt=number(r.value(u"now_ms"_s)),expiry=number(r.value(u"expiry_ms"_s)),targetAt=number(target.value(u"epoch_ms"_s));
    const QString today=etClock(nowMs).date;
    const bool fresh=!r.isEmpty()&&plan.value(u"resultFor"_s).toString()==formKey(form)&&!plan.value(u"busy"_s).toBool()
        &&plan.value(u"failure"_s).toString().isEmpty()&&std::isfinite(quoteAt)&&nowMs>=quoteAt&&nowMs-quoteAt<=60000;
    add(u"测算有效性"_s,fresh?u"pass"_s:u"wait"_s,fresh?u"表单一致，测算生成于一分钟内；行情各字段时间仍需核对"_s:u"先测算；改参、刷新失败、运行中或超过一分钟须重新测算"_s);
    const bool structure=r.value(u"symbol"_s).toString()==u"SPX"&&r.value(u"trading_class"_s).toString()==u"SPXW"&&mult==100
        &&std::isfinite(qty)&&qty>=1&&qty==std::floor(qty)&&cost>0&&cost<width&&lower>0
        &&std::abs(center-lower-width)<1e-6&&std::abs(upper-center-width)<1e-6
        &&std::isfinite(expiry)&&etClock(expiry).date==today&&(r.value(u"right"_s).toString()==u"C"||r.value(u"right"_s).toString()==u"P");
    add(u"策略范围"_s,r.isEmpty()?u"wait"_s:structure?u"pass"_s:u"block"_s,u"本复核适用 SPXW 当日到期、买入等翼 1:-2:1 蝶；方向由目标相对现价决定，不由 Call/Put 决定"_s);
    add(u"交易假设"_s,(directional||mode==u"range")?u"pass"_s:u"wait"_s,u"选择上行、下行或区间收敛；墙是待验证的障碍，不是必达目标"_s);
    const bool known=regime==u"bull"||regime==u"bear"||regime==u"range";
    const bool conflict=known&&((mode==u"up"&&regime!=u"bull")||(mode==u"down"&&regime!=u"bear")||(mode==u"range"&&regime!=u"range"));
    add(u"EHG 地形（人工来源）"_s,conflict?u"block"_s:!known||e.value(u"source"_s).toString().trimmed().isEmpty()?u"wait"_s:u"pass"_s,
        conflict?u"所选结构逆着地形；调整假设或等待地形改变"_s:u"需记录外部 EHG 来源及观察时刻；现有 IBKR OI-GEX 不能替代 EHG，也不能推定参与者 h 系数"_s);
    confirm(u"persistent"_s,u"已核对当前交易日多帧地形，排除翻转边界噪声及旧 OI 墙"_s,u"05 §7、§9；07 第14–15页"_s);
    if(directional) {
        add(u"目标方向"_s,std::isfinite(goal)&&std::isfinite(spot)?((goal-spot)*sign>0?u"pass"_s:u"block"_s):u"wait"_s,u"目标必须处于所选方向；趋势可能越过中心及远翼，不能只看方向正确"_s);
        const double gate=number(e.value(u"trigger"_s)),stop=number(e.value(u"invalidation"_s)),barrier=number(e.value(u"barrier"_s));
        const bool path=std::isfinite(gate)&&std::isfinite(stop)&&std::isfinite(barrier)&&gate>0&&stop>0&&barrier>0&&std::isfinite(spot)&&std::isfinite(goal);
        add(u"门位与失效位"_s,!path?u"wait"_s:(spot-stop)*sign<=0||(goal-gate)*sign<=0?u"block"_s:(spot-gate)*sign<0?u"wait"_s:u"pass"_s,
            u"现价须在触发位外；失效位须在现价反方向，目标须越过门位"_s);
        add(u"第一障碍与目标"_s,!path?u"wait"_s:(barrier-spot)*sign<=0||(goal-barrier)*sign>0?u"block"_s:u"pass"_s,
            u"填写前进方向第一处尚未被接受的墙/障碍；目标跨过它时先等突破确认，再重新定义障碍"_s);
        confirm(u"fuel"_s,u"运动方向的 EHG 是负 Gamma 加速带，且已评估冲过远翼的风险"_s,u"05 §4、§7；01 §17.1"_s);
    } else if(mode==u"range") {
        const double lo=number(e.value(u"rangeLow"_s)),hi=number(e.value(u"rangeHigh"_s));
        const bool valid=std::isfinite(lo)&&std::isfinite(hi)&&lo>0&&lo<hi&&std::isfinite(spot)&&std::isfinite(goal);
        add(u"区间与失效边界"_s,!valid?u"wait"_s:spot<=lo||spot>=hi||goal<=lo||goal>=hi?u"block"_s:u"pass"_s,u"现价与目标须位于计划区间内；跌破下界或升破上界时重新评估"_s);
        confirm(u"buffer"_s,u"现价附近 EHG 持续为正，且与翻转边界有缓冲"_s,u"05 §7；07 第12页"_s);
        confirm(u"absorption"_s,u"下跌被买回、上涨被卖出，区间和实现波动率正在收窄"_s,u"05 §7；07 第12页"_s);
    }
    confirm(u"wall"_s,u"用价格接受度、量能与 IV 核对中心/翼附近的墙，不只看密度"_s,u"05 §8、§11；07 第13、15页"_s);
    bool usableQuotes=r[u"legs"].toArray().size()==3;
    for(const auto& leg:r[u"legs"].toArray()) { const double bid=number(leg[u"bid"]),ask=number(leg[u"ask"]);usableQuotes=usableQuotes&&std::isfinite(bid)&&std::isfinite(ask)&&bid>=0&&ask>0&&bid<=ask; }
    const double marketAsk=number(r[u"market"][u"ask"]);
    usableQuotes=usableQuotes&&std::isfinite(marketAsk)&&marketAsk>0;
    add(u"三腿盘口"_s,usableQuotes?u"pass"_s:u"wait"_s,u"三腿均需有效买卖价且不能倒挂；实时类型、逐字段年龄和数量由下方自动核对"_s);
    add(u"现价来源"_s,r[u"spot_source"].toString()==u"quote"?u"pass"_s:u"wait"_s,u"开仓复核要求 SPX 行情现价；手动/期货推算可用于测算，但不直接作为当前入场证据"_s);
    const QString flow=e.value(u"flow"_s).toString();
    add(u"订单流证据"_s,flow!=u"none"&&flow!=u"single"&&flow!=u"complex"?u"wait"_s:u"note"_s,
        flow==u"single"?u"人工使用单腿方向轨：仍需核对置信度与覆盖；买入不等于开仓"_s:flow==u"complex"?u"多腿只作结构背景；不能把蝶式、比例单或孤儿腿拆成方向票"_s:u"订单流未作为方向证据；缺少可信分类时不从成交量猜主动买卖"_s);
    if(flow==u"single")confirm(u"flowQuality"_s,u"单腿方向轨的置信度、覆盖率、时间与方向均已核对，未混入多腿净额"_s,u"06 双轨模型：方向轨、可信度与覆盖"_s);
    const double budget=number(e.value(u"budget"_s)),fees=number(e.value(u"fees"_s));
    const bool riskValid=structure&&std::isfinite(fees)&&fees>=0&&std::isfinite(budget)&&budget>0;
    const double per=cost*mult+fees,total=per*qty;
    const double maxQty=riskValid?std::floor(budget/per):0;
    add(u"单笔风险预算"_s,!riskValid?u"wait"_s:total>budget?u"block"_s:u"pass"_s,
        u"按计划净限价 × 100 + 每组费用/滑点预留计算；完整组合的最大到期损失，非止损成交保证"_s);
    if(riskValid) {
        metric(u"整笔风险含预留"_s,money(total));metric(u"预算可容纳组数"_s,QString::number(maxQty,'f',0));
        const double pnl=(number(target.value(u"value"_s))-cost)*mult*qty-fees*qty;
        metric(u"目标情景净盈亏"_s,money(pnl));metric(u"目标收益 / 最大风险"_s,text(pnl/total));
        double worst=std::numeric_limits<double>::infinity();
        for(const auto& v:r.value(u"scenarios"_s).toArray()) { const double p=(number(v[u"value"])-cost)*mult*qty-fees*qty; if(std::isfinite(p))worst=std::min(worst,p); }
        metric(u"已有 IV 情景最差净盈亏"_s,money(worst));
        const double effective=cost+fees/mult;
        metric(u"到期盈亏平衡（含预留）"_s,effective<width?text(lower+effective)+u" — "+text(upper-effective):u"费用预留后无盈利区"_s);
        add(u"目标收益"_s,!std::isfinite(pnl)?u"wait"_s:pnl<=0?u"block"_s:u"pass"_s,u"仅在假定目标时刻与价格实现时成立；不是胜率或期望收益"_s);
        if(std::isfinite(worst)&&worst<0)add(u"IV 压力提醒"_s,u"note"_s,u"已有 IV 情景存在亏损；这里尚未覆盖价格走反、时间延误与盘口扩张"_s);
    }
    metric(u"计划净限价（点）"_s,text(cost));
    metric(u"腿盘口合成买入价（非保证成交）"_s,text(number(r[u"market"][u"ask"])));
    const auto warnings=r[u"warnings"].toArray();
    for(const auto& warning:warnings) add(u"测算说明"_s,u"note"_s,warning.toString());
    if(!warnings.isEmpty())confirm(u"modelRisk"_s,u"已阅读测算说明及 IV 假设，理解目标收益仅是条件情景"_s,u"现有蝴蝶定价模型输出"_s);
    const QTime stopTime=QTime::fromString(e.value(u"exitTime"_s).toString(),u"HH:mm"_s);
    const double stopAt=QDateTime(QDate::fromString(today,Qt::ISODate),stopTime,QTimeZone("America/New_York")).toMSecsSinceEpoch();
    add(u"时间退出"_s,!stopTime.isValid()||!std::isfinite(targetAt)||!std::isfinite(expiry)?u"wait"_s:stopAt<=nowMs||stopAt<targetAt||stopAt>expiry?u"block"_s:u"pass"_s,u"填写今天的美东最晚退出时刻，须不早于目标时刻且不晚于到期；仅记录计划，不自动挂止损"_s);
    confirm(u"events"_s,u"已复核事件窗口、趋势冲过远翼及提前退出计划"_s,u"01 §22–23；交易计划复核"_s);
    for(const auto& v:entryMarketChecks(plan,e,nowMs)) { const auto c=v.toObject(); add(c["title"].toString(),c["state"].toString(),c["detail"].toString()); }
    const bool ready=blocked==0&&pending==0;
    return {{u"evidence"_s,e},{u"checks"_s,checks},{u"manual"_s,manual},{u"metrics"_s,metrics},{u"ready"_s,ready},
        {u"title"_s,blocked?u"计划存在冲突，先调整"_s:pending?u"等待证据与测算"_s:u"复核已填写，可生成草稿"_s},
        {u"summary"_s,u"%1 项冲突 · %2 项待核实。人工证据每项有效五分钟，测算有效一分钟；这是复核时限，不是交易信号。"_s.arg(blocked).arg(pending)},
        {u"directional"_s,directional},{u"range"_s,mode==u"range"},{u"maxQuantity"_s,maxQty}};
}
}
