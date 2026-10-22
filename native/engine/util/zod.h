// zod 3.25.76 的那一小块(engine-ts 的 models.ts 与 contract/schema/*.ts 用到的):照 node_modules/zod/v3/types.js 逐类搬 _parse。
// 要逐字一致的是 issue 的 code、path、message 与先后(LLM 输出没过结构校验时,原话进拒单说明;RPC 入参没过时,原话进回执),
// 以及 valid / dirty / aborted 三态的传法——它决定了哪些后续检查还会跑:
//   · 类型不对 → aborted,外层对象 / 数组整个 aborted,对象上的 superRefine 不跑;
//   · 只是检查没过(min / max / int / unrecognized_keys / 自定义的 addIssue)→ dirty,值留着,superRefine 照样跑;
//   · transform 见到不是 valid 的就整个 aborted(不加新的 issue);pipe 见到 dirty 就不跑后半段;preprocess 透传内层的三态。
// 值:const OJson* 为空 = undefined;结果的 value 是 std::optional<OJson>(空 = undefined,放进对象时这一键不出现)。
#pragma once

#include "util/ordered_json.h"

#include <QString>
#include <QStringList>

#include <functional>
#include <memory>
#include <optional>
#include <vector>

namespace ibkr::util::zod {

struct Issue {
    QString code;      // invalid_type / too_small / too_big / invalid_enum_value / invalid_literal / unrecognized_keys / invalid_union / not_finite / custom …
    QStringList path;  // 数组下标写成十进制(path.join(".") 同 JS)
    QString message;
    // 各 code 带的那几个字段(zod 的 ZodIssueOptionalMessage 联合;describeIssue 要读它们,别从 message 里反解):
    QString expected;  // invalid_type:期望的类型名(枚举不是字符串时是 'a' | 'b' 那一串);received 是 undefined 时 message 是 "Required",expected 照样有
    QString received;  // invalid_type:ZodParsedType 的名字
    QStringList keys;  // unrecognized_keys:多出来的键(次序同 for…in)
    std::vector<std::vector<Issue>> unionErrors;  // invalid_union:每个没过的分支各一份 issue 清单(zod 里是 ZodError.issues),分支的先后
};

enum class Status { Valid, Dirty, Aborted };

struct Result {
    Status status = Status::Valid;
    std::optional<OJson> value;  // 空 = undefined
    static Result invalid() { return {Status::Aborted, std::nullopt}; }
    static Result ok(std::optional<OJson> v) { return {Status::Valid, std::move(v)}; }
};

struct Ctx {
    std::vector<Issue>* issues;
    QStringList path;
    void addIssue(const QString& code, const QString& message, const QStringList& extraPath = {}) const {
        Issue issue;
        issue.code = code;
        issue.path = path + extraPath;
        issue.message = message;
        issues->push_back(std::move(issue));
    }
};

/// superRefine / transform 里的 ctx(addIssue 之后外层变 dirty)
class CheckCtx {
public:
    CheckCtx(const Ctx& ctx, Status& status) : ctx_(ctx), status_(status) {}
    void addIssue(const QString& message, const QStringList& path = {}, bool fatal = false) {
        ctx_.addIssue(QStringLiteral("custom"), message, path);
        if (fatal) status_ = Status::Aborted;
        else if (status_ == Status::Valid) status_ = Status::Dirty;
    }
    const QStringList& path() const { return ctx_.path; }

private:
    const Ctx& ctx_;
    Status& status_;
};

class Schema;
using SchemaPtr = std::shared_ptr<const Schema>;

class Schema : public std::enable_shared_from_this<Schema> {
public:
    virtual ~Schema() = default;
    virtual Result parse(const OJson* data, const Ctx& ctx) const = 0;

