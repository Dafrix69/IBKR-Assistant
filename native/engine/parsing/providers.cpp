#include "parsing/providers.h"

#include "util/whatwg_url.h"
#include "util/jsnum.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/pyjson.h"
#include "util/secrets.h"

#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QHash>
#include <QRegularExpression>
#include <QSet>

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::parsing::providers {

namespace js = util::js;
using sdk::NamedError;
using sdk::SdkError;

namespace {

/// String.prototype.trimEnd():与 jsTrim 同一组空白
QString jsTrimEnd(const QString& s) {
    qsizetype e = s.size();
    while (e > 0 && util::isJsWhitespace(s.at(e - 1))) --e;
    return s.left(e);
}

/// TS 的 v?.[key] ?? fallback 之后 String()
QString strOr(const OJson* v, const QString& fallback) { return js::nullish(v) ? fallback : js::str(v); }

/// performance.now() 两次相减之后 Math.trunc
double elapsedMs(const QElapsedTimer& t) { return std::trunc(double(t.nsecsElapsed()) / 1e6); }

/// `(response?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("")`
QString joinTextBlocks(const OJson* response) {
    const OJson* content = js::prop(response, u"content"_s);
    if (js::nullish(content)) return {};
    if (content->type != OJson::Array) throw NamedError(u"TypeError"_s, u"((intermediate value) ?? []).filter is not a function"_s);
    QString out;
    for (const OJson& b : content->items) {
        const OJson* type = js::prop(&b, u"type"_s);
        if (!(type && type->type == OJson::String && type->s == u"text")) continue;
        const OJson* text = js::prop(&b, u"text"_s);
        if (!js::nullish(text)) out += js::str(text);  // join 把 undefined / null 写成空串
    }
    return out;
}

/// 回包里的 model ?? 配置里的
OJson modelOr(const OJson* data, const QString& fallback) {
    const OJson* m = js::prop(data, u"model"_s);
    return js::nullish(m) ? OJson::string(fallback) : *m;
}

OJson anthropicUsage(const OJson* usage) {
    OJson out = js::object();
    if (js::nullish(usage)) return out;
    for (const QString& key : {u"input_tokens"_s, u"output_tokens"_s, u"cache_creation_input_tokens"_s, u"cache_read_input_tokens"_s}) {
        const OJson* v = js::prop(usage, key);
        if (!js::nullish(v)) out.set(key, *v);
    }
    return out;
}

OJson openaiUsage(const OJson* usage) {
    if (!usage || usage->type != OJson::Object) return js::object();
    return js::object({
        {u"input_tokens"_s, js::copyOrNull(js::prop(usage, u"prompt_tokens"_s))},  // ?? null
        {u"output_tokens"_s, js::copyOrNull(js::prop(usage, u"completion_tokens"_s))},
        {u"cache_hit_tokens"_s, js::copyOrNull(js::prop(usage, u"prompt_cache_hit_tokens"_s))},
        {u"cache_miss_tokens"_s, js::copyOrNull(js::prop(usage, u"prompt_cache_miss_tokens"_s))},
    });
}

/// `data["choices"]` 时 data 是 undefined / null:V8 的 TypeError 原话
const OJson* dataOrThrow(const sdk::Body& data) {
    if (!data) throw NamedError(u"TypeError"_s, u"Cannot read properties of undefined (reading 'choices')"_s);
    if (data->type == OJson::Null) throw NamedError(u"TypeError"_s, u"Cannot read properties of null (reading 'choices')"_s);
    return &*data;
}

/// `data["choices"]?.[0] ?? {}`
OJson firstChoice(const OJson* data) {
    const OJson* c = js::prop(js::prop(data, u"choices"_s), u"0"_s);
    return js::nullish(c) ? js::object() : *c;
}

/// `String(((choice["message"]) ?? {})["content"] ?? "")`
QString choiceContent(const OJson& choice) {
    const OJson* msg = js::prop(&choice, u"message"_s);
    return strOr(js::prop(msg, u"content"_s), QString());
}

/// JSON.parse,坏了换成 LLMError「模型输出不是合法 JSON:…」
OJson parseModelJson(const QString& text) {
    try {
        return js::parseOrThrow(text);
    } catch (const util::JsError& e) {
        throw LLMError(u"模型输出不是合法 JSON:"_s + e.message());
    }
}

QString errorName(const std::exception_ptr& e) { return errorView(e).name; }
QString errorMessage(const std::exception_ptr& e) { return errorView(e).message; }

double versionKey(const QString& version) {
    static const QRegularExpression digits(u"\\d+"_s);
    double parts[3] = {0, 0, 0};
    int i = 0;
    for (auto it = digits.globalMatch(version); it.hasNext() && i < 3; ++i) parts[i] = util::jsStringToNumber(it.next().captured(0));
    return parts[0] * 1'000'000 + parts[1] * 1'000 + parts[2];
}

// ---- 哪些 (端点, 模型, schema) 拒过 json_schema:整个进程共用一份(见 TS 的 SCHEMA_REJECTED)
QSet<QString>& schemaRejected() {
    static QSet<QString> s;
    return s;
}

QString schemaKey(const QString& baseUrl, const QString& model, const OJson& schema) {
    const QByteArray hash = QCryptographicHash::hash(util::toNodeUtf8(js::stringify(schema)), QCryptographicHash::Sha256).toHex();
    return baseUrl + u'\n' + model + u'\n' + QString::fromLatin1(hash);
}

/// 看错误文字之前先把端点的地址拿掉(地址里的数字不是端点说的话)
QString withoutAddress(const QString& text, const QString& baseUrl) {
    if (baseUrl.isEmpty()) return text;
    QString host;
    if (const auto u = util::whatwg::parse(baseUrl); u && !u->hostname.isEmpty()) host = u->host();
    QString out = text;
    out.replace(baseUrl, QString());
    if (!host.isEmpty()) out.replace(host, QString());
    return out;
}

bool rejectsJsonSchema(const LLMError& exc, const QString& baseUrl) {
    if (exc.status) return *exc.status == 400;
    const QString msg = withoutAddress(exc.message(), baseUrl);
    return msg.contains(u"400"_s) || msg.contains(u"response_format"_s);
}

/// SDK 抛出来的任何东西 → LLMError:有状态码带上("HTTP {code}:{正文}"),没有就是连不上
LLMError asLLMError(const std::exception_ptr& e, const QString& baseUrl) {
    try {
        std::rethrow_exception(e);
    } catch (const LLMError& exc) {
        return exc;
    } catch (const SdkError& exc) {
        if (exc.status) {
            const QString detail = exc.error && js::truthy(&*exc.error) ? js::stringify(*exc.error) : exc.message();
            return LLMError(u"HTTP "_s + QString::number(*exc.status) + u':' + detail.left(400), exc.status);
        }
        return LLMError(u"无法连接 "_s + baseUrl + u':' + exc.message());
    } catch (const util::JsError& exc) {
        return LLMError(u"无法连接 "_s + baseUrl + u':' + exc.message());
    } catch (const std::exception& exc) {
        return LLMError(u"无法连接 "_s + baseUrl + u':' + QString::fromUtf8(exc.what()));
    }
}

sdk::Headers customHeaders(const char* env) {
    sdk::Headers h;
    if (const auto v = sdk::readEnv(env))
        for (const auto& [k, val] : sdk::parseCustomHeaders(*v)) h.set(k, val);
    return h;
}

OJson numberJson(const QJsonValue& v) { return OJson::fromQJson(v); }

}  // namespace

// ================================================================ 目录
const OJson& providersTable() {
    static const OJson table = js::object({
        {u"anthropic"_s, js::object({
                             {u"label"_s, js::S(u"Anthropic(Claude)"_s)},
                             {u"default_model"_s, js::S(u"claude-opus-5"_s)},
                             {u"models"_s, js::strings({u"claude-opus-5"_s, u"claude-sonnet-5"_s, u"claude-haiku-4-5"_s})},
                             {u"supports_effort"_s, js::B(true)},
                             {u"supports_temperature"_s, js::B(false)},  // Opus 5 / Sonnet 5 起已移除采样参数
                             {u"needs_base_url"_s, js::B(false)},
                             {u"default_base_url"_s, js::S(QString())},
                             {u"key_hint"_s, js::S(u"sk-ant-..."_s)},
                             {u"docs"_s, js::S(u"https://platform.claude.com/"_s)},
                         })},
        {u"openai_compatible"_s, js::object({
                                     {u"label"_s, js::S(u"OpenAI 兼容端点"_s)},
                                     {u"default_model"_s, js::S(QString())},
                                     {u"models"_s, js::strings({u"deepseek-chat"_s, u"deepseek-reasoner"_s, u"qwen-max"_s, u"moonshot-v1-128k"_s, u"glm-4-plus"_s, u"gpt-4o"_s})},
                                     {u"supports_effort"_s, js::B(false)},
                                     {u"supports_temperature"_s, js::B(true)},
                                     {u"needs_base_url"_s, js::B(true)},
                                     {u"default_base_url"_s, js::S(u"https://api.deepseek.com/v1"_s)},
                                     {u"key_hint"_s, js::S(u"sk-..."_s)},
                                     {u"docs"_s, js::S(u"填你的服务商给的 base_url,通常以 /v1 结尾"_s)},
                                 })},
    });
    return table;
}

OJson providerCatalog() {
    OJson out = js::array();
    for (const auto& [key, meta] : providersTable().fields) {
        OJson row = js::object({{u"key"_s, js::S(key)}});
        for (const auto& [k, v] : meta.fields) row.set(k, v);
        out.items.append(row);
    }
    return out;
}

OJson LLMResponse::payload() const { return parseModelJson(text); }

util::Task<QString> resolveApiKey(contract::LLMConfig config, std::optional<QString> explicitKey) {
    if (explicitKey && !explicitKey->isEmpty()) co_return *explicitKey;
    const std::optional<QString> key = co_await util::readSecret(config.keychain_service, config.keychain_account);
    if (!key || key->isEmpty()) {
        throw LLMError(u"Keychain 里没有 "_s + config.provider + u" 的 API Key"_s + u"(service="_s + config.keychain_service + u", account="_s +
                       config.keychain_account + u")。"_s + u"请在界面「大模型」面板里填写并保存。"_s);
    }
    co_return *key;
}

// ================================================================ schema 资产
namespace {
QString& assetDirRef() {
    static QString dir;
    return dir;
}
QHash<QString, OJson>& schemaCache() {
    static QHash<QString, OJson> c;
    return c;
}
}  // namespace

QString schemaAssetDir() {
    QString& dir = assetDirRef();
    if (!dir.isEmpty()) return dir;
    // TS 从模块所在目录往上找 baseline/llm;这边从可执行文件往上找(仓库里的编译目录、打包后的资源目录)
    QString d = QCoreApplication::instance() ? QCoreApplication::applicationDirPath() : QDir::currentPath();
    for (int i = 0; i < 6; ++i) {
        for (const QString& c : {d + u"/baseline/llm"_s, d + u"/engine-ts/baseline/llm"_s})
            if (QFileInfo::exists(c)) return dir = c;
        d = QFileInfo(d).absolutePath();
    }
    return dir = QDir::cleanPath(QDir::currentPath() + u"/../baseline/llm"_s);
}

void setSchemaAssetDir(const QString& d) {
    assetDirRef() = d;
    schemaCache().clear();
}

OJson loadSchemaAsset(const QString& name) {
    auto& cache = schemaCache();
    if (const auto it = cache.constFind(name); it != cache.constEnd()) return *it;
    const QString path = QDir::cleanPath(schemaAssetDir() + u'/' + name + u"_schema.json"_s);
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) throw util::CodedError(u"ENOENT: no such file or directory, open '"_s + path + u"'"_s, u"ENOENT"_s);
    OJson parsed;
    try {
        parsed = js::parseOrThrow(util::nodeUtf8(f.readAll()));
    } catch (const util::JsError& e) {
        throw NamedError(u"SyntaxError"_s, e.message());
    }
    cache.insert(name, parsed);
    return parsed;
}

