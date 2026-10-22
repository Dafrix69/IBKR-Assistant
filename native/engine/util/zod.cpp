#include "util/zod.h"

#include "util/jsformat.h"
#include "util/jsvalue.h"

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::util::zod {

QString parsedTypeName(const OJson* d) {
    if (!d) return u"undefined"_s;
    switch (d->type) {
    case OJson::Null: return u"null"_s;
    case OJson::Bool: return u"boolean"_s;
    case OJson::Number: return std::isnan(d->n) ? u"nan"_s : u"number"_s;
    case OJson::String: return u"string"_s;
    case OJson::Array: return u"array"_s;
    case OJson::Object: return u"object"_s;
    }
    return u"unknown"_s;
}

namespace {

QString num(double v) { return jsNumberToString(v); }

/// invalid_type:received 是 undefined 时话是 "Required"
void invalidType(const Ctx& ctx, const QString& expected, const OJson* data) {
    const QString received = parsedTypeName(data);
    ctx.addIssue(u"invalid_type"_s, received == u"undefined" ? u"Required"_s : u"Expected %1, received %2"_s.arg(expected, received));
    ctx.issues->back().expected = expected;
    ctx.issues->back().received = received;
}

QString joinValues(const QStringList& values, const QString& sep = u" | "_s) {
    QStringList out;
    for (const QString& v : values) out << u'\'' + v + u'\'';
    return out.join(sep);
}

Ctx child(const Ctx& ctx, const QString& key) { return Ctx{ctx.issues, ctx.path + QStringList{key}}; }

// ---------------------------------------------------------------- 包一层的那几种
class OptionalSchema : public Schema {
public:
    explicit OptionalSchema(SchemaPtr inner) : inner_(std::move(inner)) {}
    Result parse(const OJson* d, const Ctx& ctx) const override {
        if (!d) return Result::ok(std::nullopt);
        return inner_->parse(d, ctx);
    }

private:
    SchemaPtr inner_;
};

class NullableSchema : public Schema {
public:
    explicit NullableSchema(SchemaPtr inner) : inner_(std::move(inner)) {}
    Result parse(const OJson* d, const Ctx& ctx) const override {
        if (d && d->type == OJson::Null) return Result::ok(OJson::null());
        return inner_->parse(d, ctx);
    }

private:
    SchemaPtr inner_;
};

class DefaultSchema : public Schema {
public:
    DefaultSchema(SchemaPtr inner, OJson value) : inner_(std::move(inner)), value_(std::move(value)) {}
    Result parse(const OJson* d, const Ctx& ctx) const override { return inner_->parse(d ? d : &value_, ctx); }

private:
    SchemaPtr inner_;
    OJson value_;
};

class TransformSchema : public Schema {
public:
    TransformSchema(SchemaPtr inner, std::function<std::optional<OJson>(const OJson*, CheckCtx&)> fn) : inner_(std::move(inner)), fn_(std::move(fn)) {}
    Result parse(const OJson* d, const Ctx& ctx) const override {
        Status status = Status::Valid;
        CheckCtx check(ctx, status);
        const Result base = inner_->parse(d, ctx);
        if (base.status != Status::Valid) return Result::invalid();
        std::optional<OJson> out = fn_(base.value ? &*base.value : nullptr, check);
        return {status, std::move(out)};
    }

private:
    SchemaPtr inner_;
    std::function<std::optional<OJson>(const OJson*, CheckCtx&)> fn_;
};

class RefineSchema : public Schema {
public:
    RefineSchema(SchemaPtr inner, std::function<void(const OJson&, CheckCtx&)> fn) : inner_(std::move(inner)), fn_(std::move(fn)) {}
    Result parse(const OJson* d, const Ctx& ctx) const override {
        Status status = Status::Valid;
        CheckCtx check(ctx, status);
        const Result inner = inner_->parse(d, ctx);
        if (inner.status == Status::Aborted) return Result::invalid();
        if (inner.status == Status::Dirty && status == Status::Valid) status = Status::Dirty;
        fn_(inner.value.value_or(OJson()), check);  // 返回值不用(同 zod)
        return {status, inner.value};
    }

private:
    SchemaPtr inner_;
    std::function<void(const OJson&, CheckCtx&)> fn_;
};

class PreprocessSchema : public Schema {
public:
    PreprocessSchema(std::function<std::optional<OJson>(const OJson*, CheckCtx&)> fn, SchemaPtr inner) : fn_(std::move(fn)), inner_(std::move(inner)) {}
    Result parse(const OJson* d, const Ctx& ctx) const override {
        Status status = Status::Valid;
        CheckCtx check(ctx, status);
        const std::optional<OJson> processed = fn_(d, check);
        if (status == Status::Aborted) return Result::invalid();
        Result r = inner_->parse(processed ? &*processed : nullptr, ctx);
        if (r.status == Status::Aborted) return Result::invalid();
        if (r.status == Status::Dirty || status == Status::Dirty) return {Status::Dirty, r.value};
        return r;
    }

private:
    std::function<std::optional<OJson>(const OJson*, CheckCtx&)> fn_;
    SchemaPtr inner_;
};

class PipeSchema : public Schema {
public:
    PipeSchema(SchemaPtr in, SchemaPtr out) : in_(std::move(in)), out_(std::move(out)) {}
    Result parse(const OJson* d, const Ctx& ctx) const override {
        const Result r = in_->parse(d, ctx);
        if (r.status == Status::Aborted) return Result::invalid();
        if (r.status == Status::Dirty) return {Status::Dirty, r.value};
        return out_->parse(r.value ? &*r.value : nullptr, ctx);
    }

private:
    SchemaPtr in_, out_;
};

// ---------------------------------------------------------------- 原始类型
class BooleanSchema : public Schema {
public:
    Result parse(const OJson* d, const Ctx& ctx) const override {
        if (!d || d->type != OJson::Bool) return invalidType(ctx, u"boolean"_s, d), Result::invalid();
        return Result::ok(*d);
    }
};

class NullSchema : public Schema {
public:
    Result parse(const OJson* d, const Ctx& ctx) const override {
        if (!d || d->type != OJson::Null) return invalidType(ctx, u"null"_s, d), Result::invalid();
        return Result::ok(*d);
    }
};

class UnknownSchema : public Schema {
public:
    Result parse(const OJson* d, const Ctx&) const override { return Result::ok(d ? std::optional<OJson>(*d) : std::nullopt); }
};

bool strictEqual(const OJson& a, const OJson& b) {
    if (a.type != b.type) return false;
    switch (a.type) {
    case OJson::Null: return true;
    case OJson::Bool: return a.b == b.b;
    case OJson::Number: return a.n == b.n;
    case OJson::String: return a.s == b.s;
    default: return false;  // 对象 / 数组按引用比:JSON 读进来的永远不是同一个
    }
}

class LiteralSchema : public Schema {
public:
    explicit LiteralSchema(OJson v) : value_(std::move(v)) {}
    Result parse(const OJson* d, const Ctx& ctx) const override {
        if (!d || !strictEqual(*d, value_)) {
            ctx.addIssue(u"invalid_literal"_s, u"Invalid literal value, expected "_s + stringifyOJson(value_, 0));
            return Result::invalid();
        }
        return Result::ok(*d);
    }

private:
    OJson value_;
};

class EnumSchema : public Schema {
public:
    explicit EnumSchema(QStringList values) : values_(std::move(values)) {}
    Result parse(const OJson* d, const Ctx& ctx) const override {
        if (!d || d->type != OJson::String) return invalidType(ctx, joinValues(values_), d), Result::invalid();
        if (!values_.contains(d->s)) {
            ctx.addIssue(u"invalid_enum_value"_s, u"Invalid enum value. Expected %1, received '%2'"_s.arg(joinValues(values_), d->s));
            return Result::invalid();
        }
        return Result::ok(*d);
    }

private:
    QStringList values_;
};

/// for (const key in obj):JSON 读进来的对象只有自己的键,次序同 JS
QStringList forInKeys(const OJson& o) {
    QStringList out;
    for (const auto& f : o.fields) out << f.first;
    return out;
}

/// ParseStatus.mergeObjectSync
Result mergeObject(Status status, const std::vector<std::tuple<QString, Result, bool>>& pairs) {
    OJson out;
    out.type = OJson::Object;
    for (const auto& [key, value, alwaysSet] : pairs) {
        if (value.status == Status::Aborted) return Result::invalid();
        if (value.status == Status::Dirty && status == Status::Valid) status = Status::Dirty;
        // zod:值是 undefined 但键在来稿里(alwaysSet)时 finalObject[key] = undefined。OJson 里没有 undefined,按项目的约定
        // (tests/js_fixture.h、JSON.stringify)这一键不出现——和 JSON 里写出来的一样,只是 TS 里 `key in obj` 为真、这里为假
        (void)alwaysSet;
        if (key != u"__proto__" && value.value) out.set(key, *value.value);
    }
    return {status, out};
}

class RecordSchema : public Schema {
public:
    RecordSchema(SchemaPtr key, SchemaPtr value) : key_(std::move(key)), value_(std::move(value)) {}
    Result parse(const OJson* d, const Ctx& ctx) const override {
        if (!d || d->type != OJson::Object) return invalidType(ctx, u"object"_s, d), Result::invalid();
        // 先把每一对的键与值都解一遍(issue 都要出),再合并:键或值有 aborted 的整个 aborted(ParseStatus.mergeObjectSync)
        std::vector<std::tuple<QString, Result, bool>> pairs;
        Status keysStatus = Status::Valid;
        bool aborted = false;
        for (const QString& k : forInKeys(*d)) {
            const OJson keyJson = OJson::string(k);
            const Result kr = key_->parse(&keyJson, child(ctx, k));
            const Result vr = value_->parse(d->get(k), child(ctx, k));
            if (kr.status == Status::Aborted) aborted = true;
            if (kr.status == Status::Dirty) keysStatus = Status::Dirty;
            pairs.emplace_back(kr.value && kr.value->type == OJson::String ? kr.value->s : k, vr, true);
        }
        if (aborted) return Result::invalid();
        return mergeObject(keysStatus, pairs);
    }

private:
    SchemaPtr key_, value_;
};

class UnionSchema : public Schema {
public:
    explicit UnionSchema(std::vector<SchemaPtr> options) : options_(std::move(options)) {}
    Result parse(const OJson* d, const Ctx& ctx) const override {
        std::optional<std::pair<Result, std::vector<Issue>>> dirty;
        std::vector<std::vector<Issue>> failed;  // zod 的 issues:每个有 issue 的分支一份
        for (const SchemaPtr& o : options_) {
            std::vector<Issue> issues;
            const Ctx c{&issues, ctx.path};
            const Result r = o->parse(d, c);
            if (r.status == Status::Valid) return r;
            if (r.status == Status::Dirty && !dirty) dirty.emplace(r, issues);
            if (!issues.empty()) failed.push_back(std::move(issues));
        }
        if (dirty) {
            ctx.issues->insert(ctx.issues->end(), dirty->second.begin(), dirty->second.end());
            return dirty->first;
        }
        ctx.addIssue(u"invalid_union"_s, u"Invalid input"_s);
        ctx.issues->back().unionErrors = std::move(failed);
        return Result::invalid();
    }

private:
    std::vector<SchemaPtr> options_;
};

}  // namespace

// ---------------------------------------------------------------- 链式
SchemaPtr Schema::optional() const { return std::make_shared<OptionalSchema>(self()); }
SchemaPtr Schema::nullable() const { return std::make_shared<NullableSchema>(self()); }
SchemaPtr Schema::defaulted(OJson value) const { return std::make_shared<DefaultSchema>(self(), std::move(value)); }
SchemaPtr Schema::transform(std::function<std::optional<OJson>(const OJson*, CheckCtx&)> fn) const {
    return std::make_shared<TransformSchema>(self(), std::move(fn));
}
SchemaPtr Schema::transform(std::function<OJson(const OJson&, CheckCtx&)> fn) const {
    return transform(std::function<std::optional<OJson>(const OJson*, CheckCtx&)>(
        [fn = std::move(fn)](const OJson* v, CheckCtx& ctx) -> std::optional<OJson> { return fn(v ? *v : OJson(), ctx); }));
}
SchemaPtr Schema::superRefine(std::function<void(const OJson&, CheckCtx&)> fn) const { return std::make_shared<RefineSchema>(self(), std::move(fn)); }
SchemaPtr Schema::pipe(SchemaPtr out) const { return std::make_shared<PipeSchema>(self(), std::move(out)); }

// ---------------------------------------------------------------- 字符串
Result StringSchema::parse(const OJson* d, const Ctx& ctx) const {
    if (!d || d->type != OJson::String) return invalidType(ctx, u"string"_s, d), Result::invalid();
    QString v = d->s;
    Status status = Status::Valid;
    for (const Check& c : checks_) {
        if (c.kind == Check::Trim) {
            v = jsTrim(v);
        } else if (c.kind == Check::Min && v.size() < c.value) {
            ctx.addIssue(u"too_small"_s, c.message.value_or(u"String must contain at least %1 character(s)"_s.arg(num(c.value))));
            status = Status::Dirty;
        } else if (c.kind == Check::Max && v.size() > c.value) {
            ctx.addIssue(u"too_big"_s, c.message.value_or(u"String must contain at most %1 character(s)"_s.arg(num(c.value))));
            status = Status::Dirty;
        }
    }
    return {status, OJson::string(v)};
}

std::shared_ptr<StringSchema> StringSchema::trim() const {
    auto s = std::make_shared<StringSchema>(*this);
    s->checks_.push_back({Check::Trim, 0, std::nullopt});
    return s;
}
std::shared_ptr<StringSchema> StringSchema::min(double n, std::optional<QString> message) const {
    auto s = std::make_shared<StringSchema>(*this);
    s->checks_.push_back({Check::Min, n, std::move(message)});
    return s;
}
std::shared_ptr<StringSchema> StringSchema::max(double n, std::optional<QString> message) const {
    auto s = std::make_shared<StringSchema>(*this);
    s->checks_.push_back({Check::Max, n, std::move(message)});
    return s;
}

// ---------------------------------------------------------------- 数
Result NumberSchema::parse(const OJson* d, const Ctx& ctx) const {
    if (!d || d->type != OJson::Number || std::isnan(d->n)) return invalidType(ctx, u"number"_s, d), Result::invalid();
    const double v = d->n;
    Status status = Status::Valid;
    for (const Check& c : checks_) {
        switch (c.kind) {
        case Check::Int:
            if (!(std::isfinite(v) && std::floor(v) == v)) {
                ctx.addIssue(u"invalid_type"_s, u"Expected integer, received float"_s);
                ctx.issues->back().expected = u"integer"_s;
                ctx.issues->back().received = u"float"_s;
                status = Status::Dirty;
            }
            break;
        case Check::Min:
            if (c.inclusive ? v < c.value : v <= c.value) {
                ctx.addIssue(u"too_small"_s, (c.inclusive ? u"Number must be greater than or equal to "_s : u"Number must be greater than "_s) + num(c.value));
                status = Status::Dirty;
            }
            break;
        case Check::Max:
            if (c.inclusive ? v > c.value : v >= c.value) {
                ctx.addIssue(u"too_big"_s, (c.inclusive ? u"Number must be less than or equal to "_s : u"Number must be less than "_s) + num(c.value));
                status = Status::Dirty;
            }
            break;
        case Check::Finite:
            if (!std::isfinite(v)) {
                ctx.addIssue(u"not_finite"_s, u"Number must be finite"_s);
                status = Status::Dirty;
            }
            break;
        }
    }
    return {status, *d};
}

std::shared_ptr<NumberSchema> NumberSchema::integer() const {
    auto s = std::make_shared<NumberSchema>(*this);
    s->checks_.push_back({Check::Int});
    return s;
}
std::shared_ptr<NumberSchema> NumberSchema::finite() const {
    auto s = std::make_shared<NumberSchema>(*this);
    s->checks_.push_back({Check::Finite});
    return s;
}
std::shared_ptr<NumberSchema> NumberSchema::bound(double v, bool isMax, bool inclusive) const {
    auto s = std::make_shared<NumberSchema>(*this);
    s->checks_.push_back({isMax ? Check::Max : Check::Min, v, inclusive});
    return s;
}

// ---------------------------------------------------------------- 数组
Result ArraySchema::parse(const OJson* d, const Ctx& ctx) const {
    if (!d || d->type != OJson::Array) return invalidType(ctx, u"array"_s, d), Result::invalid();
    Status status = Status::Valid;
    const double n = double(d->items.size());
    if (min_ && n < *min_) {
        ctx.addIssue(u"too_small"_s, u"Array must contain at least %1 element(s)"_s.arg(num(*min_)));
        status = Status::Dirty;
    }
    if (max_ && n > *max_) {
        ctx.addIssue(u"too_big"_s, u"Array must contain at most %1 element(s)"_s.arg(num(*max_)));
        status = Status::Dirty;
    }
    std::vector<Result> results;
    for (qsizetype i = 0; i < d->items.size(); ++i) results.push_back(element_->parse(&d->items[i], child(ctx, QString::number(i))));
    OJson out;
    out.type = OJson::Array;
    for (const Result& r : results) {
        if (r.status == Status::Aborted) return Result::invalid();
        if (r.status == Status::Dirty) status = Status::Dirty;
        out.items << r.value.value_or(OJson());  // undefined 的元素 JSON 里写成 null
    }
    return {status, out};
}
std::shared_ptr<ArraySchema> ArraySchema::min(double n) const {
    auto s = std::make_shared<ArraySchema>(*this);
    s->min_ = n;
    return s;
}
std::shared_ptr<ArraySchema> ArraySchema::max(double n) const {
    auto s = std::make_shared<ArraySchema>(*this);
    s->max_ = n;
    return s;
}

// ---------------------------------------------------------------- 对象
Result ObjectSchema::parse(const OJson* d, const Ctx& ctx) const {
    if (!d || d->type != OJson::Object) return invalidType(ctx, u"object"_s, d), Result::invalid();
    QStringList shapeKeys;
    for (const auto& [k, s] : shape_) shapeKeys << k;
    QStringList extra;
    if (unknown_ != Unknown::Strip)
        for (const QString& k : forInKeys(*d))
            if (!shapeKeys.contains(k)) extra << k;
    std::vector<std::tuple<QString, Result, bool>> pairs;
    for (const auto& [key, schema] : shape_) pairs.emplace_back(key, schema->parse(d->get(key), child(ctx, key)), d->get(key) != nullptr);
    Status status = Status::Valid;
    if (unknown_ == Unknown::Passthrough) {
        for (const QString& k : extra) pairs.emplace_back(k, Result::ok(*d->get(k)), false);
    } else if (unknown_ == Unknown::Strict && !extra.isEmpty()) {
        ctx.addIssue(u"unrecognized_keys"_s, u"Unrecognized key(s) in object: "_s + joinValues(extra, u", "_s));
        ctx.issues->back().keys = extra;
        status = Status::Dirty;
    }
    return mergeObject(status, pairs);
}
std::shared_ptr<ObjectSchema> ObjectSchema::strict() const {
    auto s = std::make_shared<ObjectSchema>(*this);
    s->unknown_ = Unknown::Strict;
    return s;
}
std::shared_ptr<ObjectSchema> ObjectSchema::passthrough() const {
    auto s = std::make_shared<ObjectSchema>(*this);
    s->unknown_ = Unknown::Passthrough;
    return s;
}
std::shared_ptr<ObjectSchema> ObjectSchema::partial() const {
    auto s = std::make_shared<ObjectSchema>(*this);
    for (auto& [k, v] : s->shape_) v = v->optional();
    return s;
}

// ---------------------------------------------------------------- 工厂
SchemaPtr string() { return std::make_shared<StringSchema>(); }
std::shared_ptr<StringSchema> str() { return std::make_shared<StringSchema>(); }
std::shared_ptr<NumberSchema> number() { return std::make_shared<NumberSchema>(); }
SchemaPtr boolean() { return std::make_shared<BooleanSchema>(); }
SchemaPtr null() { return std::make_shared<NullSchema>(); }
SchemaPtr unknown() { return std::make_shared<UnknownSchema>(); }
SchemaPtr literal(OJson value) { return std::make_shared<LiteralSchema>(std::move(value)); }
SchemaPtr enumOf(QStringList values) { return std::make_shared<EnumSchema>(std::move(values)); }
std::shared_ptr<ArraySchema> array(SchemaPtr element) { return std::make_shared<ArraySchema>(std::move(element)); }
std::shared_ptr<ObjectSchema> object(std::vector<std::pair<QString, SchemaPtr>> shape) { return std::make_shared<ObjectSchema>(std::move(shape)); }
SchemaPtr record(SchemaPtr value) { return std::make_shared<RecordSchema>(string(), std::move(value)); }
SchemaPtr record(SchemaPtr key, SchemaPtr value) { return std::make_shared<RecordSchema>(std::move(key), std::move(value)); }
SchemaPtr unionOf(std::vector<SchemaPtr> options) { return std::make_shared<UnionSchema>(std::move(options)); }
SchemaPtr preprocess(std::function<std::optional<OJson>(const OJson*, CheckCtx&)> fn, SchemaPtr schema) {
    return std::make_shared<PreprocessSchema>(std::move(fn), std::move(schema));
}

SafeParse safeParse(const Schema& schema, const OJson* data) {
    SafeParse out;
    const Ctx ctx{&out.issues, {}};
    const Result r = schema.parse(data, ctx);
    out.success = r.status == Status::Valid;
    if (out.success) out.data = r.value;
    return out;
}

}  // namespace ibkr::util::zod
