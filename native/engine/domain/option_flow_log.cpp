#include "domain/option_flow_log.h"

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;

namespace ibkr::domain {

namespace {
bool num(const OJson* v) { return v && v->type == OJson::Number && std::isfinite(v->n); }
bool str(const OJson* v) { return v && v->type == OJson::String; }

bool valid(const OJson& r) {
    if (r.type != OJson::Object || !num(r.get(u"t"_s))) return false;
    const OJson* kind = r.get(u"kind"_s);
    if (!str(kind)) return false;
    if (kind->s == u"sub") return str(r.get(u"expiry"_s)) && r.get(u"contracts"_s) && r.get(u"contracts"_s)->type == OJson::Array;
    const bool contract = str(r.get(u"expiry"_s)) && num(r.get(u"k"_s)) && str(r.get(u"r"_s));
    if (!contract) return false;
    if (kind->s == u"print") return num(r.get(u"dv"_s));
    if (kind->s == u"vol") return num(r.get(u"volume"_s));
    if (kind->s == u"oi") return num(r.get(u"oi"_s));
    if (kind->s == u"tbt") return str(r.get(u"type"_s));
    if (kind->s == u"tbt_err") return str(r.get(u"error"_s));
    return false;
}
}  // namespace

QList<OJson> OptionFlowLog::read(const QString& date) const { return readValid(date, valid); }

}  // namespace ibkr::domain
