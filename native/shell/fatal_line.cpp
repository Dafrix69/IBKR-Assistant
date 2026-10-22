#include "shell/fatal_line.h"

#include <QRegularExpression>
#include <QStringList>

namespace ibkr::shell {

namespace {

QStringList lines(const QString& detail) {
    static const QRegularExpression lineBreak(QStringLiteral("\\r?\\n"));
    return detail.split(lineBreak);
}

}  // namespace

std::optional<ConfigFatal> configFatalLine(const QString& detail) {
    static const QRegularExpression fatal(QStringLiteral(R"(\[fatal:config:(missing|syntax|invalid)\]\s*(.*)\z)"));
    const QStringList all = lines(detail);
    for (qsizetype i = all.size() - 1; i >= 0; --i) {
        const QRegularExpressionMatch m = fatal.match(all[i]);
        if (m.hasMatch()) return ConfigFatal{m.captured(1), m.captured(2).trimmed()};
    }
    return std::nullopt;
}

std::optional<StoreFatal> storeFatalLine(const QString& detail) {
    static const QRegularExpression path(QStringLiteral(R"(\[fatal:store:path\]\s*(.+)\z)"));
    static const QRegularExpression fatal(QStringLiteral(R"(\[fatal:store:(newer|corrupt|locked|unwritable)\]\s*(.*)\z)"));
    std::optional<StoreFatal> found;
    std::optional<QString> dbPath;
    for (const QString& line : lines(detail)) {
        const QRegularExpressionMatch p = path.match(line);
        if (p.hasMatch()) dbPath = p.captured(1).trimmed();
        const QRegularExpressionMatch m = fatal.match(line);
        if (m.hasMatch()) found = StoreFatal{m.captured(1), m.captured(2).trimmed(), {}};
    }
    if (found) found->dbPath = dbPath;
    return found;
}

}  // namespace ibkr::shell