OJson structuredOutputSchema(const QString& name) { return loadSchemaAsset(name); }

OJson parseSchemaForPrompt(const QString& promptVersion) {
    OJson schema = structuredOutputSchema();
    if (versionKey(promptVersion) >= versionKey(u"v1.8.0"_s)) {
        OJson* code = js::propMut(js::propMut(js::propMut(js::propMut(&schema, u"$defs"_s), u"Rejection"_s), u"properties"_s), u"code"_s);
        OJson* en = js::propMut(code, u"enum"_s);
        if (en && en->type == OJson::Array) {
            QList<OJson> kept;
            for (const OJson& c : en->items)
                if (!(c.type == OJson::String && c.s == u"EXCEEDS_LIMIT")) kept.append(c);
            en->items = kept;
        }
    }
    return schema;
}

bool supportsSamplingParams(const QString& model) {
    static const QStringList noSampling{u"claude-opus-5"_s, u"claude-opus-4-8"_s, u"claude-opus-4-7"_s, u"claude-sonnet-5"_s, u"claude-fable-5"_s, u"claude-mythos-5"_s};
    for (const QString& p : noSampling)
        if (model.startsWith(p)) return false;
    return true;
}

QString stripCodeFence(const QString& text) {
    const QString stripped = util::jsTrim(text);
    if (!stripped.startsWith(u"```"_s)) return stripped;
    const qsizetype nl = stripped.indexOf(u'\n');
    QString body = nl >= 0 ? stripped.mid(nl + 1) : stripped;
    if (jsTrimEnd(body).endsWith(u"```"_s)) body = jsTrimEnd(body).chopped(3);
    return util::jsTrim(body);
}

