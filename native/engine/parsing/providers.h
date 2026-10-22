// providers.ts:外部大模型接入层(逐句搬)。发出去的仍然只有 S2 级数据;输出仍然要过 schema。
// 能用 json_schema 就用;端点只认 json_object 时自动降级并把 schema 塞进系统提示词,降级记在返回里。
// HTTP 那一层(两个官方 SDK 从外面看得见的样子)在 parsing/sdk_http;期望值:tests/fixtures/gen_llm.mjs(连着真的 SDK 现跑)。
//
// TS 原样照搬、看着像毛病的几处(不改,见交付报告):
//   · Anthropic 的请求一律带 timeout = timeout_s × 1000,SDK 要它是整数:timeout_s 乘出来带小数(1.005 → 1004.9999…)每次调用都是
//     「调用 Anthropic 失败:AnthropicError: timeout must be an integer」;
//   · OpenAI 兼容端点回的正文读坏了(不是 JSON、半截断开)也说成「无法连接 <base_url>:…」;回空正文 / null 是一句没包过的 TypeError;
//   · 「测试连接」不过账号守卫(guardAccountIds 只包 parse 与 completeJson)。
#pragma once

#include "contract/config_types.h"
#include "domain/config.h"
#include "parsing/prompts.h"
#include "parsing/sdk_http.h"
#include "util/ordered_json.h"
#include "util/task.h"

#include <QString>
#include <QStringList>

#include <functional>
#include <memory>
#include <optional>
#include <vector>

