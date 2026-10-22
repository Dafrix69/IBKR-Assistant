#!/usr/bin/env python3
"""llm 这一簇(parsing/sdk_http、providers、embeddings、whatwg_url)的变异检验。

只在私有副本里跑(qt-port-brief 第 3 条):先
  rsync -a --delete --exclude .vscode native/ /Users/dafrix/Developer/ibkr/work/mut-llm/native/
  (旁边放 desktop、engine-ts、docs、prompts 的符号链接,在 work/mut-llm/build 里 configure)
再跑副本里的这份脚本:python3 /Users/dafrix/Developer/ibkr/work/mut-llm/native/tools/mutate_llm.py。
脚本改的是它自己所在的那份 native/;在项目里直接跑会当场拒。

每个变异是一处小改动(条件、边界、运算符、常量):写进去 → 重编 tst_llm → 跑 → 记 caught / survived;
finally 里还原、把文件时间往后拨几秒(ninja 按秒比时间戳)、重编。最后再重编一遍,保证留下的二进制是原样代码编的。
被杀在半路时,下次启动先按日志把原文写回去。

  python3 native/tools/mutate_llm.py                 # 全部
  ONLY='子串|子串' python3 native/tools/mutate_llm.py  # 只跑 old 里含这些子串的
  DRY=1 python3 native/tools/mutate_llm.py           # 只查每个原文是不是恰好出现一次
  BUILD=/Users/dafrix/Developer/ibkr/work/mut-llm/build OUT=结果.json
  RERUN=上次的结果.json OUT=复查.json python3 native/tools/mutate_llm.py   # 只复查上次活下来的
"""
import json
import os
import subprocess
import sys
import time
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.dirname(ROOT)  # work/mut-llm(副本的根;native/ 的上一层)
B = os.environ.get("BUILD", os.path.join(WORK, "build"))
OUT = os.environ.get("OUT", os.path.join(WORK, "mutate_llm.json"))
E = os.path.join(ROOT, "engine", "parsing") + "/"
TEST = "tst_llm"
H, P, M_, W = "sdk_http.cpp", "providers.cpp", "embeddings.cpp", "../util/whatwg_url.cpp"  # whatwg_url 在 engine/util 里