const OJson& pingSchema() {
    static const OJson s = js::object({
        {u"type"_s, js::S(u"object"_s)},
        {u"properties"_s, js::object({{u"ok"_s, js::object({{u"type"_s, js::S(u"boolean"_s)}})}})},
        {u"required"_s, js::strings({u"ok"_s})},
        {u"additionalProperties"_s, js::B(false)},
    });
    return s;
}

// ================================================================ 错误给人看的话
ErrorView errorView(const std::exception_ptr& e) {
    try {
        std::rethrow_exception(e);
    } catch (const SdkError& x) {
        return {x.name, x.message(), x.status ? std::optional<double>(*x.status) : std::nullopt};
    } catch (const NamedError& x) {
        return {x.name, x.message(), std::nullopt};
    } catch (const LLMError& x) {
        return {u"LLMError"_s, x.message(), x.status ? std::optional<double>(*x.status) : std::nullopt};
    } catch (const util::KeychainTimeoutError& x) {
        return {u"KeychainTimeoutError"_s, x.message(), std::nullopt};
    } catch (const util::KeychainError& x) {
        return {u"KeychainError"_s, x.message(), std::nullopt};
    } catch (const util::JsError& x) {
        return {u"Error"_s, x.message(), std::nullopt};
    } catch (const std::exception& x) {
        return {u"Error"_s, QString::fromUtf8(x.what()), std::nullopt};
    }
}

