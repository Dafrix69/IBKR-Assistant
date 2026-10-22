#include "shell/consent_model.h"

#include "shell/doc_parse.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QRegularExpression>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

QList<LegalDoc> loadLegalDocs(const QString& dir) {
    const auto read = [&dir](const QString& name) {
        QFile f(QDir(dir).filePath(name));
        return f.open(QIODevice::ReadOnly) ? QString::fromUtf8(f.readAll()) : QString();
    };
    return {{u"risk"_s, u"风险揭示"_s, read(u"risk-disclosure.md"_s)},
            {u"terms"_s, u"使用条款"_s, read(u"terms.md"_s)},
            {u"privacy"_s, u"隐私说明"_s, read(u"privacy.md"_s)}};
}

QString legalVersion(const QList<LegalDoc>& docs) {
    static const QRegularExpression re(u"^版本:\\s*(\\d{4}-\\d{2}-\\d{2})\\s*$"_s, QRegularExpression::MultilineOption);
    QString first;
    for (const LegalDoc& d : docs) {
        const QString v = re.match(d.text).captured(1);
        if (v.isEmpty() || (!first.isEmpty() && v != first)) return {};
        first = v;
    }
    return first;
}

ConsentModel::ConsentModel(ConsentStore* store, QString legalDir, QString appVersion, QObject* parent)
    : QObject(parent), store_(store), docs_(loadLegalDocs(legalDir)), version_(legalVersion(docs_)), appVersion_(std::move(appVersion)), state_(store->state()) {}

QVariantList ConsentModel::docs() const {
    QVariantList out;
    // html:照 Electron 的 PlainDoc 切块后拼的富文本(shell/doc_parse),界面画这个,不画 text
    for (const LegalDoc& d : docs_)
        out.append(QVariantMap{{u"key"_s, d.key}, {u"title"_s, d.title}, {u"text"_s, d.text}, {u"html"_s, docToHtml(parseDoc(d.text))}});
    return out;
}

void ConsentModel::accept() {
    error_.clear();
    // 同意的是文本里写的那一版;读不出版本的构建谁也同意不了
    if (version_.isEmpty()) {
        error_ = u"条款文本读不出版本号,不能同意。请重新安装。"_s;
    } else {
        QString error;
        if (const auto s = store_->accept(version_, appVersion_, QDateTime::currentMSecsSinceEpoch(), &error)) state_ = *s;
        else error_ = error;
    }
    emit changed();
}

void ConsentModel::showTerms() {
    viewing_ = true;
    emit changed();
}

void ConsentModel::hideTerms() {
    viewing_ = false;
    emit changed();
}

}  // namespace ibkr::shell
