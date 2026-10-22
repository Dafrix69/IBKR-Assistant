#include "orchestrate/local_shorthand.h"

#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/py.h"

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::orchestrate {

util::Task<std::optional<OJson>> tryLocalShorthand(ShorthandHost& host, QString instruction, OJson* snap, domain::EtNow at,
                                                   parsing::shorthand::ShorthandMeta* meta) {
    std::optional<OJson> localPayload;
    QString shorthandNote;
    try {
        if (parsing::shorthand::looksLikeShorthand(instruction)) {
            // 没连券商时快照里没有现价,「15蝴蝶」的中心算不出来——用宏观行情带同款公开源兜底
            for (const QString& sym : parsing::shorthand::shorthandSymbols(instruction)) {
                // 「50蝴蝶」没写标的,上面的快照抽不到 SPX:先问券商(夜盘走期货推算),拿不到才退公开源
                if (js::nullish(js::prop(snap, sym)) && host.router()) {
                    try {
                        const std::optional<double> price = co_await host.router()->indexPrice(sym);
                        if (price) snap->set(sym, js::N(*price));
                    } catch (...) {
                        /* 券商取价失败:照旧退公开源 */
                    }
                }
                if (js::nullish(js::prop(snap, sym))) {
                    const std::optional<double> price = co_await host.publicPrice(sym);
                    if (price) {
                        snap->set(sym, js::N(*price));
                        shorthandNote = u"现价来自公开数据源(可能延迟数分钟),请核对中心行权价与方向"_s;
                    }
                }
                // 现价不是官方指数实时价时要说出来:推算的写明怎么推的,昨收的明说是昨收
                std::optional<OJson> info;
                if (host.router() && host.router()->hasSpotInfo()) info = host.router()->spotInfo(sym);
                const OJson* source = info ? js::prop(&*info, u"source"_s) : nullptr;
                if (shorthandNote.isEmpty() && js::isStr(source) && source->s == u"futures") {
                    shorthandNote = u"现价 "_s + util::jsNumberToString(util::pyRound(js::num(js::prop(&*info, u"price"_s)), 2)) + u":"_s +
                                    js::str(js::prop(&*info, u"note"_s));
                } else if (shorthandNote.isEmpty() && js::isStr(source) && source->s == u"index_stale") {
                    shorthandNote = js::str(js::prop(&*info, u"note"_s)) + u"——请核对中心行权价与看涨看跌"_s;
                }
            }
        }
        OJson payload = parsing::shorthand::tryParseShorthand(instruction, *snap, at, meta);
        if (payload.type != OJson::Null) {
            if (!shorthandNote.isEmpty()) {
                // for (const item of localPayload["orders"]) (item["warnings"]).push(note):缺了 / 不是数组 → TypeError → 外层 catch → 交给大模型
                OJson* orders = js::propMut(&payload, u"orders"_s);
                if (!orders) throw util::JsError(u"orders is not iterable"_s);
                if (orders->type == OJson::Array) {
                    for (OJson& item : orders->items) {
                        OJson* w = js::propMut(&item, u"warnings"_s);
                        if (!w || w->type != OJson::Array) throw util::JsError(u"Cannot read properties of undefined (reading 'push')"_s);
                        w->items.append(js::S(shorthandNote));
                    }
                } else if (!(orders->type == OJson::String && orders->s.isEmpty())) {
                    throw util::JsError(u"orders is not iterable"_s);
                }
            }
            localPayload = payload;
        }
    } catch (...) {
        localPayload = std::nullopt;
    }

    if (!localPayload && parsing::shorthand::looksLikeShorthand(instruction)) {
        // 观测点:哪条蝴蝶写法没被本地语法接住(落到大模型)。不影响任何行为,只为日后照着真实落网样本扩语法
        const OJson detail = js::object({{u"instruction"_s, js::S(instruction.left(120))}});
        host.store().audit(u"engine"_s, u"shorthand_fallback"_s, &detail);
    }
    co_return localPayload;
}

}  // namespace ibkr::orchestrate