QString friendlyApiError(const ErrorView& exc, const QString& baseUrl) {
    const QString full = exc.message;
    const QString text = withoutAddress(full, baseUrl);
    const QString& name = exc.name;
    if (exc.status) {
        const double status = *exc.status;
        if (status == 401 || status == 403) return u"API Key 无效或已失效(401)。请在「大模型」面板里重新填写。"_s;
        if (status == 404) return u"模型名不存在(404):请核对模型标识。"_s;
        if (status == 429) return u"触发限流(429),稍后再试。"_s;
        if (status >= 500) return u"端点服务异常("_s + util::jsNumberToString(status) + u"),重试两次仍失败,稍后再试。"_s;
    }
    if (text.toLower().contains(u"authentication"_s) || text.contains(u"401"_s) || name == u"AuthenticationError") {
        return u"API Key 无效或已失效(401)。请在「大模型」面板里重新填写。"_s;
    }
    if (text.toLower().contains(u"not_found"_s) || text.contains(u"404"_s)) return u"模型名不存在(404):请核对模型标识。"_s;
    if (text.toLower().contains(u"rate_limit"_s) || text.contains(u"429"_s)) return u"触发限流(429),稍后再试。"_s;
    if (text.toLower().contains(u"connection"_s) || name == u"APIConnectionError") return u"网络不通:检查出网白名单与代理设置。"_s;
    return name + u": "_s + full;
}

// ================================================================ 少样本
OJson fewshotMessages(const prompts::PromptBundle& bundle, bool cacheLast) {
    OJson messages = js::array();
    const qsizetype n = qsizetype(bundle.fewshot.size());
    for (qsizetype idx = 0; idx < n; ++idx) {
        const prompts::FewShotPair& pair = bundle.fewshot[size_t(idx)];
        messages.items.append(js::object({{u"role"_s, js::S(u"user"_s)}, {u"content"_s, js::S(pair.user)}}));
        OJson content = js::object({{u"type"_s, js::S(u"text"_s)}, {u"text"_s, js::S(util::pyDumps(pair.assistantJ))}});
        if (cacheLast && idx == n - 1) content.set(u"cache_control"_s, js::object({{u"type"_s, js::S(u"ephemeral"_s)}}));
        messages.items.append(js::object({{u"role"_s, js::S(u"assistant"_s)}, {u"content"_s, js::array({content})}}));
    }
    return messages;
}

// ================================================================ Anthropic
AnthropicParser::AnthropicParser(contract::LLMConfig config, std::optional<QString> apiKey) : config_(std::move(config)), apiKey_(std::move(apiKey)) {}

util::Task<std::shared_ptr<sdk::Client>> AnthropicParser::ensureClient() {
    const auto keep = weak_from_this().lock();
    if (!client_) {
        sdk::ClientOptions o;
        o.flavor = sdk::Flavor::Anthropic;
        o.apiKey = co_await resolveApiKey(config_, apiKey_);
        o.timeoutMs = config_.timeout_s * 1000;
        o.maxRetries = 2;
        // 下面这几样是 SDK 构造函数自己读的环境变量
        o.baseURL = sdk::readEnv("ANTHROPIC_BASE_URL").value_or(u"https://api.anthropic.com"_s);
        o.authToken = sdk::readEnv("ANTHROPIC_AUTH_TOKEN");
        o.defaultHeaders = customHeaders("ANTHROPIC_CUSTOM_HEADERS");
        client_ = std::make_shared<sdk::Client>(std::move(o));
    }
    co_return client_;
}

