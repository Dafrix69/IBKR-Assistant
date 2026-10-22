#include "analysis/option_trades_csv.h"

#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QHash>
#include <QRegularExpression>
#include <QSet>

#include <algorithm>
#include <cmath>
#include <optional>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::analysis::option_trades_csv {

const QStringList& optionColumns() {
    static const QStringList cols{u"time_et"_s,    u"date_et"_s,      u"symbol"_s,     u"asset"_s, u"structure"_s, u"action"_s,    u"direction"_s,
                                  u"qty"_s,        u"net_price"_s,    u"realized_pnl"_s, u"commission"_s, u"legs"_s, u"order_ids"_s, u"note"_s};
    return cols;
}

QList<QStringList> parseCsv(const QString& text) {
    QList<QStringList> out;
    QStringList row;
    QString field;
    bool quoted = false;
    for (qsizetype i = 0; i < text.size(); ++i) {
        const QChar c = text[i];
        if (quoted) {
            if (c == u'"') {
                if (i + 1 < text.size() && text[i + 1] == u'"') {
                    field += u'"';
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                field += c;
            }
        } else if (c == u'"') {
            quoted = true;
        } else if (c == u',') {
            row << field;
            field.clear();
        } else if (c == u'\n' || c == u'\r') {
            if (c == u'\r' && i + 1 < text.size() && text[i + 1] == u'\n') i += 1;
            row << field;
            out << row;
            row.clear();
            field.clear();
        } else {
            field += c;
        }
    }
    if (!field.isEmpty() || !row.isEmpty()) {
        row << field;
        out << row;
    }
    QList<QStringList> kept;
    for (const QStringList& r : out)
        if (std::any_of(r.begin(), r.end(), [](const QString& f) { return !util::jsTrim(f).isEmpty(); })) kept << r;
    return kept;
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

OJson parseOptionTradesCsv(const QString& textIn, const QString& accountId, const QString& source) {
    const QList<QStringList> all = parseCsv(textIn.startsWith(QChar(0xFEFF)) ? textIn.mid(1) : textIn);
    const QStringList header = all.isEmpty() ? QStringList() : all[0];
    QStringList names;
    for (const QString& h : header) names << util::jsTrim(h);
    QHash<QString, qsizetype> at;
    for (const QString& col : optionColumns()) {
        const qsizetype i = names.indexOf(col);
        if (i < 0) throw OptionTradesCsvError(u"trades.csv 缺少列:"_s + col);
        at.insert(col, i);
    }
    const auto get = [&](const QStringList& cells, const QString& col) { return util::jsTrim(cells.value(at.value(col, -1))); };
    static const QRegularExpression timeRe(u"\\A[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\\z"_s);
    static const QRegularExpression dateRe(u"\\A[0-9]{4}-[0-9]{2}-[0-9]{2}\\z"_s);

    OJson rows = js::array();
    OJson skipped = js::object();
    QSet<QString> seen;
    for (qsizetype li = 1; li < all.size(); ++li) {
        const QStringList& cells = all[li];
        if (cells.size() != header.size()) {
            bump(skipped, u"列数不对"_s);
            continue;
        }
        if (get(cells, u"asset"_s) != u"期权") {
            bump(skipped, u"不是期权(股票走 import-fills)"_s);
            continue;
        }
        const QString timeEt = get(cells, u"time_et"_s);
        const QString dateEt = get(cells, u"date_et"_s);
        const QString symbol = get(cells, u"symbol"_s).toUpper();
        const QString action = get(cells, u"action"_s);
        // 份数可以是空的:拆不开的结构导出里就没写,盈亏照样是真的
        const QString qtyRaw = get(cells, u"qty"_s);
        const auto qty = finite(qtyRaw);
        const auto pnl = finite(get(cells, u"realized_pnl"_s));
        if (!timeRe.match(timeEt).hasMatch() || !dateRe.match(dateEt).hasMatch() || symbol.isEmpty() || action.isEmpty() ||
            (!qtyRaw.isEmpty() && (!qty || *qty <= 0)) || !pnl) {
            bump(skipped, u"字段不全或不合法"_s);
            continue;
        }
        const QString id = u"opt:"_s + timeEt + u'|' + symbol + u'|' + action + u'|' + get(cells, u"order_ids"_s);
        if (seen.contains(id)) {
            bump(skipped, u"文件内重复"_s);
            continue;
        }
        seen.insert(id);
        rows.items << js::object({
            {u"account_id"_s, js::S(accountId)},
            {u"id"_s, js::S(id)},
            {u"time_et"_s, js::S(timeEt)},
            {u"date_et"_s, js::S(dateEt)},
            {u"symbol"_s, js::S(symbol)},
            {u"structure"_s, js::S(get(cells, u"structure"_s))},
            {u"action"_s, js::S(action)},
            {u"direction"_s, js::S(get(cells, u"direction"_s))},
            {u"qty"_s, optN(qty)},
            {u"net_price"_s, optN(finite(get(cells, u"net_price"_s)))},
            {u"realized_pnl"_s, js::N(*pnl)},
            {u"commission"_s, js::N(finite(get(cells, u"commission"_s)).value_or(0))},
            {u"legs"_s, js::S(get(cells, u"legs"_s))},
            {u"note"_s, js::S(get(cells, u"note"_s))},
            {u"source"_s, js::S(source)},
        });
    }
    QStringList times;
    for (const OJson& r : rows.items) times << r.get(u"time_et"_s)->s;
    std::stable_sort(times.begin(), times.end());
    return js::object({{u"rows"_s, rows},
                       {u"skipped"_s, skipped},
                       {u"first"_s, times.isEmpty() ? js::Null() : js::S(times.first())},
                       {u"last"_s, times.isEmpty() ? js::Null() : js::S(times.last())}});
}

}  // namespace ibkr::analysis::option_trades_csv