# (文件, 原文, 改成) —— 原文在文件里必须恰好出现一次
M = [
    # ---- sdk_http.cpp:Node 的计时器、头
    (H, "if (!(ms >= 1 && ms <= 2147483647.0)) return 1;", "if (!(ms > 1 && ms <= 2147483647.0)) return 1;"),
    (H, "    return int(std::floor(ms));", "    return int(std::ceil(ms));"),
    (H, "            v = value;\n            return;", "            return;"),
    (H, "    if (s.startsWith(QChar(0xFEFF))) s.remove(0, 1);", "    (void)s;"),
    (H, "        if (k.toLower() == key) values << QString::fromLatin1(v);", "        if (k == key) values << QString::fromLatin1(v);"),
    (H, "    return values.join(u\", \"_s);", "    return values.join(u\",\"_s);"),
    # ---- 套接字上的 HTTP/1.1
    (H, "    if (framing_ == Framing::UntilClose) settleBody(Fail::None);\n    else failWith(Fail::Truncated);", "    settleBody(Fail::None);"),
    (H, "    if (socket_->error() == QAbstractSocket::RemoteHostClosedError) return;", "    if (false) return;"),
    (H, "    failWith(headersDone_ ? Fail::Truncated : Fail::Network);", "    failWith(Fail::Network);"),
    (H, "        if (framing_ == Framing::None || (framing_ == Framing::Length && remaining_ <= 0)) {", "        if (framing_ == Framing::None || (framing_ == Framing::Length && remaining_ < 0)) {"),
    (H, "        if (remaining_ <= 0) settleBody(Fail::None);", "        if (remaining_ < 0) settleBody(Fail::None);"),
    (H, "                if (size == 0) {", "                if (size == 1) {"),
    (H, "            remaining_ = -2;\n        }", "            remaining_ = -1;\n        }"),
    # ---- 错误
    (H, "    case 401: return u\"AuthenticationError\"_s;", "    case 401: return u\"APIError\"_s;"),
    (H, "    case 422: return u\"UnprocessableEntityError\"_s;", "    case 422: return u\"APIError\"_s;"),
    (H, "    return status >= 500 ? u\"InternalServerError\"_s : u\"APIError\"_s;", "    return status > 500 ? u\"InternalServerError\"_s : u\"APIError\"_s;"),
    (H, "    if (js::truthy(m)) msg = m->type == OJson::String ? m->s : js::stringify(*m);", "    if (js::truthy(m)) msg = m->s;"),
    (H, "    else if (js::truthy(error)) msg = js::stringify(*error);", "    else if (false) msg = js::stringify(*error);"),
    (H, "    const bool hasMsg = msg && !msg->isEmpty();", "    const bool hasMsg = msg.has_value();"),
    (H, "    if (hasStatus) return QString::number(*status) + u\" status code (no body)\"_s;", "    if (false) return QString();"),
    (H, "    const std::optional<QString> errMessage = jsonTruthy ? std::nullopt : std::optional<QString>(errText);", "    const std::optional<QString> errMessage = errJSON ? std::nullopt : std::optional<QString>(errText);"),
    (H, "    if (flavor == Flavor::Anthropic) {\n        error = errJSON;", "    if (flavor != Flavor::Anthropic) {\n        error = errJSON;"),
    (H, "        if (jsonTruthy && js::isObjectLike(&*errJSON) && js::nullish(js::prop(&*errJSON, u\"error\"_s))) error = errJSON;", "        if (jsonTruthy && js::isObj(&*errJSON) && js::nullish(js::prop(&*errJSON, u\"error\"_s))) error = errJSON;"),
    # ---- 重试
    (H, "    if (h == u\"true\"_s) return true;", "    if (false) return true;"),
    (H, "    if (h == u\"false\"_s) return false;", "    if (false) return false;"),
    (H, "    return s == 408 || s == 409 || s == 429 || s >= 500;", "    return s == 408 || s == 429 || s >= 500;"),
    (H, "    return s == 408 || s == 409 || s == 429 || s >= 500;", "    return s == 409 || s == 429 || s >= 500;"),
    (H, "    return s == 408 || s == 409 || s == 429 || s >= 500;", "    return s == 408 || s == 409 || s == 429 || s > 500;"),
    (H, "        if (!std::isnan(v)) t = v;", "        if (!std::isnan(v)) t = v + 1;"),
    (H, "    const bool consider = anth ? (!t || *t == 0) : !t;", "    const bool consider = !t;"),
    (H, "    const bool consider = anth ? (!t || *t == 0) : !t;", "    const bool consider = !t || *t == 0;"),
    (H, "        if (!std::isnan(secs)) t = secs * 1000;", "        if (!std::isnan(secs)) t = secs * 100;"),
    (H, "    if (anth) useDefault = !t || !(*t > 0 && *t <= 2147483647.0);", "    if (anth) useDefault = !t || !(*t >= 0 && *t <= 2147483647.0);"),
    (H, "    else useDefault = !t || !std::isfinite(*t) || *t < 0 || *t > 60 * 1000;", "    else useDefault = !t || !std::isfinite(*t) || *t <= 0 || *t > 60 * 1000;"),
    (H, "    else useDefault = !t || !std::isfinite(*t) || *t < 0 || *t > 60 * 1000;", "    else useDefault = !t || !std::isfinite(*t) || *t < 0 || *t > 61 * 1000;"),
    (H, "    if (anth) useDefault = !t || !(*t > 0 && *t <= 2147483647.0);", "    if (anth) useDefault = !t || !(*t > 0 && *t < 2147483647.0);"),
    (H, "    if (anth) useDefault = !t || !(*t > 0 && *t <= 2147483647.0);", "    if (anth) useDefault = !t || !(*t > 0 && *t <= 2147483646.0);"),
    (H, "    else useDefault = !t || !std::isfinite(*t) || *t < 0 || *t > 60 * 1000;", "    else useDefault = !t || !std::isfinite(*t) || *t < 0 || *t >= 60 * 1000;"),
    (H, "        const double sleepSeconds = std::min(0.5 * util::jsmath::pow(2, numRetries), 8.0);", "        const double sleepSeconds = std::min(0.5 * util::jsmath::pow(2, numRetries + 1), 8.0);"),
    (H, "        const double jitter = 1 - random01() * 0.25;", "        const double jitter = 1 - random01() * 0.2;"),
    # ---- 请求的样子
    (H, "    const QString joined = baseURL + (baseURL.endsWith(u'/') && path.startsWith(u'/') ? path.mid(1) : path);", "    const QString joined = baseURL + path;"),
    (H, "        if (requestTimeoutMs && *requestTimeoutMs != 0 && !std::isnan(*requestTimeoutMs))", "        if (false)"),
    (H, "util::jsNumberToString(std::trunc(*requestTimeoutMs / 1000))", "util::jsNumberToString(std::round(*requestTimeoutMs / 1000))"),
    (H, "        if (o.authToken) h.set(u\"Authorization\"_s, u\"Bearer \"_s + *o.authToken);", "        (void)o.authToken;"),
    (H, "        if (o.organization) h.set(u\"OpenAI-Organization\"_s, *o.organization);", "        (void)o.organization;"),
    # ---- 成功回包
    (H, "    if (ex.status() == 204) return OJson::null();", "    if (false) return OJson::null();"),
    (H, "        if (flavor == Flavor::OpenAI) mediaType = mediaType->toLower();", "        mediaType = mediaType->toLower();"),
    (H, "    const bool isJSON = mediaType && (mediaType->contains(u\"application/json\"_s) || mediaType->endsWith(u\"+json\"_s));", "    const bool isJSON = mediaType && mediaType->contains(u\"application/json\"_s);"),
    (H, "        if (ex.header(u\"content-length\"_s) == u\"0\"_s) return std::nullopt;", "        if (false) return std::nullopt;"),
    (H, "        if (flavor == Flavor::OpenAI && text.isEmpty()) return std::nullopt;", "        if (text.isEmpty()) return std::nullopt;"),
    # ---- 一次 post 的全过程
    (H, "            if (!(std::isfinite(t) && std::trunc(t) == t)) throw", "            if (!(std::isfinite(t) && std::round(t) == t) && false) throw"),
    (H, "            if (t < 0) throw NamedError", "            if (t < -1) throw NamedError"),
    (H, "            if (retriesRemaining) {\n                co_await retrySleep(o->flavor, maxRetries, retriesRemaining, std::nullopt, std::nullopt);\n                --retriesRemaining;\n                continue;\n            }\n            if (head", "            if (false) {\n                co_await retrySleep(o->flavor, maxRetries, retriesRemaining, std::nullopt, std::nullopt);\n                --retriesRemaining;\n                continue;\n            }\n            if (head"),
    (H, "            if (head == Fail::Deadline || head == Fail::UndiciHeaders) {", "            if (head == Fail::Deadline) {"),
    (H, "                if (!anth && head == Fail::UndiciHeaders) throw", "                if (head == Fail::UndiciHeaders) throw"),
    (H, "            if (retriesRemaining && retry) {", "            if (retry) {"),
    (H, "            const QString errText = fail == Fail::None ? fetchText(bytes) : u\"terminated\"_s;", "            const QString errText = fetchText(bytes);"),
    (H, "        if (ex->status() == 204 || ex->header(u\"content-length\"_s) == u\"0\"_s) {", "        if (ex->status() == 204) {"),
    (H, "        const double remaining = std::max(0.0, startTime + timeout - double(QDateTime::currentMSecsSinceEpoch()));", "        const double remaining = timeout * 4;"),
    (H, "            if (!retriesRemaining) throw SdkError(u\"APIConnectionTimeoutError\"_s, u\"Request timed out.\"_s);", "            if (true) throw SdkError(u\"APIConnectionTimeoutError\"_s, u\"Request timed out.\"_s);"),
    (H, "        ex->stopDeadline();  // 两边", "        if (anth) ex->stopDeadline();  // 两边"),

    # ---- providers.cpp
    (P, "    if (content->type != OJson::Array) throw", "    if (false) throw"),
    (P, "        if (!(type && type->type == OJson::String && type->s == u\"text\")) continue;", "        if (!(type && type->type == OJson::String)) continue;"),
    (P, "        if (!js::nullish(text)) out += js::str(text);", "        out += js::str(text);"),
    (P, "    return js::nullish(m) ? OJson::string(fallback) : *m;", "    return js::truthy(m) ? *m : OJson::string(fallback);"),
    (P, "        if (!js::nullish(v)) out.set(key, *v);", "        if (v) out.set(key, *v);"),
    (P, "    if (!usage || usage->type != OJson::Object) return js::object();", "    if (!usage) return js::object();"),
    (P, "    if (data->type == OJson::Null) throw", "    if (false) throw"),
    (P, "    return js::nullish(c) ? js::object() : *c;", "    return js::truthy(c) ? *c : js::object();"),
    (P, "    return parts[0] * 1'000'000 + parts[1] * 1'000 + parts[2];", "    return parts[0] * 1'000'000 + parts[1] * 100 + parts[2];"),
    (P, "it.hasNext() && i < 3; ++i)", "it.hasNext() && i < 2; ++i)"),
    (P, "    if (!host.isEmpty()) out.replace(host, QString());", "    (void)host;"),
    (P, "    out.replace(baseUrl, QString());\n", "\n"),
    (P, "    if (exc.status) return *exc.status == 400;", "    if (exc.status) return *exc.status >= 400;"),
    (P, "    return msg.contains(u\"400\"_s) || msg.contains(u\"response_format\"_s);", "    return msg.contains(u\"400\"_s);"),
    (P, "            const QString detail = exc.error && js::truthy(&*exc.error) ? js::stringify(*exc.error) : exc.message();", "            const QString detail = exc.message();"),
    (P, "u':' + detail.left(400), exc.status);", "u':' + detail.left(399), exc.status);"),
    (P, "    if (explicitKey && !explicitKey->isEmpty()) co_return *explicitKey;", "    if (explicitKey) co_return *explicitKey;"),
    (P, "    if (!key || key->isEmpty()) {", "    if (!key) {"),
    (P, "    if (versionKey(promptVersion) >= versionKey(u\"v1.8.0\"_s)) {", "    if (versionKey(promptVersion) > versionKey(u\"v1.8.0\"_s)) {"),
    (P, "                if (!(c.type == OJson::String && c.s == u\"EXCEEDS_LIMIT\")) kept.append(c);", "                kept.append(c);"),
    (P, "u\"claude-opus-4-7\"_s, u\"claude-sonnet-5\"_s", "u\"claude-sonnet-5\"_s"),
    (P, "    if (!stripped.startsWith(u\"```\"_s)) return stripped;", "    if (!stripped.startsWith(u\"``\"_s)) return stripped;"),
    (P, "    QString body = nl >= 0 ? stripped.mid(nl + 1) : stripped;", "    QString body = nl > 0 ? stripped.mid(nl + 1) : stripped;"),
    (P, "    if (jsTrimEnd(body).endsWith(u\"```\"_s)) body = jsTrimEnd(body).chopped(3);", "    if (body.endsWith(u\"```\"_s)) body = body.chopped(3);"),
    (P, "    while (e > 0 && util::isJsWhitespace(s.at(e - 1))) --e;", "    while (e > 0 && s.at(e - 1) == u' ') --e;"),
    (P, "        if (status == 401 || status == 403) return", "        if (status == 401) return"),
    (P, "        if (status >= 500) return u\"端点服务异常(", "        if (status > 500) return u\"端点服务异常("),
    (P, "    if (text.toLower().contains(u\"authentication\"_s) || text.contains(u\"401\"_s) || name == u\"AuthenticationError\") {", "    if (text.contains(u\"authentication\"_s) || text.contains(u\"401\"_s) || name == u\"AuthenticationError\") {"),
    (P, "    if (text.toLower().contains(u\"not_found\"_s) || text.contains(u\"404\"_s)) return", "    if (text.contains(u\"404\"_s)) return"),
    (P, "    if (text.toLower().contains(u\"rate_limit\"_s) || text.contains(u\"429\"_s)) return", "    if (text.contains(u\"429\"_s)) return"),
    (P, "    if (text.toLower().contains(u\"connection\"_s) || name == u\"APIConnectionError\") return", "    if (name == u\"APIConnectionError\") return"),
    (P, "    return name + u\": \"_s + full;", "    return name + u\": \"_s + text;"),
    (P, "        if (cacheLast && idx == n - 1) content.set", "        if (cacheLast && idx == 0) content.set"),
    (P, "    if (!config_.temperature.isNull() && supportsSamplingParams(config_.model)) kwargs.set", "    if (!config_.temperature.isNull()) kwargs.set"),
    (P, "    if (js::isStr(stopReason) && stopReason->s == u\"refusal\") throw", "    if (false) throw"),
    (P, "    if (util::jsTrim(text).isEmpty()) throw LLMError(u\"模型返回空内容。\"_s);", "    if (text.isEmpty()) throw LLMError(u\"模型返回空内容。\"_s);"),
    (P, "    out.sample = text.left(200);", "    out.sample = text.left(199);"),
    (P, "        o.authToken = sdk::readEnv(\"ANTHROPIC_AUTH_TOKEN\");", "        o.authToken = std::nullopt;"),
    (P, "    const OJson temperature = config_.temperature.isNull() ? js::N(0) : numberJson(config_.temperature);", "    const OJson temperature = js::N(0);"),
    (P, "    if (fresh || !schemaRejected().contains(key)) {", "    if (!schemaRejected().contains(key)) {"),
    (P, "    if (fresh || !schemaRejected().contains(key)) {", "    if (true) {"),
    (P, "            schemaRejected().remove(key);", "            (void)key;"),
    (P, "    if (js::isStr(finish) && finish->s == u\"content_filter\") throw", "    if (false) throw"),
    (P, "    out.sample = choiceContent(choice).left(200);", "    out.sample = choiceContent(choice).left(199);"),
    (P, "        throw LLMError(friendlyApiError(view, baseUrl_), status);", "        throw LLMError(friendlyApiError(view, baseUrl_));"),
    (P, "            if (id.size() < 4 || placeholder.match(id).hasMatch()) continue;", "            if (id.size() <= 4 || placeholder.match(id).hasMatch()) continue;"),
    (P, "            if (id.size() < 4 || placeholder.match(id).hasMatch()) continue;", "            if (id.size() < 4) continue;"),
    (P, "    if (!f.open(QIODevice::ReadOnly)) throw util::CodedError(u\"ENOENT: no such file or directory, open '\"_s + path", "    if (!f.open(QIODevice::ReadOnly)) throw util::CodedError(u\"ENOENT: no such file or directory, open \"_s + path"),

    # ---- embeddings.cpp
    (M_, "    if (url->scheme != u\"http\" && url->scheme != u\"https\") return false;", "    if (url->scheme != u\"http\") return false;"),
    (M_, "    if (host.endsWith(u']')) host.chop(1);", "    (void)host;"),
    (M_, "    return host == u\"127.0.0.1\" || host == u\"localhost\" || host == u\"::1\";", "    return host == u\"127.0.0.1\" || host == u\"localhost\";"),
    (M_, "    if (texts.empty()) co_return std::vector<OJson>{};", "    if (false) co_return std::vector<OJson>{};"),
    (M_, "QString(baseUrl).remove(trailingSlashes) + u\"/api/embed\"_s", "QString(baseUrl) + u\"/api/embed\"_s"),
    (M_, "        const QString message = head == Fail::Deadline ? u\"The operation was aborted due to timeout\"_s : u\"fetch failed\"_s;", "        const QString message = u\"fetch failed\"_s;"),
    (M_, "    if (fail == Fail::None) parsed = js::parse(sdk::fetchText(bytes));", "    parsed = js::parse(sdk::fetchText(bytes));"),
    (M_, "    const bool isNull = !parsed || parsed->type == OJson::Null;", "    const bool isNull = !parsed;"),
    (M_, "    if (!ex->ok() || isNull || !js::isArr(embeddings)) {", "    if (isNull || !js::isArr(embeddings)) {"),
    (M_, "        const QString detail = js::nullish(err) ? u\"回包不对\"_s : js::str(err);", "        const QString detail = js::isStr(err) ? err->s : u\"回包不对\"_s;"),
    (M_, "    bool shapeOk = qsizetype(embeddings->items.size()) == qsizetype(texts.size());", "    bool shapeOk = qsizetype(embeddings->items.size()) >= qsizetype(texts.size());"),
    (M_, "        if (!(v.type == OJson::Array && !v.items.isEmpty())) shapeOk = false;", "        if (!(v.type == OJson::Array)) shapeOk = false;"),
    (M_, "    if (a.size() != b.size() || a.empty()) return 0;", "    if (a.size() != b.size()) return 0;"),
    (M_, "    const auto truthy = [](double v) { return v != 0 && !std::isnan(v); };", "    const auto truthy = [](double v) { return v != 0; };"),
    (M_, "    for (const OJson& x : vector.items) out.push_back(x.type == OJson::Null ? 0.0 : js::num(&x));", "    for (const OJson& x : vector.items) out.push_back(js::num(&x));"),

    # ---- whatwg_url.cpp(拷来的那一段:端口是新加的)

    # ---- whatwg_url.cpp(连接用的主机与端口就出自这里)
    (W, "case ']': case '^': case '|':", "case ']': case '|':"),
    (W, "forbiddenHostCodePoint(c) || c <= 0x1F || c == '%' || c == 0x7F;", "forbiddenHostCodePoint(c) || c <= 0x1F || c == 0x7F;"),
    (W, "forbiddenHostCodePoint(c) || c <= 0x1F || c == '%' || c == 0x7F;", "forbiddenHostCodePoint(c) || c == '%' || c == 0x7F;"),
    (W, "} else if (s.size() >= 2 && s[0] == u'0') {", "} else if (false) {"),
    (W, "else if (radix == 16 && isAsciiHex(c)) d = hexValue(c);", "else if (isAsciiHex(c)) d = hexValue(c);"),
    (W, "if (bestLen < 2) bestStart = -1;", "if (bestLen < 1) bestStart = -1;"),
    (W, "if (j - i > bestLen) {", "if (j - i >= bestLen) {"),
    (W, "if (decoded.isEmpty() || decoded == label ||", "if (decoded.isEmpty() ||"),
    (W, "if (endsInNumber(asciiDomain)) return parseIpv4(asciiDomain);", "if (false) return parseIpv4(asciiDomain);"),
    (W, "        if (authority.isEmpty()) return std::nullopt;\n        const qsizetype colon = userinfo.indexOf(u':');", "        const qsizetype colon = userinfo.indexOf(u':');"),
    (W, "if (const qsizetype at = authority.lastIndexOf(u'@'); at >= 0) {", "if (const qsizetype at = authority.indexOf(u'@'); at >= 0) {"),
    (W, "if (v > 65535) return std::nullopt;", "if (v > 65536) return std::nullopt;"),
    (W, "out.port = int(v) == def ? QString() : QString::number(int(v));", "out.port = QString::number(int(v));"),
    (W, "const int def = out.scheme == u\"http\" ? 80 : 443;", "const int def = out.scheme == u\"http\" ? 443 : 80;"),
    (W, "    if (host.isEmpty()) return std::nullopt;\n    if (!port.isEmpty()) {", "    if (!port.isEmpty()) {"),
    (W, "while (i < input.size() && (input[i] == u'/' || input[i] == u'\\\\')) ++i;", "while (i < input.size() && input[i] == u'/') ++i;"),
    (W, "input[end] != u'/' && input[end] != u'\\\\' && input[end] != u'?'", "input[end] != u'/' && input[end] != u'?'"),
    (W, "rest.split(QRegularExpression(u\"[/\\\\\\\\]\"_s))", "rest.split(u'/')"),
    (W, "if (!segments.isEmpty()) segments.removeLast();\n            if (last) segments.append(QString());", "if (!segments.isEmpty()) segments.removeLast();"),
    (W, "} else if (isSingleDot(buffer)) {\n            if (last) segments.append(QString());", "} else if (isSingleDot(buffer)) {\n            if (!last) segments.append(QString());"),
    (W, "s.compare(u\".%2e\"_s, Qt::CaseInsensitive) == 0 ||", "false ||"),
    (W, "s.compare(u\"%2e%2e\"_s, Qt::CaseInsensitive) == 0;", "false;"),
    (W, "return inQuerySet(c) || c == '?' || c == '^' ||", "return inQuerySet(c) || c == '?' ||"),
    (W, "inQuerySet(c) || c == '\\'';", "inQuerySet(c);"),
    (W, "c == '=' || c == '@' ||", "c == '=' ||"),
    (W, "int Url::dialPort() const { return port.isEmpty() ? (scheme == u\"https\" ? 443 : 80) : port.toInt(); }", "int Url::dialPort() const { return port.isEmpty() ? (scheme == u\"https\" ? 80 : 443) : port.toInt(); }"),
    (W, "return hostname.mid(1, hostname.size() - 2);", "return hostname.mid(1);"),
    (W, "if (v.isEmpty()) url.query.reset();", "if (false) url.query.reset();"),
    (W, "if (cp == '-' || cp == '.' || cp == '_' || cp == '~' ||", "if (cp == '-' || cp == '.' || cp == '_' ||"),
    (W, "        name.replace(u'+', u' ');\n", ""),
    (W, "return *util::jsArrayIndex(a.first) < *util::jsArrayIndex(b.first);", "return *util::jsArrayIndex(a.first) > *util::jsArrayIndex(b.first);"),
    (W, "if (hostname == u\"localhost\" || hostname == u\"[::1]\") return true;", "if (hostname == u\"localhost\") return true;"),
    (W, "if (p.size() != 4 || p[0] != u\"127\") return false;", "if (p.size() != 4 || p[0] != u\"128\") return false;"),
    (W, "if (!ok || v < 0 || v > 255 || s != QString::number(v)) return false;", "if (!ok || v < 0 || v > 256 || s != QString::number(v)) return false;"),
    (W, "if (!ok || v < 0 || v > 255 || s != QString::number(v)) return false;", "if (!ok || v < 0 || v > 255) return false;"),
    (W, "if (!out.isHttp()) return out;", "if (false) return out;"),
    (W, "if (!password.isEmpty()) out += u':' + password;", "(void)password;"),
    ("../util/whatwg_url.h", "bool hasCredentials() const { return !username.isEmpty() || !password.isEmpty(); }", "bool hasCredentials() const { return !username.isEmpty() && !password.isEmpty(); }"),
    ("../util/whatwg_url.h", "return query ? path + u'?' + *query : path;", "return path;"),
    ("../util/whatwg_url.h", "return port.isEmpty() ? hostname : hostname + u':' + port;", "return hostname;"),
    # ---- sdk_http.cpp:新的地址、头、闸、回话解析
    (H, "if (!(u == u'\\t' || (u >= 0x20 && u <= 0x7e) || (u >= 0x80 && u <= 0xff))) return false;", "if (!((u >= 0x20 && u <= 0x7e) || (u >= 0x80 && u <= 0xff))) return false;"),
    (H, "if (!(u == u'\\t' || (u >= 0x20 && u <= 0x7e) || (u >= 0x80 && u <= 0xff))) return false;", "if (!(u == u'\\t' || (u >= 0x20 && u <= 0x7f) || (u >= 0x80 && u <= 0xff))) return false;"),
    (H, "if (!(u == u'\\t' || (u >= 0x20 && u <= 0x7e) || (u >= 0x80 && u <= 0xff))) return false;", "if (!(u == u'\\t' || (u >= 0x20 && u <= 0x7e) || (u >= 0x80 && u <= 0xfe))) return false;"),
    (H, "out.get(u\"x-api-key\"_s).value_or(QString()).isEmpty() && out.get(u\"authorization\"_s)", "out.get(u\"x-api-key\"_s).value_or(QString()).isEmpty() || out.get(u\"authorization\"_s)"),
    (H, "if (!isTokenName(name)) throw NamedError(u\"TypeError\"_s, u\"Header name must", "if (false) throw NamedError(u\"TypeError\"_s, u\"Header name must"),
    (H, "(seen.contains(lower) ? u\"append\"_s : u\"delete\"_s)", "(seen.contains(lower) ? u\"delete\"_s : u\"append\"_s)"),
    (H, "if (s[i].unicode() > 255)", "if (s[i].unicode() > 256)"),
    (H, "if (s[i].unicode() > 255)", "if (s[i].unicode() >= 255)"),
    (H, ".arg(i).arg(int(s[i].unicode()))", ".arg(i + 1).arg(int(s[i].unicode()))"),
    (H, "if (trimmed.contains(QChar(0)) || trimmed.contains(u'\\r') || trimmed.contains(u'\\n'))", "if (trimmed.contains(u'\\r') || trimmed.contains(u'\\n'))"),
    (H, "if (trimmed.contains(QChar(0)) || trimmed.contains(u'\\r') || trimmed.contains(u'\\n'))", "if (trimmed.contains(QChar(0)) || trimmed.contains(u'\\n'))"),
    (H, "if (trimmed.contains(QChar(0)) || trimmed.contains(u'\\r') || trimmed.contains(u'\\n'))", "if (trimmed.contains(QChar(0)) || trimmed.contains(u'\\r'))"),
    (H, "return c == u'\\t' || c == u'\\n' || c == u'\\r' || c == u' '; };", "return c == u'\\n' || c == u'\\r' || c == u' '; };"),
    (H, "return c == u'\\t' || c == u'\\n' || c == u'\\r' || c == u' '; };", "return c == u'\\t' || c == u'\\n' || c == u' '; };"),
    (H, "const QString trimmed = jsTrimHttpWhitespace(value);", "const QString trimmed = value;"),
    (H, "for (const auto& [k, v] : headers.items()) out.set(k, jsTrimHttpWhitespace(v));", "for (const auto& [k, v] : headers.items()) out.set(k, v);"),
    (H, "if (flavor == Flavor::OpenAI) {\n            if (!isTokenName(name))", "if (flavor != Flavor::OpenAI) {\n            if (!isTokenName(name))"),
    (H, "if (url->isHttp() && url->query) {", "if (false) {"),
    (H, "if (!record.isEmpty()) util::whatwg::setSearch", "if (true) util::whatwg::setSearch"),
    (H, "baseURL + (baseURL.endsWith(u'/') && path.startsWith(u'/') ? path.mid(1) : path);", "baseURL + path;"),
    (H, "if (!url) throw NamedError(u\"TypeError\"_s, u\"Invalid URL\"_s);", "if (!url) return util::whatwg::Url{};"),
    (H, "url.isHttp() && !url.hasCredentials() && headerBytesWritable(headers);", "url.isHttp() && headerBytesWritable(headers);"),
    (H, "url.isHttp() && !url.hasCredentials() && headerBytesWritable(headers);", "url.isHttp() && !url.hasCredentials();"),
    (H, "st == 301 || st == 302 || st == 303 || st == 307 || st == 308", "st == 301 || st == 302 || st == 307 || st == 308"),
    (H, "st == 301 || st == 302 || st == 303 || st == 307 || st == 308", "st == 301 || st == 302 || st == 303 || st == 307"),
    (H, "(!tls && !util::whatwg::isLoopbackHostname(url.hostname))", "false"),
    (H, "const bool refused = !url.isHttp() ||", "const bool refused = false ||"),
    (H, "if (!peerAllowed(plainHttp_, peer)) {", "if (false) {"),
    (H, "return !plainHttp || peer.isLoopback();", "return peer.isLoopback();"),
    (H, "return !plainHttp || peer.isLoopback();", "return true;"),
    (H, "return !plainHttp || peer.isLoopback();", "return !plainHttp && peer.isLoopback();"),
    (H, "raw->plainHttp_ = !tls;", "raw->plainHttp_ = false;"),
    (H, "QHostAddress peer = socket_->peerAddress();\n    if (hooksRef().peerAddressFilter) peer = hooksRef().peerAddressFilter(peer);", "QHostAddress peer = socket_->peerAddress();"),
    (W, "if (p.size() != 4 || p[0] != u\"127\") return false;", "if (p.size() != 4 || (p[0] != u\"127\" && p[0] != u\"0\")) return false;"),
    (W, "if (hostname == u\"localhost\" || hostname == u\"[::1]\") return true;", "if (hostname == u\"localhost\" || hostname == u\"[::1]\" || hostname == u\"[::]\") return true;"),
    (W, "if (hostname == u\"localhost\" || hostname == u\"[::1]\") return true;", "if (hostname == u\"localhost\" || hostname == u\"[::1]\" || hostname == u\"0.0.0.0\") return true;"),
    (W, "if (hostname == u\"localhost\" || hostname == u\"[::1]\") return true;", "if (hostname == u\"localhost\" || hostname == u\"[::1]\" || hostname == u\"[::ffff:7f00:1]\") return true;"),
    (H, "for (const auto& [k, v] : headers.items()) clean = clean && !hasLineBreak(k) && !hasLineBreak(v);", "(void)hasLineBreak;"),
    (H, "bool clean = !hasLineBreak(url.requestTarget()) && !hasLineBreak(url.host());", "bool clean = true;"),
    (H, "if (!headers.get(u\"host\"_s)) req +=", "if (true) req +="),
    (H, "if (k == u\"content-length\" || k == u\"transfer-encoding\" || k == u\"connection\") continue;", "if (k == u\"transfer-encoding\" || k == u\"connection\") continue;"),
    (H, "if (k == u\"content-length\" || k == u\"transfer-encoding\" || k == u\"connection\") continue;", "if (k == u\"content-length\" || k == u\"connection\") continue;"),
    (H, "if (k == u\"content-length\" || k == u\"transfer-encoding\" || k == u\"connection\") continue;", "if (k == u\"content-length\" || k == u\"transfer-encoding\") continue;"),
    (H, "if (!sawStatus_ && line.isEmpty()) continue;", ""),
    (H, "if (status_ < 100) {", "if (status_ < 99) {"),
    (H, "(?:0\\\\.9|1\\\\.0|1\\\\.1|2\\\\.0)", "(?:1\\\\.0|1\\\\.1|2\\\\.0)"),
    (H, "(?:0\\\\.9|1\\\\.0|1\\\\.1|2\\\\.0)", "(?:0\\\\.9|1\\\\.0|1\\\\.1)"),
    (H, "if (isOws(line.front())) {  // 折行", "if (false) {  // 折行"),
    (H, "if (colon < 0 || !isTokenBytes(name)) {", "if (colon < 0) {"),
    (H, "if (status_ == 100 || status_ == 101) {", "if (status_ == 101) {"),
    (H, "if (status_ == 100 || status_ == 101) {", "if (status_ == 100) {"),
    (H, "if (contentLengths > 1 || (contentLengths == 1 && hasTe)) {", "if (contentLengths > 1) {"),
    (H, "if (contentLengths > 1 || (contentLengths == 1 && hasTe)) {", "if (contentLengths == 1 && hasTe) {"),
    (H, "if (name.toLower() == \"content-length\") {", "if (false) {"),
    (H, "if (status_ == 204 || status_ == 304) {", "if (status_ == 204) {"),
    (H, "} else if (hasTe && teLast == \"chunked\") {", "} else if (hasTe) {"),
    (H, "if (in_[0] != '\\r' || in_[1] != '\\n') {", "if (in_[0] != '\\r' && in_[1] != '\\n') {"),
    (H, "if (!in_.isEmpty() && in_[0] != '\\r') failWith(Fail::Truncated);", ""),
    (H, "bool ok = !sizeToken.isEmpty();", "bool ok = true;"),
    (H, "for (const char c : sizeToken) ok = ok && std::isxdigit(uchar(c)) != 0;", ""),
    (H, "ok = conv && size >= 0;", "ok = conv;"),
    (H, "if (size == 0) {\n                    chunkTrailer_ = true;", "if (size == 1) {\n                    chunkTrailer_ = true;"),
    (H, "bool valid = colon > 0 && isTokenBytes(line.left(colon)) && !isOws(line.front());", "bool valid = colon > 0 && !isOws(line.front());"),
    (H, "bool valid = colon > 0 && isTokenBytes(line.left(colon)) && !isOws(line.front());", "bool valid = isTokenBytes(line.left(colon)) && !isOws(line.front());"),
    (H, "lone >= 0 && (in_.indexOf(\"\\r\\n\") < 0 || lone < in_.indexOf(\"\\r\\n\"))", "lone >= 0 && (in_.indexOf(\"\\r\\n\") < 0)"),
    (H, "if (line.contains('\\r') || line.contains('\\n')) {", "if (line.contains('\\n')) {"),
    (H, "bool isHeaderValueByte(uchar c) { return c == '\\t' || (c >= 0x20 && c <= 0x7e) || c >= 0x80; }", "bool isHeaderValueByte(uchar c) { return (c >= 0x20 && c <= 0x7e) || c >= 0x80; }"),
    (H, "bool isHeaderValueByte(uchar c) { return c == '\\t' || (c >= 0x20 && c <= 0x7e) || c >= 0x80; }", "bool isHeaderValueByte(uchar c) { return c == '\\t' || (c >= 0x20 && c <= 0x7f) || c >= 0x80; }"),
    (H, "if (cr >= 0 && cr + 1 < in_.size()) failWith(Fail::Network);", ""),
    # ---- embeddings.cpp 新增的
    (M_, "if (url->hasCredentials())", "if (false)"),
    (M_, "if (!url) throw EmbedError(u\"连不上本机嵌入服务(\"_s + baseUrl + u\"):Failed to parse URL from \"_s + full);", ""),

    # ---- domain/config.cpp 的 validateBaseUrl(现在和连接共用 util::whatwg)
    ("../domain/config.cpp", "if (!parsed || !parsed->isHttp()) throw LLMError(", "if (!parsed) throw LLMError("),
    ("../domain/config.cpp", "if (parsed->scheme == u\"http\" && host != u\"127.0.0.1\"", "if (host != u\"127.0.0.1\""),
    ("../domain/config.cpp", "&& host != u\"localhost\" && host != u\"::1\")", "&& host != u\"localhost\")"),
    ("../domain/config.cpp", "while (url.endsWith(u'/')) url.chop(1);", "(void)url;"),
    ("../domain/config.cpp", "if (host.startsWith(u'[')) host.remove(0, 1);", "(void)host;"),
]