OJson AnthropicParser::requestKwargs(const QString& system, const OJson& messages, const OJson& schema) const {
    OJson kwargs = js::object({
        {u"model"_s, js::S(config_.model)},
        {u"max_tokens"_s, js::N(config_.max_tokens)},
        {u"system"_s, js::array({js::object({{u"type"_s, js::S(u"text"_s)}, {u"text"_s, js::S(system)}, {u"cache_control"_s, js::object({{u"type"_s, js::S(u"ephemeral"_s)}})}})})},
        {u"messages"_s, messages},
        {u"output_config"_s, js::object({{u"format"_s, js::object({{u"type"_s, js::S(u"json_schema"_s)}, {u"schema"_s, schema}})}, {u"effort"_s, js::S(config_.effort)}})},
    });
    if (!config_.temperature.isNull() && supportsSamplingParams(config_.model)) kwargs.set(u"temperature"_s, numberJson(config_.temperature));
    return kwargs;
}

util::Task<LLMResponse> AnthropicParser::parse(prompts::PromptBundle bundle, QString userMessage) {
    const auto keep = weak_from_this().lock();
    const std::shared_ptr<sdk::Client> client = co_await ensureClient();
    OJson messages = fewshotMessages(bundle, true);
    messages.items.append(js::object({{u"role"_s, js::S(u"user"_s)}, {u"content"_s, js::S(userMessage)}}));

    QElapsedTimer started;
    started.start();
    sdk::Body response;
    try {
        response = co_await client->post(u"/v1/messages"_s, requestKwargs(bundle.system_text, messages, parseSchemaForPrompt(bundle.version)), config_.timeout_s * 1000);
    } catch (...) {
        const std::exception_ptr e = std::current_exception();
        throw LLMError(u"调用 Anthropic 失败:"_s + errorName(e) + u": "_s + errorMessage(e));
    }
    const double latencyMs = elapsedMs(started);

    const OJson* r = response ? &*response : nullptr;
    const OJson* stopReason = js::prop(r, u"stop_reason"_s);
    if (js::isStr(stopReason) && stopReason->s == u"refusal") throw LLMError(u"模型以安全策略拒绝了本次解析,已中止,不会下单。"_s);
    if (js::isStr(stopReason) && stopReason->s == u"max_tokens") throw LLMError(u"模型输出被 max_tokens 截断,JSON 不完整,已中止。请提高 max_tokens。"_s);

    const QString text = joinTextBlocks(r);
    if (util::jsTrim(text).isEmpty()) throw LLMError(u"模型返回空内容。"_s);

    LLMResponse out;
    out.text = text;
    out.model = modelOr(r, config_.model);
    out.prompt_version = bundle.version;
    out.prompt_fingerprint = prompts::fingerprint(bundle);
    out.latency_ms = latencyMs;
    out.usage = anthropicUsage(js::prop(r, u"usage"_s));
    co_return out;
}

util::Task<OJson> AnthropicParser::completeJson(QString system, QString user, OJson schema) {
    const auto keep = weak_from_this().lock();
    const std::shared_ptr<sdk::Client> client = co_await ensureClient();
    sdk::Body response;
    try {
        response = co_await client->post(u"/v1/messages"_s,
                                         js::object({
                                             {u"model"_s, js::S(config_.model)},
                                             {u"max_tokens"_s, js::N(config_.max_tokens)},
                                             {u"system"_s, js::S(system)},
                                             {u"messages"_s, js::array({js::object({{u"role"_s, js::S(u"user"_s)}, {u"content"_s, js::S(user)}})})},
                                             {u"output_config"_s, js::object({{u"format"_s, js::object({{u"type"_s, js::S(u"json_schema"_s)}, {u"schema"_s, schema}})}, {u"effort"_s, js::S(config_.effort)}})},
                                         }),
                                         config_.timeout_s * 1000);
    } catch (...) {
        throw LLMError(friendlyApiError(errorView(std::current_exception())));
    }
    const OJson* r = response ? &*response : nullptr;
    const OJson* stopReason = js::prop(r, u"stop_reason"_s);
    if (js::isStr(stopReason) && stopReason->s == u"max_tokens") throw LLMError(u"模型输出被 max_tokens 截断,已中止。请提高 max_tokens。"_s);
    co_return parseModelJson(joinTextBlocks(r));
}

