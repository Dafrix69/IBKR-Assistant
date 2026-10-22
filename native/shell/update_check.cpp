#include "shell/update_check.h"

#include "shell/jsvalue.h"
#include "util/jsnum.h"

#include <QJsonArray>
#include <QRegularExpression>
#include <QSysInfo>

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell::update {

namespace {
#define JS_WS R"(\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF})"

/// String(v || '')
QString orEmpty(const QJsonValue& v) { return jsTruthy(v) ? jsString(v) : QString(); }

int comparePre(const QString& a, const QString& b) {
    const QStringList pa = a.split(u'.'), pb = b.split(u'.');
    static const QRegularExpression digits(u"\\A[0-9]+\\z"_s);
    for (qsizetype i = 0; i < std::max(pa.size(), pb.size()); ++i) {
        if (i >= pa.size()) return -1;
        if (i >= pb.size()) return 1;
        const bool na = digits.match(pa[i]).hasMatch(), nb = digits.match(pb[i]).hasMatch();
        if (na && nb) {
            const double d = pa[i].toDouble() - pb[i].toDouble();
            if (d != 0) return d < 0 ? -1 : 1;
        } else if (na != nb) {
            return na ? -1 : 1;
        } else if (pa[i] != pb[i]) {
            return pa[i] < pb[i] ? -1 : 1;
        }
    }
    return 0;
}
}  // namespace

std::optional<Version> parseVersion(const QJsonValue& text) {
    static const QRegularExpression re(uR"(\Av?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\z)"_s);
    const auto m = re.match(jsTrim(orEmpty(text)));
    if (!m.hasMatch()) return std::nullopt;
    return Version{{m.captured(1).toDouble(), m.captured(2).toDouble(), m.captured(3).toDouble()}, m.captured(4)};
}

std::optional<int> compareVersions(const QJsonValue& a, const QJsonValue& b) {
    const auto va = parseVersion(a), vb = parseVersion(b);
    if (!va || !vb) return std::nullopt;
    for (int i = 0; i < 3; ++i)
        if (va->nums[i] != vb->nums[i]) return va->nums[i] < vb->nums[i] ? -1 : 1;
    if (va->pre == vb->pre) return 0;
    if (va->pre.isEmpty()) return 1;
    if (vb->pre.isEmpty()) return -1;
    return comparePre(va->pre, vb->pre);
}

QJsonValue assetFor(const QJsonValue& assets, const QString& platform, const QString& arch) {
    const QString plat = platform == u"darwin" ? u"mac"_s : platform == u"win32" ? u"win"_s : QString();
    const QString ext = platform == u"darwin" ? u"dmg"_s : u"exe"_s;
    if (plat.isEmpty() || !assets.isArray()) return QJsonValue();
    const QString tail = u"-%1-%2.%3"_s.arg(plat, arch, ext);
    for (const QJsonValue& a : assets.toArray()) {
        const QJsonObject o = a.toObject();
        if (!o.value("name"_L1).isString() || !o.value("name"_L1).toString().endsWith(tail)) continue;
        const QJsonValue url = o.value("browser_download_url"_L1);
        if (!url.isString() || !url.toString().startsWith(kReleasesPage + u"download/"_s)) return QJsonValue();
        const QJsonValue size = o.value("size"_L1);
        return QJsonObject{{u"name"_s, o.value("name"_L1)}, {u"url"_s, url}, {u"size"_s, size.isDouble() && std::isfinite(size.toDouble()) ? size : QJsonValue()}};
    }
    return QJsonValue();
}

QString plainNotes(const QJsonValue& body) {
    QString text = orEmpty(body);
    text.replace(u"\r\n"_s, u"\n"_s);
    static const QRegularExpression comment(uR"(<!--[\s\S]*?-->)"_s);
    static const QRegularExpression image(uR"(!\[[^\]]*\]\([^)]*\))"_s);
    static const QRegularExpression link(uR"(\[([^\]]+)\]\([^)]*\))"_s);
    static const QRegularExpression heading(QStringLiteral(R"(^#{1,6}[)" JS_WS R"(]*)"), QRegularExpression::MultilineOption);
    static const QRegularExpression bold(uR"(\*\*([^*]+)\*\*)"_s);
    static const QRegularExpression blank(uR"(\n{3,})"_s);
    text.replace(comment, QString()).replace(image, QString()).replace(link, u"\\1"_s).replace(heading, QString()).replace(bold, u"\\1"_s).replace(blank, u"\n\n"_s);
    text = jsTrim(text);
    if (text.size() <= kNotesMax) return text;
    QString head = text.left(kNotesMax);
    qsizetype e = head.size();
    while (e > 0 && util::isJsWhitespace(head.at(e - 1))) --e;
    return head.left(e) + u"…"_s;
}

QJsonObject summarizeRelease(const QJsonValue& release, const QString& current, const QString& platform, const QString& arch, double now) {
    const QJsonObject r = release.toObject();
    const QString tag = orEmpty(r.value("tag_name"_L1));
    const QString latest = QString(tag).remove(QRegularExpression(u"\\Av"_s));
    const auto cmp = compareVersions(current, latest);
    const QJsonValue html = r.value("html_url"_L1);
    const QString page = html.isString() && html.toString().startsWith(kReleasesPage) ? html.toString() : kReleasesPage + u"latest"_s;
    const QJsonValue published = r.value("published_at"_L1);
    return QJsonObject{
        {u"current"_s, current},
        {u"latest"_s, latest.isEmpty() ? QJsonValue() : QJsonValue(latest)},
        // 认不出版本号按"没有新版"处理:宁可少提示一次,也不拿一个比不出来的号去催人升级
        {u"newer"_s, cmp == -1},
        {u"url"_s, page},
        {u"download"_s, assetFor(r.value("assets"_L1), platform, arch)},
        {u"publishedAt"_s, published.isString() ? published : QJsonValue()},
        {u"notes"_s, plainNotes(r.value("body"_L1))},
        {u"checkedAt"_s, now},
    };
}

QString nodePlatform() {
#if defined(Q_OS_MACOS)
    return u"darwin"_s;
#elif defined(Q_OS_WIN)
    return u"win32"_s;
#else
    return u"linux"_s;
#endif
}

QString nodeArch() {
    const QString a = QSysInfo::currentCpuArchitecture();
    return a == u"x86_64" ? u"x64"_s : a;
}

}  // namespace ibkr::shell::update
