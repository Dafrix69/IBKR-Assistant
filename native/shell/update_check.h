// 新版本检查(desktop/update-check.js 逐条搬):只读 GitHub Releases 的公开信息,告诉用户"有新版了、去哪下"。
// 不下载、不安装、不替换任何文件。返回给界面的链接只认本仓库 releases 下的地址,其余一律换成固定的下载页;
// 发布说明按纯文本截断。请求本身在壳里(app/support_service,Qt Network)。期望值由 node 跑原模块现算(tests/fixtures/gen_update_check.mjs)。
#pragma once

#include <QJsonObject>
#include <QJsonValue>
#include <QList>
#include <QString>

#include <optional>

namespace ibkr::shell::update {

inline const QString kRepo = QStringLiteral("Dafrix69/IBKR-Assistant");
inline const QString kLatestApi = QStringLiteral("https://api.github.com/repos/Dafrix69/IBKR-Assistant/releases/latest");
inline const QString kReleasesPage = QStringLiteral("https://github.com/Dafrix69/IBKR-Assistant/releases/");
inline constexpr int kNotesMax = 1200;
inline constexpr int kTimeoutMs = 8000;

struct Version {
    QList<double> nums;
    QString pre;
};
/// 'v0.5.2' / '0.5.2-beta.1';认不出返回空(认不出就不提示,不瞎比)
std::optional<Version> parseVersion(const QJsonValue& text);
/// a < b → -1,相等 → 0,a > b → 1;任一边认不出 → 空。正式版比同号的预发布版新
std::optional<int> compareVersions(const QJsonValue& a, const QJsonValue& b);
/// 这台机器该下哪个安装包(Datrix-<版本>-mac-arm64.dmg / -win-x64.exe):{ name, url, size };找不到返回 null
QJsonValue assetFor(const QJsonValue& assets, const QString& platform, const QString& arch);
/// 发布说明:只要纯文本,去掉 Markdown 里最吵的几样,截断
QString plainNotes(const QJsonValue& body);
/// GitHub 的一条 release → { current, latest, newer, url, download, publishedAt, notes, checkedAt }
QJsonObject summarizeRelease(const QJsonValue& release, const QString& current, const QString& platform, const QString& arch, double now);
/// 这台机器的平台与架构,写成 Node 的叫法(darwin / win32 / linux,arm64 / x64)
QString nodePlatform();
QString nodeArch();

}  // namespace ibkr::shell::update