util::Task<TestProbe> AnthropicParser::test(std::optional<QString> apiKey) {
    const auto keep = weak_from_this().lock();
    contract::LLMConfig probeConfig = config_;
    probeConfig.max_tokens = 1024;
    const auto probe = std::make_shared<AnthropicParser>(probeConfig, apiKey ? apiKey : apiKey_);
    const std::shared_ptr<sdk::Client> client = co_await probe->ensureClient();
    QElapsedTimer started;
    started.start();
    sdk::Body response;
    try {
        response = co_await client->post(u"/v1/messages"_s,
                                         js::object({
                                             {u"model"_s, js::S(probe->config_.model)},
                                             {u"max_tokens"_s, js::N(1024)},
                                             {u"messages"_s, js::array({js::object({{u"role"_s, js::S(u"user"_s)}, {u"content"_s, js::S(u"回复 JSON:{\"ok\": true}"_s)}})})},
                                             {u"output_config"_s, js::object({{u"format"_s, js::object({{u"type"_s, js::S(u"json_schema"_s)}, {u"schema"_s, pingSchema()}})}})},
                                         }),
                                         probe->config_.timeout_s * 1000);
    } catch (...) {
        throw LLMError(friendlyApiError(errorView(std::current_exception())));
    }
    const double latencyMs = elapsedMs(started);
    const OJson* r = response ? &*response : nullptr;
    const QString text = joinTextBlocks(r);
    TestProbe out;
    out.ok = true;
    out.model = modelOr(r, probe->config_.model);
    out.latency_ms = latencyMs;
    out.structured_mode = u"json_schema"_s;
    out.usage = anthropicUsage(js::prop(r, u"usage"_s));
    out.sample = text.left(200);
    co_return out;
}

// ================================================================ OpenAI 兼容
OpenAICompatibleParser::OpenAICompatibleParser(contract::LLMConfig config, std::optional<QString> apiKey)
    : config_(std::move(config)), apiKey_(std::move(apiKey)), baseUrl_(validateBaseUrl(config_.base_url)) {}

util::Task<std::shared_ptr<sdk::Client>> OpenAICompatibleParser::ensureClient() {
    const auto keep = weak_from_this().lock();
    if (!client_) {
        sdk::ClientOptions o;
        o.flavor = sdk::Flavor::OpenAI;
        o.apiKey = co_await resolveApiKey(config_, apiKey_);
        o.baseURL = baseUrl_;
        o.timeoutMs = config_.timeout_s * 1000;
        // 4xx(含降级要认的 400)不重试,只重试 408 / 409 / 429 / 5xx 与连接中断
        o.maxRetries = 2;
        o.organization = sdk::readEnv("OPENAI_ORG_ID");
        o.project = sdk::readEnv("OPENAI_PROJECT_ID");
        o.defaultHeaders = customHeaders("OPENAI_CUSTOM_HEADERS");
        o.defaultHeaders.set(u"User-Agent"_s, u"dafri-trading/0.2"_s);
        // SDK 构造函数里 buildHeaders([自定义头, 默认头]) 当场校验:坏名字 / 坏值是一句没包过的 TypeError(不进 LLMError 的包装)
        sdk::validateHeaderAttempts(sdk::Flavor::OpenAI, o.defaultHeaders);
        client_ = std::make_shared<sdk::Client>(std::move(o));
    }
    co_return client_;
}

util::Task<sdk::Body> OpenAICompatibleParser::post(QString pathName, OJson body) {
    const auto keep = weak_from_this().lock();
    const std::shared_ptr<sdk::Client> client = co_await ensureClient();
    try {
        co_return co_await client->post(pathName, body);
    } catch (...) {
        throw asLLMError(std::current_exception(), baseUrl_);
    }
}

