#include "analysis/fills_csv.h"

#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QRegularExpression>
#include <QSet>

#include <algorithm>
#include <cmath>
#include <optional>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::analysis::fills_csv {

const QStringList& requiredColumns() {
    static const QStringList cols{u"trade_time_utc"_s, u"symbol"_s,     u"sec_type"_s, u"currency"_s, u"side"_s,    u"size"_s,
                                  u"price"_s,          u"exchange"_s,   u"commission"_s, u"order_id"_s, u"trade_id"_s};
    return cols;
}

namespace {
/// "2025-10-31T09:13:36Z" → "2025-10-31T09:13:36+00:00"
std::optional<QString> isoUtc(const QString& raw) {
    static const QRegularExpression re(u"\\A([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}:[0-9]{2}:[0-9]{2})(?:\\.[0-9]+)?(?:Z|\\+00:00)\\z"_s);
    const auto m = re.match(util::jsTrim(raw));
    if (!m.hasMatch()) return std::nullopt;
    return m.captured(1) + u'T' + m.captured(2) + u"+00:00"_s;
}
std::optional<double> finite(const QString& raw) {
    if (util::jsTrim(raw).isEmpty()) return std::nullopt;
    const double n = util::jsStringToNumber(raw);
    return std::isfinite(n) ? std::optional<double>(n) : std::nullopt;
}
void bump(OJson& skipped, const QString& reason) {
    const OJson* v = skipped.get(reason);
    skipped.set(reason, js::N((v ? v->n : 0) + 1));
}
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : js::Null(); }
/// split(/\r?\n/):以 \n 切开,每段(最后一段除外)末尾的一个 \r 属于分隔符
QStringList splitLines(const QString& text) {
    QStringList parts = text.split(u'\n');
    for (qsizetype i = 0; i + 1 < parts.size(); ++i)
        if (parts[i].endsWith(u'\r')) parts[i].chop(1);
    return parts;
}
}  // namespace

OJson parseFillsCsv(const QString& textIn, const QString& accountId) {
    const QString text = textIn.startsWith(QChar(0xFEFF)) ? textIn.mid(1) : textIn;
    QStringList lines;
    for (const QString& l : splitLines(text))
        if (!util::jsTrim(l).isEmpty()) lines << l;
    QStringList header;
    for (const QString& h : (lines.isEmpty() ? QString() : lines[0]).split(u',')) header << util::jsTrim(h);
    QHash<QString, qsizetype> at;
    for (const QString& col : requiredColumns()) {
        const qsizetype i = header.indexOf(col);
        if (i < 0) throw FillsCsvError(u"fills.csv 缺少列:"_s + col);
        at.insert(col, i);
    }
    const auto get = [&](const QStringList& cells, const QString& col) { return util::jsTrim(cells.value(at.value(col, -1))); };

    OJson fills = js::array();
    OJson skipped = js::object();
    QSet<QString> seen;
    for (qsizetype li = 1; li < lines.size(); ++li) {
        const QStringList cells = lines[li].split(u',');
        if (cells.size() != header.size()) {
            bump(skipped, u"列数不对"_s);
            continue;
        }
        const QString secType = get(cells, u"sec_type"_s).toUpper();
        if (secType == u"OPT") {
            bump(skipped, u"期权(没有合约描述,等 Flex 导出)"_s);
            continue;
        }
        if (secType != u"STK") {
            bump(skipped, u"不是股票("_s + (secType.isEmpty() ? u"空"_s : secType) + u')');
            continue;
        }
        const QString execId = get(cells, u"trade_id"_s);
        const auto time = isoUtc(get(cells, u"trade_time_utc"_s));
        const auto shares = finite(get(cells, u"size"_s));
        const auto price = finite(get(cells, u"price"_s));
        const QString side = get(cells, u"side"_s).toUpper();
        if (execId.isEmpty() || !time || !shares || *shares <= 0 || !price || *price <= 0 || (side != u"BUY" && side != u"SELL")) {
            bump(skipped, u"字段不全或不合法"_s);
            continue;
        }
        if (seen.contains(execId)) {
            bump(skipped, u"文件内重复"_s);
            continue;
        }
        seen.insert(execId);
        const double perm = std::trunc(util::jsStringToNumber(get(cells, u"order_id"_s)));
        const QString currency = get(cells, u"currency"_s).toUpper();
        fills.items << js::object({
            {u"exec_id"_s, js::S(execId)},
            {u"time"_s, js::S(*time)},
            {u"account_id"_s, js::S(accountId)},
            {u"side"_s, js::S(side == u"BUY" ? u"BOT"_s : u"SLD"_s)},
            {u"shares"_s, js::N(*shares)},
            {u"price"_s, js::N(*price)},
            {u"order_id"_s, js::Null()},
            {u"perm_id"_s, std::isfinite(perm) && perm > 0 ? js::N(perm) : js::Null()},
            {u"order_ref"_s, js::S(QString())},
            {u"commission"_s, optN(finite(get(cells, u"commission"_s)))},
            {u"contract"_s, js::object({{u"secType"_s, js::S(u"STK"_s)},
                                        {u"symbol"_s, js::S(get(cells, u"symbol"_s).toUpper())},
                                        {u"expiry"_s, js::S(QString())},
                                        {u"strike"_s, js::Null()},
                                        {u"right"_s, js::S(QString())},
                                        {u"tradingClass"_s, js::S(QString())},
                                        {u"multiplier"_s, js::S(QString())},
                                        {u"conId"_s, js::Null()},
                                        {u"currency"_s, js::S(currency.isEmpty() ? u"USD"_s : currency)},
                                        {u"exchange"_s, js::S(get(cells, u"exchange"_s))}})},
        });
    }
    QStringList times;
    for (const OJson& f : fills.items) times << f.get(u"time"_s)->s;
    std::stable_sort(times.begin(), times.end());
    return js::object({{u"fills"_s, fills},
                       {u"skipped"_s, skipped},
                       {u"first"_s, times.isEmpty() ? js::Null() : js::S(times.first())},
                       {u"last"_s, times.isEmpty() ? js::Null() : js::S(times.last())}});
}

}  // namespace ibkr::analysis::fills_csv