ONLY = [x for x in os.environ.get("ONLY", "").split("|") if x]
if ONLY:
    M = [m for m in M if any(o in m[1] for o in ONLY)]
# SHARD=i/n:把变异均分给 n 份副本同时跑(每份副本各自的 work/mut-llm<i>/native 与 build)
if os.environ.get("SHARD"):
    _i, _n = (int(x) for x in os.environ["SHARD"].split("/"))
    M = [m for k, m in enumerate(M) if k % _n == _i]
# RERUN=上一次的结果.json:只跑上次活下来的(补了用例之后复查)
if os.environ.get("RERUN"):
    with open(os.environ["RERUN"], encoding="utf-8") as fh:
        _prev = json.load(fh)
    _survived = {(r[0], r[1], r[2]) for r in _prev if r[3] == "survived"}
    _errored = {(r[0], r[1]) for r in _prev if r[3] == "build-error"}  # 编不过的:变异原文可能已改,按(文件,原文)认
    M = [m for m in M if m in _survived or (m[0], m[1]) in _errored]


def build():
    b = subprocess.run(["cmake", "--build", B, "--target", TEST, "-j8"], capture_output=True, text=True)
    return b.returncode == 0


def run():
    try:
        r = subprocess.run([os.path.join(B, "tests", TEST)], capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return False
    return r.returncode == 0


def bump(path):
    t = time.time() + 3
    os.utime(path, (t, t))


JOURNAL = os.path.join(WORK, ".mutate_llm.restore.json")


def recover():
    """上次被杀在半路:把记下的原文写回去"""
    if not os.path.exists(JOURNAL):
        return
    with open(JOURNAL, encoding="utf-8") as fh:
        j = json.load(fh)
    with open(j["path"], "w", encoding="utf-8") as fh:
        fh.write(j["orig"])
    bump(j["path"])
    os.remove(JOURNAL)
    print("recovered", j["path"], flush=True)


def main():
    if not os.environ.get("DRY") and "/work/mut-" not in ROOT:
        print("拒绝:只在 work/mut- 开头的私有副本里跑(这里是 " + ROOT + ")", flush=True)
        return 2
    if not os.environ.get("DRY"):
        recover()
    if os.environ.get("DRY"):
        bad = 0
        for f, old, new in M:
            n = open(E + f, encoding="utf-8").read().count(old)
            if n != 1:
                bad += 1
                print(f"bad-anchor({n})", f, old[:100])
        print(len(M), "mutations,", bad, "bad anchors")
        return 1 if bad else 0
    results = []
    try:
        for f, old, new in M:
            path = E + f
            orig = open(path, encoding="utf-8").read()
            n = orig.count(old)
            if n != 1:
                results.append([f, old, new, f"bad-anchor({n})"])
                print(f"bad-anchor({n})", f, old[:80], flush=True)
                continue
            with open(JOURNAL, "w", encoding="utf-8") as fh:
                json.dump({"path": path, "orig": orig}, fh, ensure_ascii=False)
            try:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(orig.replace(old, new))
                bump(path)
                res = ("survived" if run() else "caught") if build() else "build-error"
            finally:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(orig)
                bump(path)
                os.remove(JOURNAL)
                build()
            results.append([f, old, new, res])
            print(res, f, old.replace("\n", " ")[:90], flush=True)
    finally:
        build()
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=1)
    print(dict(Counter(r[3] for r in results)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