util::Task<std::pair<sdk::Body, QString>> OpenAICompatibleParser::complete(OJson messages, OJson schema, bool fresh) {
    const auto keep = weak_from_this().lock();
    const OJson temperature = config_.temperature.isNull() ? js::N(0) : numberJson(config_.temperature);
    const OJson body = js::object({
        {u"model"_s, js::S(config_.model)},
        {u"messages"_s, messages},
        {u"max_tokens"_s, js::N(config_.max_tokens)},
        {u"temperature"_s, temperature},
        {u"response_format"_s, js::object({{u"type"_s, js::S(u"json_schema"_s)},
                                           {u"json_schema"_s, js::object({{u"name"_s, js::S(u"parse_result"_s)}, {u"strict"_s, js::B(true)}, {u"schema"_s, schema}})}})},
    });
    const QString key = schemaKey(baseUrl_, config_.model, schema);
    if (fresh || !schemaRejected().contains(key)) {
        bool rejected = false;
        sdk::Body data;
        try {
            data = co_await post(u"/chat/completions"_s, body);
        } catch (const LLMError& exc) {
            if (!rejectsJsonSchema(exc, baseUrl_)) throw;
            rejected = true;  // 端点不认 json_schema:这一进程里这份 schema 不再试
        }
        if (!rejected) {
            schemaRejected().remove(key);
            co_return std::pair<sdk::Body, QString>{data, u"json_schema"_s};
        }
        schemaRejected().insert(key);
    }
    OJson fallback = messages;
    const OJson* first = js::prop(&fallback, u"0"_s);
    const QString content = js::str(js::prop(first, u"content"_s)) + u"\n\n# 输出必须严格符合以下 JSON Schema\n"_s + js::stringify(schema);
    const OJson sys = js::object({{u"role"_s, js::S(u"system"_s)}, {u"content"_s, js::S(content)}});
    if (fallback.items.isEmpty()) fallback.items.append(sys);
    else fallback.items[0] = sys;
    const OJson body2 = js::object({
        {u"model"_s, js::S(config_.model)},
        {u"messages"_s, fallback},
        {u"max_tokens"_s, js::N(config_.max_tokens)},
        {u"temperature"_s, temperature},
        {u"response_format"_s, js::object({{u"type"_s, js::S(u"json_object"_s)}})},
    });
    sdk::Body data = co_await post(u"/chat/completions"_s, body2);
    co_return std::pair<sdk::Body, QString>{data, u"json_object"_s};
}

util::Task<LLMResponse> OpenAICompatibleParser::parse(prompts::PromptBundle bundle, QString userMessage) {
    const auto keep = weak_from_this().lock();
    const OJson schema = parseSchemaForPrompt(bundle.version);
    OJson messages = js::array({js::object({{u"role"_s, js::S(u"system"_s)}, {u"content"_s, js::S(bundle.system_text)}})});
    for (const prompts::FewShotPair& pair : bundle.fewshot) {
        messages.items.append(js::object({{u"role"_s, js::S(u"user"_s)}, {u"content"_s, js::S(pair.user)}}));
        // 少样本 assistant 走浮点感知序列化,与 Python json.dumps 的字节一致
        messages.items.append(js::object({{u"role"_s, js::S(u"assistant"_s)}, {u"content"_s, js::S(util::pyDumps(pair.assistantJ))}}));
    }
    messages.items.append(js::object({{u"role"_s, js::S(u"user"_s)}, {u"content"_s, js::S(userMessage)}}));

    QElapsedTimer started;
    started.start();
    const auto [body, mode] = co_await complete(messages, schema);
    const double latencyMs = elapsedMs(started);

    const OJson* data = dataOrThrow(body);
    const OJson choice = firstChoice(data);
    const OJson* finish = js::prop(&choice, u"finish_reason"_s);
    if (js::isStr(finish) && finish->s == u"length") throw LLMError(u"模型输出被 max_tokens 截断,JSON 不完整,已中止。请提高 max_tokens。"_s);
    if (js::isStr(finish) && finish->s == u"content_filter") throw LLMError(u"模型以内容策略拒绝了本次解析,已中止,不会下单。"_s);
    const QString text = util::jsTrim(choiceContent(choice));
    if (text.isEmpty()) throw LLMError(u"模型返回空内容。"_s);

    LLMResponse out;
    out.text = stripCodeFence(text);
    out.model = modelOr(data, config_.model);
    out.prompt_version = bundle.version;
    out.prompt_fingerprint = prompts::fingerprint(bundle);
    out.latency_ms = latencyMs;
    out.usage = openaiUsage(js::prop(data, u"usage"_s));
    out.structured_mode = mode;
    co_return out;
}

util::Task<OJson> OpenAICompatibleParser::completeJson(QString system, QString user, OJson schema) {
    const auto keep = weak_from_this().lock();
    const OJson messages = js::array({
        js::object({{u"role"_s, js::S(u"system"_s)}, {u"content"_s, js::S(system)}}),
        js::object({{u"role"_s, js::S(u"user"_s)}, {u"content"_s, js::S(user)}}),
    });
    const auto [body, mode] = co_await complete(messages, schema);
    Q_UNUSED(mode);
    const OJson* data = dataOrThrow(body);
    const OJson choice = firstChoice(data);
    const OJson* finish = js::prop(&choice, u"finish_reason"_s);
    if (js::isStr(finish) && finish->s == u"length") throw LLMError(u"模型输出被 max_tokens 截断,已中止。请提高 max_tokens。"_s);
    const QString text = stripCodeFence(util::jsTrim(choiceContent(choice)));
    if (text.isEmpty()) throw LLMError(u"模型返回空内容。"_s);
    co_return parseModelJson(text);
}

