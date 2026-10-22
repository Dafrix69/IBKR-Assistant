#include "contract/kit.h"

#include "util/jsobj.h"

using namespace Qt::StringLiterals;

namespace ibkr::contract {

using util::OJson;
namespace js = util::js;

namespace {

QString whereOf(const QStringList& path) { return path.isEmpty() ? u"params"_s : path.join(u'.'); }

QString describeOne(const zod::Issue& issue);

/// describeOne 里 invalid_union 那一支:每个分支各有各的不满意
QString describeUnion(const zod::Issue& issue) {
    const QString where = whereOf(issue.path);
    std::vector<const zod::Issue*> firsts;  // issue.unionErrors.map(e => e.issues[0]).filter(defined)
    for (const auto& e : issue.unionErrors)
        if (!e.empty()) firsts.push_back(&e.front());
    // 有一个分支走得更深(数组里某一档缺了 pct)→ 它最接近调用方的本意,报它
    const zod::Issue* deepest = nullptr;
    for (const zod::Issue* i : firsts)
        if (!deepest || i->path.size() > deepest->path.size()) deepest = i;
    if (deepest && deepest->path.size() > issue.path.size()) return describeOne(*deepest);
    std::vector<const zod::Issue*> types;
    for (const zod::Issue* i : firsts)
        if (i->code == u"invalid_type") types.push_back(i);
    if (!types.empty()) {
        const QString& received = types.front()->received;
        QStringList expected;
        for (const zod::Issue* i : types)
            if (!expected.contains(i->expected)) expected << i->expected;
        return received == u"undefined" ? u"缺少 %1"_s.arg(where) : u"%1 应为 %2,收到 %3"_s.arg(where, expected.join(u" 或 "_s), received);
    }
    return u"%1 的形状不对"_s.arg(where);
}

QString describeOne(const zod::Issue& issue) {
    const QString where = whereOf(issue.path);
    if (issue.code == u"invalid_union") return describeUnion(issue);
    if (issue.code == u"invalid_type") {
        if (issue.received == u"undefined") return u"缺少 %1"_s.arg(where);
        return u"%1 应为 %2,收到 %3"_s.arg(where, issue.expected, issue.received);
    }
    if (issue.code == u"unrecognized_keys") {
        // 只有 strict 的 schema 会走到这里(tracker.*):键名写错了、或者这个键契约里还没登记
        const QString at = issue.path.isEmpty() ? QString() : issue.path.join(u'.') + u" 里"_s;
        return u"%1有不认识的键:%2(这个方法不收没登记的键,没有照单全收)"_s.arg(at, issue.keys.join(u"、"_s));
    }
    return u"%1:%2"_s.arg(where, issue.message);
}

}  // namespace

// kit.ts 的 optional / requiredButReportedByHandler:schema.nullish().transform(v => v ?? fallback)。
// 没给 / null 直接出 fallback(optional 的 fallback 是 undefined);transform 见到内层不是 valid(哪怕只是 dirty)就整个 aborted
namespace {
zod::SchemaPtr nullishOr(zod::SchemaPtr schema, std::optional<OJson> fallback) {
    return schema->nullish()->transform([fallback = std::move(fallback)](const OJson* v, zod::CheckCtx&) -> std::optional<OJson> {
        if (!v || v->type == OJson::Null) return fallback;
        return *v;
    });
}
}  // namespace

zod::SchemaPtr optional(zod::SchemaPtr schema) { return nullishOr(std::move(schema), std::nullopt); }
zod::SchemaPtr nullishDefault(zod::SchemaPtr schema, OJson fallback) { return nullishOr(std::move(schema), std::move(fallback)); }
zod::SchemaPtr requiredButReportedByHandler() { return nullishDefault(zod::string(), OJson::string(QString())); }
zod::SchemaPtr noParams() { return zod::unknown()->transform([](const OJson&, zod::CheckCtx&) { return js::object(); }); }
zod::SchemaPtr truthyOf() {
    return zod::unknown()->transform([](const OJson* v, zod::CheckCtx&) -> std::optional<OJson> { return OJson::boolean(js::truthy(v)); });
}
zod::SchemaPtr passThrough() {
    return zod::unknown()->transform([](const OJson* v, zod::CheckCtx&) -> std::optional<OJson> {
        if (!v) return std::nullopt;
        return *v;
    });
}

QString describeIssue(const std::vector<zod::Issue>& issues) {
    if (issues.empty()) return u"参数不对"_s;
    return describeOne(issues.front());
}

}  // namespace ibkr::contract
