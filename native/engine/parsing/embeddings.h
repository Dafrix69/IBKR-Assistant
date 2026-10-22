// embeddings.ts:本机文本嵌入(想法检索的语义补充)。调本机 Ollama 的 /api/embed,只许本机地址——想法原文里可能有仓位、金额,
// 嵌入是一次外发,所以地址不是 127.0.0.1 / localhost / ::1 就当场拒。期望值:tests/fixtures/gen_llm.mjs(e_* 场景与纯函数)。
// HTTP 是 fetch 的样子(不是 SDK):一个时限管到正文读完;连不上 / 到点在等头时是「连不上…」,读正文时出的事一律当"回包不对"
// (TS 的 res.json().catch(() => null),于是正文读到一半超时报的是 HTTP 200——TS 原样)。
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"
#include "util/task.h"

#include <QString>

#include <vector>

namespace ibkr::parsing::embeddings {

/// 默认模型(可用 DAFRI_EMBED_MODEL 换,换的地方在 services 里)
inline const QString kDefaultEmbedModel = QStringLiteral("qwen3-embedding:8b-q8_0");
inline const QString kDefaultEmbedUrl = QStringLiteral("http://127.0.0.1:11434");
/// 查询要带的指令前缀(文档原样嵌入,查询前面加任务说明);改它 = 换一套相似度
inline const QString kQueryInstruction = QStringLiteral(
    "Instruct: Given a trading journal search query, retrieve notes that discuss the same trading mistake or idea\nQuery: ");

class EmbedError : public util::JsError {
public:
    using util::JsError::JsError;
};

/// 只认本机回环地址(http / https,hostname 是 127.0.0.1 / localhost / ::1)
bool isLoopbackUrl(const QString& raw);

class OllamaEmbedder {
public:
    /// keepAlive:Ollama 的 keep_alive(字符串如 "5m",或数 -1 = 常驻);地址不是本机抛 EmbedError
    OllamaEmbedder(QString baseUrl, QString model, util::OJson keepAlive = util::OJson::string(QStringLiteral("5m")));
    const QString& model() const { return model_; }
    /// 一批文本 → 一批向量(回包里的原样:每条是非空数组,元素不验是不是数——TS 原样);失败抛 EmbedError
    util::Task<std::vector<util::OJson>> embed(std::vector<QString> texts, double timeoutMs = 20'000) const;

private:
    QString baseUrl_;
    QString model_;
    util::OJson keepAlive_;
};

/// 余弦相似度;长度不一致或有零向量(NaN 也算假)时 0
double cosine(const std::vector<double>& a, const std::vector<double>& b);
/// 回包里的一条向量 → 数(cosine 里的 `a[i] ?? 0` 与乘法的取数:null 是 0,别的按 Number())
std::vector<double> toNumbers(const util::OJson& vector);

}  // namespace ibkr::parsing::embeddings
