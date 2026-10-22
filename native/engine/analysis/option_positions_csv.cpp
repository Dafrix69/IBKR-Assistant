#include "analysis/option_positions_csv.h"

#include "analysis/option_trades_csv.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QHash>
#include <QRegularExpression>
#include <QSet>
#include <QStringList>

#include <algorithm>
#include <cmath>
#include <optional>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::analysis::option_positions_csv {

const QList<QPair<QString, QString>>& positionColumns() {
    static const QList<QPair<QString, QString>> cols{
        {u"open"_s, u"开仓时间(美东)"_s},     {u"symbol"_s, u"标的"_s},          {u"structure"_s, u"结构"_s},
        {u"direction"_s, u"方向"_s},          {u"qty"_s, u"份数"_s},             {u"expiry"_s, u"到期日"_s},
        {u"dte"_s, u"开仓时距到期(天)"_s},    {u"right"_s, u"C/P"_s},            {u"strikes"_s, u"行权价"_s},
        {u"center"_s, u"蝴蝶中心"_s},         {u"width"_s, u"翼宽"_s},           {u"ratio"_s, u"比例"_s},
        {u"netPrice"_s, u"开仓净价(点,正=付)"_s}, {u"legs"_s, u"开仓各腿"_s},    {u"exit"_s, u"退出方式"_s},
        {u"status"_s, u"状态"_s},             {u"closed"_s, u"最后了结时间(美东)"_s}, {u"holdMin"_s, u"持有分钟"_s},
        {u"pnl"_s, u"已实现盈亏(已扣佣金)"_s}, {u"commission"_s, u"佣金"_s},
    };
    return cols;
}

namespace {
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
}  // namespace

OJson parseOptionPositionsCsv(const QString& textIn, const QString& accountId, const QString& source) {
    const QList<QStringList> all = option_trades_csv::parseCsv(textIn.startsWith(QChar(0xFEFF)) ? textIn.mid(1) : textIn);
    const QStringList header = all.isEmpty() ? QStringList() : all[0];
    QStringList names;
    for (const QString& h : header) names << util::jsTrim(h);
    QHash<QString, qsizetype> at;
    for (const auto& [key, col] : positionColumns()) {
        const qsizetype i = names.indexOf(col);
        if (i < 0) throw OptionPositionsCsvError(u"option_positions.csv 缺少列:"_s + col);
        at.insert(key, i);
    }
    const auto get = [&](const QStringList& cells, const QString& key) { return util::jsTrim(cells.value(at.value(key, -1))); };
    static const QRegularExpression etTime(u"\\A[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\\z"_s);

    OJson rows = js::array();
    OJson skipped = js::object();
    QSet<QString> seen;
    for (qsizetype li = 1; li < all.size(); ++li) {
        const QStringList& cells = all[li];
        if (cells.size() != header.size()) {
            bump(skipped, u"列数不对"_s);
            continue;
        }
        const QString open = get(cells, u"open"_s);
        const QString symbol = get(cells, u"symbol"_s).toUpper();
        const auto pnl = finite(get(cells, u"pnl"_s));
        const QString closed = get(cells, u"closed"_s);
        if (!etTime.match(open).hasMatch() || symbol.isEmpty() || !pnl || (!closed.isEmpty() && !etTime.match(closed).hasMatch())) {
            bump(skipped, u"字段不全或不合法"_s);
            continue;
        }
        const QString legs = get(cells, u"legs"_s);
        const QString id = u"pos:"_s + open + u'|' + symbol + u'|' + legs;
        if (seen.contains(id)) {
            bump(skipped, u"文件内重复"_s);
            continue;
        }
        seen.insert(id);
        rows.items << js::object({
            {u"account_id"_s, js::S(accountId)},
            {u"id"_s, js::S(id)},
            {u"open_et"_s, js::S(open)},
            {u"symbol"_s, js::S(symbol)},
            {u"structure"_s, js::S(get(cells, u"structure"_s))},
            {u"direction"_s, js::S(get(cells, u"direction"_s))},
            {u"qty"_s, optN(finite(get(cells, u"qty"_s)))},
            {u"expiry"_s, js::S(get(cells, u"expiry"_s))},
            {u"dte"_s, optN(finite(get(cells, u"dte"_s)))},
            {u"right"_s, js::S(get(cells, u"right"_s).toUpper())},
            {u"strikes"_s, js::S(get(cells, u"strikes"_s))},
            {u"center"_s, optN(finite(get(cells, u"center"_s)))},
            {u"width"_s, optN(finite(get(cells, u"width"_s)))},
            {u"ratio"_s, js::S(get(cells, u"ratio"_s))},
            {u"net_price"_s, optN(finite(get(cells, u"netPrice"_s)))},
            {u"legs"_s, js::S(legs)},
            {u"exit"_s, js::S(get(cells, u"exit"_s))},
            {u"status"_s, js::S(get(cells, u"status"_s))},
            {u"closed_et"_s, js::S(closed)},
            {u"hold_min"_s, optN(finite(get(cells, u"holdMin"_s)))},
            {u"realized_pnl"_s, js::N(*pnl)},
            {u"commission"_s, js::N(finite(get(cells, u"commission"_s)).value_or(0))},
            {u"source"_s, js::S(source)},
        });
    }
    QStringList times;
    for (const OJson& r : rows.items) times << r.get(u"open_et"_s)->s;
    std::stable_sort(times.begin(), times.end());
    return js::object({{u"rows"_s, rows},
                       {u"skipped"_s, skipped},
                       {u"first"_s, times.isEmpty() ? js::Null() : js::S(times.first())},
                       {u"last"_s, times.isEmpty() ? js::Null() : js::S(times.last())}});
}

}  // namespace ibkr::analysis::option_positions_csv
