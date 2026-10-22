// WHATWG URL 标准里 http / https(特殊协议、无 base)的那一段,完整的:协议、凭证、主机(域名 / IPv4 / IPv6)、端口、
// 路径(反斜杠当斜杠、点段折叠、百分号编码)、查询、片段,以及序列化。
// 为什么自己写、不用 QUrl:**连接用的主机与端口必须就是 TS 那边 `new URL(…)` / fetch 认出来的那一个**。QUrl 对反斜杠、userinfo、
// 百分号编码的主机的读法和 WHATWG 不一样——`http://127.0.0.1:A\@localhost:B` 在 WHATWG 里是 127.0.0.1:A(路径 `/@localhost:B`),
// 在 QUrl 里却是 localhost:B。校验(validateBaseUrl、isLoopbackUrl)按 WHATWG 放行、连接按 QUrl 去连,就是一个把带 Key 的请求
// 发到别处的洞。现在校验与连接都从这一个解析器出:sdk_http / embeddings 只按这里解析出来的 scheme / hostname / port 拨号,不经 QUrl。
// 用的人:parsing/sdk_http、parsing/embeddings(连接)、domain/config 的 validateBaseUrl(校验)——同一个解析器,校验与连接不会读出两个主机。
// 期望值:tests/fixtures/gen_llm.mjs 的 urls 一节(与 gen_config.mjs 的 validateBaseUrl 语料)(`new URL(…)` 在几千个构造出来的串上现跑;含反斜杠、@、userinfo、端口、IPv6、
// 百分号编码、尾点、IDN、大小写的各种写法)。
//
// 不是 http / https 的协议只认出协议名(别的一律拒,调用方不需要它们)。IDN 域名交给 QUrl::toAce(Qt 的 IDNA 表对 Electron 的 ICU 表
// 在个别码位上不同——对拍里没有出现分歧;出了分歧的话按失败处理,见 tst_llm 的 urls 用例)。
#pragma once

#include <QString>

#include <optional>

namespace ibkr::util::whatwg {

struct Url {
    QString scheme;    ///< 小写;不是 http / https 时只有这一项有值
    QString username;  ///< 已按 userinfo 集合编码
    QString password;
    QString hostname;  ///< 序列化之后的(IPv6 带方括号、IPv4 点分十进制、域名小写 ASCII)
    QString port;      ///< 序列化之后的;默认端口(80 / 443)是空
    QString path;      ///< 以 / 开头,已折叠点段、已编码
    std::optional<QString> query;     ///< 不带 ?
    std::optional<QString> fragment;  ///< 不带 #

    bool isHttp() const { return scheme == u"http" || scheme == u"https"; }
    /// URL.host:hostname 加上非默认端口
    QString host() const { return port.isEmpty() ? hostname : hostname + u':' + port; }
    /// 有用户名或密码(fetch 会拒:Request cannot be constructed from a URL that includes credentials)
    bool hasCredentials() const { return !username.isEmpty() || !password.isEmpty(); }
    /// 请求行里的目标:路径加查询
    QString requestTarget() const { return query ? path + u'?' + *query : path; }
    /// URL.href
    QString href() const;
    /// 拨号用的主机:去掉 IPv6 的方括号
    QString dialHost() const;
    /// 实际要连的端口(默认端口补上)
    int dialPort() const;
};

/// new URL(input) 的结果(只认 http / https,别的协议只给 scheme);解析不了是空
std::optional<Url> parse(QString input);

/// URL.search = value:按特殊协议的查询集合编码,空串是没有查询
void setSearch(Url& url, const QString& value);

/// URLSearchParams(url.search) 之后 Object.fromEntries:键保持第一次出现的位置、值取最后一个;
/// 再按 JS 对象的键序(像数组下标的键在前、数值升序)排。查询是空(没有 / 没有成对的项)时返回空表
QList<QPair<QString, QString>> searchParamsRecord(const QString& query);

/// SDK 的 stringifyQuery(qs 的 stringify,字符串值):键与值都按 qs 的 encode(只留 A-Za-z0-9 - . _ ~)编码,`&` 连起来
QString stringifyQuery(const QList<QPair<QString, QString>>& record);

/// 判断是不是回环主机(调用方拿 parse 出来的 hostname 问):127.0.0.0/8、[::1]、localhost(不带尾点)
bool isLoopbackHostname(const QString& hostname);

}  // namespace ibkr::util::whatwg