namespace ibkr::parsing::providers {

using domain::LLMError;
using domain::validateBaseUrl;
using util::OJson;

/// 界面上的供应商目录(PROVIDERS):{anthropic: {...}, openai_compatible: {...}},键序同 TS
const OJson& providersTable();
/// providerCatalog():[{key, ...meta}]
OJson providerCatalog();

class LLMResponse {
public:
    QString text;
    OJson model;  ///< 回包里的 model(不一定是字符串);没有时是配置里的
    QString prompt_version;
    QString prompt_fingerprint;
    double latency_ms = 0;
    OJson usage = OJson();  ///< 对象
    QString structured_mode = QStringLiteral("json_schema");  ///< json_schema | json_object | none
    /// JSON.parse(text);坏了抛 LLMError
    OJson payload() const;
};

struct TestProbe {
    bool ok = true;
    OJson model;
    double latency_ms = 0;
    QString structured_mode;
    OJson usage;
    QString sample;
};

/// 用哪把 Key:显式给的(非空)优先,否则这时才去凭证库取(util::readSecret,有时限)
util::Task<QString> resolveApiKey(contract::LLMConfig config, std::optional<QString> explicitKey);

// ---------------------------------------------------------------- schema 资产(engine-ts/baseline/llm/<名字>_schema.json)
/// 资产目录;默认从可执行文件往上找 engine-ts/baseline/llm 或 baseline/llm
QString schemaAssetDir();
void setSchemaAssetDir(const QString& dir);
/// 读一份 schema(进程里缓存,每次给一份拷贝);文件读不了抛 Node 的那句 ENOENT 原话
OJson loadSchemaAsset(const QString& name);
OJson structuredOutputSchema(const QString& name = QStringLiteral("parse_result"));
/// 随提示词版本走的 ParseResult schema:v1.8.0 起 Rejection.code 的 enum 去掉 EXCEEDS_LIMIT
OJson parseSchemaForPrompt(const QString& promptVersion);

bool supportsSamplingParams(const QString& model);
/// 有些兼容端点把 JSON 包在 ``` 里
QString stripCodeFence(const QString& text);
const OJson& pingSchema();

/// friendlyApiError 看的那三样:constructor.name、message、status(typeof 是 number 才算)
struct ErrorView {
    QString name;
    QString message;
    std::optional<double> status;
};
/// 从接住的异常取出那三样(LLMError / SdkError / NamedError / 别的 JsError)
ErrorView errorView(const std::exception_ptr& e);
QString friendlyApiError(const ErrorView& exc, const QString& baseUrl = {});

// ---------------------------------------------------------------- 解析器
class Parser {
public:
    virtual ~Parser() = default;
    virtual QString provider() const = 0;
    virtual const contract::LLMConfig& config() const = 0;
    virtual util::Task<LLMResponse> parse(prompts::PromptBundle bundle, QString userMessage) = 0;
    /// 单轮小任务:不带交易少样本,只按给定 schema 要 JSON
    virtual util::Task<OJson> completeJson(QString system, QString user, OJson schema) = 0;
    /// 「测试连接」;apiKey 空 = 用构造时给的(再没有就去凭证库)
    virtual util::Task<TestProbe> test(std::optional<QString> apiKey = std::nullopt) = 0;
};

/// 官方 SDK + structured outputs。端点:ANTHROPIC_BASE_URL(SDK 自己读的环境变量)或 https://api.anthropic.com
class AnthropicParser : public Parser, public std::enable_shared_from_this<AnthropicParser> {
public:
    AnthropicParser(contract::LLMConfig config, std::optional<QString> apiKey = std::nullopt);
    QString provider() const override { return QStringLiteral("anthropic"); }
    const contract::LLMConfig& config() const override { return config_; }
    /// 发给 messages.create 的请求体(键序同 TS)
    OJson requestKwargs(const QString& system, const OJson& messages, const OJson& schema) const;
    util::Task<LLMResponse> parse(prompts::PromptBundle bundle, QString userMessage) override;
    util::Task<OJson> completeJson(QString system, QString user, OJson schema) override;
    util::Task<TestProbe> test(std::optional<QString> apiKey = std::nullopt) override;

private:
    util::Task<std::shared_ptr<sdk::Client>> ensureClient();
    contract::LLMConfig config_;
    std::optional<QString> apiKey_;
    std::shared_ptr<sdk::Client> client_;
};

/// 走 /chat/completions 的通用实现(openai SDK 的传输;请求体逐字段自己拼)
class OpenAICompatibleParser : public Parser, public std::enable_shared_from_this<OpenAICompatibleParser> {
public:
    /// base_url 不合规当场抛 LLMError(validateBaseUrl 的原话)
    OpenAICompatibleParser(contract::LLMConfig config, std::optional<QString> apiKey = std::nullopt);
    QString provider() const override { return QStringLiteral("openai_compatible"); }
    const contract::LLMConfig& config() const override { return config_; }
    const QString& baseUrl() const { return baseUrl_; }
    util::Task<LLMResponse> parse(prompts::PromptBundle bundle, QString userMessage) override;
    util::Task<OJson> completeJson(QString system, QString user, OJson schema) override;
    util::Task<TestProbe> test(std::optional<QString> apiKey = std::nullopt) override;

    /// 先试 json_schema,端点不认再退到 json_object;fresh = 不看记下的拒绝(「测试连接」)。返回 (回包, 模式);回包空 = undefined
    util::Task<std::pair<sdk::Body, QString>> complete(OJson messages, OJson schema, bool fresh = false);

private:
    util::Task<std::shared_ptr<sdk::Client>> ensureClient();
    util::Task<sdk::Body> post(QString pathName, OJson body);
    contract::LLMConfig config_;
    std::optional<QString> apiKey_;
    QString baseUrl_;
    std::shared_ptr<sdk::Client> client_;
};

/// 按 config.provider 建;不认识的供应商抛 LLMError
std::shared_ptr<Parser> buildParser(const contract::LLMConfig& config, std::optional<QString> apiKey = std::nullopt);

struct AccountRef {
    QString alias;
    QString account_id;
};
/// §9.1「真实账号永远不进提示词」:parse 与 completeJson 外发之前查一遍,出现配置里的真实账号就中止(不替用户改写)。
/// 「测试连接」不包(TS 原样)
std::shared_ptr<Parser> guardAccountIds(std::shared_ptr<Parser> parser, std::function<std::vector<AccountRef>()> accounts);

/// 少样本的 assistant 用浮点感知序列化;cacheLast:最后一条打 cache_control
OJson fewshotMessages(const prompts::PromptBundle& bundle, bool cacheLast);

}  // namespace ibkr::parsing::providers
