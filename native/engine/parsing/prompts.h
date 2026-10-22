// prompts.ts:提示词装配与版本管理。模板放 prompts/ 带版本号,渲染后算 sha256 指纹;两道自检:不许残留 {{VAR}},不许出现任何真实账号。
#pragma once

#include "domain/config.h"
#include "util/error.h"
#include "util/ordered_json.h"
#include "util/pyjson.h"

#include <QString>

#include <vector>

namespace ibkr::parsing::prompts {

class PromptError : public util::JsError {
public:
    using util::JsError::JsError;
};

struct FewShotPair {
    QString name, user;
    util::OJson assistant;  // 业务用的普通对象
    util::JVal assistantJ;  // 指纹用的浮点感知形式
};
struct PromptBundle {
    QString version, system_text, user_template;
    std::vector<FewShotPair> fewshot;
};

QString fingerprint(const PromptBundle& bundle);
PromptBundle loadPromptBundle(const domain::Settings& settings);
QString renderSystem(const QString& tmpl, const domain::Settings& settings);
/// snapshot:{代码: 现价}(松的 JSON 对象;null / 不是对象 = 没有)
QString renderUser(const PromptBundle& bundle, const domain::Settings& settings, const QString& instruction, const domain::EtNow& nowEt,
                   const QString& marketStatus = {}, const util::OJson* snapshot = nullptr);

}  // namespace ibkr::parsing::prompts
