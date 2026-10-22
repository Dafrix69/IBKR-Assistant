#include "util/redact.h"

#include <QRegularExpression>
#include <QStringList>

namespace ibkr::util {

QString maskAccount(const QString& id) {
    if (id.size() <= 5) return QStringLiteral("***");
    qsizetype head = 0;
    while (head < id.size() && id[head].unicode() < 128 && id[head].isLetter()) ++head;
    return id.left(head) + QStringLiteral("***") + id.right(3);
}

QString maskAccountList(const QString& list) {
    QStringList parts = list.split(u',', Qt::SkipEmptyParts);
    for (QString& part : parts) part = maskAccount(part.trimmed());
    return parts.join(u',');
}

QString maskAccountLikeIds(QString text) {
    // \b 与 \d 只认 ASCII(没开 Unicode 属性),和 JS 不带 u 标志的正则一样
    static const QRegularExpression ibkrAccount(QStringLiteral(R"(\b(DU|DF|U|F|I)(\d{2,6})(\d{3})\b)"));
    return text.replace(ibkrAccount, QStringLiteral("\\1***\\3"));
}

}  // namespace ibkr::util
