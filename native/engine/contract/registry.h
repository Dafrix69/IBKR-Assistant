// 契约方法的登记表:方法名 → 入参 schema + 两个标志(顶层是不是 strict、是不是敏感方法)。
// 对应 TS 的 schema/index.ts 的 PARAMS_SCHEMAS(contractMethodNames)与 contract/index.ts 的 SENSITIVE_METHODS
// ——后者是 contract/ 里唯一一个运行时的值,其余各域的 contract/<域>.ts 全是纯类型,C++ 这边没有对应物(清单见交付报告)。
// handler 不在这里:各域 handler 搬过来时用 transport/contract_methods.h 的 addContractMethod 挂上。
#pragma once

#include "contract/kit.h"

#include <QString>
#include <QStringList>

#include <vector>

namespace ibkr::contract {

struct MethodSpec {
    QString name;
    ParamsSchema schema;
    /// 顶层是 .strict()(不认识的键当场拒)。钱路径与动配置的方法都该是 true;TS 里没写的几个(broker.connect 等)是 false,照搬
    bool strictTop = false;
    /// 在 SENSITIVE_METHODS 里:桌面端要求界面确认过
    bool sensitive = false;
};

/// 全部契约方法,次序同 PARAMS_SCHEMAS
const std::vector<MethodSpec>& methodSpecs();
/// 没登记回空
const MethodSpec* findMethod(const QString& name);
/// SENSITIVE_METHODS(次序同 contract/index.ts)
const QStringList& sensitiveMethods();
/// contractMethodNames():排好序的方法名(JS 的 sort() 按 UTF-16 码元,方法名都是 ASCII)
QStringList contractMethodNames();

/// schema.safeParse(raw);raw 为空 = undefined。方法没登记是编程错误(TS 里是 PARAMS_SCHEMAS[name] 取到 undefined 后的 TypeError),抛 util::JsError
zod::SafeParse parseParams(const QString& method, const util::OJson* raw);

}  // namespace ibkr::contract