    // 链式写法(同 zod):每个都返回新的 schema
    SchemaPtr optional() const;
    SchemaPtr nullable() const;
    SchemaPtr nullish() const { return nullable()->optional(); }
    SchemaPtr defaulted(OJson value) const;
    /// zod 的 transform 两头都是 any:入参是内层解出来的值(内层是 optional 时可能是 undefined = 空指针),返回也可以是 undefined(空;放进对象时这一键不出现)
    SchemaPtr transform(std::function<std::optional<OJson>(const OJson*, CheckCtx&)> fn) const;
    /// 入参不会是 undefined、也不返回 undefined 的常见写法(入参是 undefined 时当 null 给)
    SchemaPtr transform(std::function<OJson(const OJson&, CheckCtx&)> fn) const;
    SchemaPtr superRefine(std::function<void(const OJson&, CheckCtx&)> fn) const;
    SchemaPtr pipe(SchemaPtr out) const;

protected:
    SchemaPtr self() const { return shared_from_this(); }
};

// ---- 基本类型
class StringSchema : public Schema {
public:
    Result parse(const OJson* data, const Ctx& ctx) const override;
    std::shared_ptr<StringSchema> trim() const;
    std::shared_ptr<StringSchema> min(double n, std::optional<QString> message = std::nullopt) const;
    std::shared_ptr<StringSchema> max(double n, std::optional<QString> message = std::nullopt) const;

private:
    struct Check {
        enum Kind { Trim, Min, Max } kind;
        double value = 0;
        std::optional<QString> message;
    };
    std::vector<Check> checks_;
};

class NumberSchema : public Schema {
public:
    Result parse(const OJson* data, const Ctx& ctx) const override;
    std::shared_ptr<NumberSchema> integer() const;
    std::shared_ptr<NumberSchema> finite() const;
    std::shared_ptr<NumberSchema> gt(double v) const { return bound(v, false, false); }
    std::shared_ptr<NumberSchema> gte(double v) const { return bound(v, false, true); }
    std::shared_ptr<NumberSchema> min(double v) const { return gte(v); }
    std::shared_ptr<NumberSchema> lt(double v) const { return bound(v, true, false); }
    std::shared_ptr<NumberSchema> lte(double v) const { return bound(v, true, true); }
    std::shared_ptr<NumberSchema> max(double v) const { return lte(v); }

private:
    std::shared_ptr<NumberSchema> bound(double v, bool isMax, bool inclusive) const;
    struct Check {
        enum Kind { Int, Min, Max, Finite } kind;
        double value = 0;
        bool inclusive = true;
    };
    std::vector<Check> checks_;
};

SchemaPtr string();
std::shared_ptr<StringSchema> str();
std::shared_ptr<NumberSchema> number();
SchemaPtr boolean();
SchemaPtr null();
SchemaPtr unknown();
SchemaPtr literal(OJson value);
SchemaPtr enumOf(QStringList values);

// ---- 组合
class ArraySchema : public Schema {
public:
    explicit ArraySchema(SchemaPtr element) : element_(std::move(element)) {}
    Result parse(const OJson* data, const Ctx& ctx) const override;
    std::shared_ptr<ArraySchema> min(double n) const;
    std::shared_ptr<ArraySchema> max(double n) const;

private:
    SchemaPtr element_;
    std::optional<double> min_, max_;
};
std::shared_ptr<ArraySchema> array(SchemaPtr element);

class ObjectSchema : public Schema {
public:
    enum class Unknown { Strip, Strict, Passthrough };
    explicit ObjectSchema(std::vector<std::pair<QString, SchemaPtr>> shape) : shape_(std::move(shape)) {}
    Result parse(const OJson* data, const Ctx& ctx) const override;
    std::shared_ptr<ObjectSchema> strict() const;
    std::shared_ptr<ObjectSchema> passthrough() const;
    std::shared_ptr<ObjectSchema> partial() const;
    bool isStrict() const { return unknown_ == Unknown::Strict; }
    const std::vector<std::pair<QString, SchemaPtr>>& shape() const { return shape_; }

private:
    std::vector<std::pair<QString, SchemaPtr>> shape_;
    Unknown unknown_ = Unknown::Strip;
};
std::shared_ptr<ObjectSchema> object(std::vector<std::pair<QString, SchemaPtr>> shape);

SchemaPtr record(SchemaPtr value);  // z.record(value):键是字符串
SchemaPtr record(SchemaPtr key, SchemaPtr value);
SchemaPtr unionOf(std::vector<SchemaPtr> options);
SchemaPtr preprocess(std::function<std::optional<OJson>(const OJson*, CheckCtx&)> fn, SchemaPtr schema);  // fn 的入参与返回都可能是 undefined(空)

// ---- 解析
struct SafeParse {
    bool success = false;
    std::optional<OJson> data;
    std::vector<Issue> issues;
};
SafeParse safeParse(const Schema& schema, const OJson* data);

/// ZodParsedType 的名字(Expected …, received …)
QString parsedTypeName(const OJson* data);

}  // namespace ibkr::util::zod