util::Task<TestProbe> OpenAICompatibleParser::test(std::optional<QString> apiKey) {
    const auto keep = weak_from_this().lock();
    const auto probe = std::make_shared<OpenAICompatibleParser>(config_, apiKey ? apiKey : apiKey_);
    const OJson messages = js::array({
        js::object({{u"role"_s, js::S(u"system"_s)}, {u"content"_s, js::S(u"你只输出 JSON。"_s)}}),
        js::object({{u"role"_s, js::S(u"user"_s)}, {u"content"_s, js::S(u"回复 {\"ok\": true}"_s)}}),
    });
    QElapsedTimer started;
    started.start();
    std::pair<sdk::Body, QString> result;
    try {
        result = co_await probe->complete(messages, pingSchema(), true);
    } catch (...) {
        // 「测试连接」是给人看的:401 / 404 / 429 说人话,别把端点的原始报文甩到界面上
        const std::exception_ptr e = std::current_exception();
        const ErrorView view = errorView(e);
        std::optional<int> status;
        try {
            std::rethrow_exception(e);
        } catch (const LLMError& x) {
            status = x.status;
        } catch (...) {
        }
        throw LLMError(friendlyApiError(view, baseUrl_), status);
    }
    const double latencyMs = elapsedMs(started);
    const OJson* data = dataOrThrow(result.first);
    const OJson choice = firstChoice(data);
    TestProbe out;
    out.ok = true;
    out.model = modelOr(data, config_.model);
    out.latency_ms = latencyMs;
    out.structured_mode = result.second;
    out.usage = openaiUsage(js::prop(data, u"usage"_s));
    out.sample = choiceContent(choice).left(200);
    co_return out;
}

// ================================================================ 装配
std::shared_ptr<Parser> buildParser(const contract::LLMConfig& config, std::optional<QString> apiKey) {
    if (config.provider == u"anthropic") return std::make_shared<AnthropicParser>(config, apiKey);
    if (config.provider == u"openai_compatible") return std::make_shared<OpenAICompatibleParser>(config, apiKey);
    QStringList keys;
    for (const auto& [k, v] : providersTable().fields) keys << k;
    throw LLMError(u"未知的模型供应商:"_s + config.provider + u"(可选:"_s + keys.join(u"、"_s) + u")"_s);
}

namespace {

class GuardedParser : public Parser {
public:
    GuardedParser(std::shared_ptr<Parser> inner, std::function<std::vector<AccountRef>()> accounts) : inner_(std::move(inner)), accounts_(std::move(accounts)) {}
    QString provider() const override { return inner_->provider(); }
    const contract::LLMConfig& config() const override { return inner_->config(); }

    util::Task<LLMResponse> parse(prompts::PromptBundle bundle, QString userMessage) override {
        const auto inner = inner_;
        check({bundle.system_text, userMessage});
        co_return co_await inner->parse(std::move(bundle), std::move(userMessage));
    }
    util::Task<OJson> completeJson(QString system, QString user, OJson schema) override {
        const auto inner = inner_;
        check({system, user});
        co_return co_await inner->completeJson(std::move(system), std::move(user), std::move(schema));
    }
    util::Task<TestProbe> test(std::optional<QString> apiKey) override { return inner_->test(std::move(apiKey)); }

private:
    void check(const QStringList& texts) const {
        static const QRegularExpression placeholder(u"^[A-Za-z]*0+\\z"_s);
        for (const AccountRef& acct : accounts_()) {
            const QString& id = acct.account_id;
            if (id.size() < 4 || placeholder.match(id).hasMatch()) continue;
            for (const QString& t : texts) {
                if (t.contains(id))
                    throw LLMError(u"要发给大模型的内容里出现了真实账号(别名 "_s + acct.alias + u"),为保护隐私没有发出。请把账号从文字里删掉后再试。"_s);
            }
        }
    }
    std::shared_ptr<Parser> inner_;
    std::function<std::vector<AccountRef>()> accounts_;
};

}  // namespace

std::shared_ptr<Parser> guardAccountIds(std::shared_ptr<Parser> parser, std::function<std::vector<AccountRef>()> accounts) {
    return std::make_shared<GuardedParser>(std::move(parser), std::move(accounts));
}

}  // namespace ibkr::parsing::providers
