#include "shell/doc_parse.h"

#include "shell/jsvalue.h"
#include "util/jsnum.h"

#include <QJsonObject>
#include <QRegularExpression>

using namespace Qt::StringLiterals;

namespace ibkr::shell {

namespace {

using util::isJsWhitespace;

// JS 正则的 \s,写成显式的字符类(PCRE 的 \s 不认 U+FEFF、带 Unicode 属性时又多认 U+0085)
constexpr auto kWs = R"([\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}])";

qsizetype skipWs(const QString& s, qsizetype i) {
    while (i < s.size() && isJsWhitespace(s.at(i))) ++i;
    return i;
}

// JS 的 . 不认的行终结符(\n \r 已经切掉了)
bool hasLineTerminator(QStringView s) { return s.contains(QChar(0x2028)) || s.contains(QChar(0x2029)); }

/// /^(#{1,3})\s+(.*)$/:返回级数(0 = 不是标题),content 是第二组
int headingLevel(const QString& line, QString* content) {
    qsizetype k = 0;
    while (k < line.size() && line.at(k) == u'#') ++k;
    if (k < 1 || k > 3 || k >= line.size() || !isJsWhitespace(line.at(k))) return 0;
    const qsizetype rest = skipWs(line, k);
    if (hasLineTerminator(QStringView(line).mid(rest))) return 0;
    *content = line.mid(rest);
    return int(k);
}

/// /^\s*-\s+/:是列表项就返回去掉这一截之后的位置,不是返回 -1
qsizetype listItemStart(const QString& line) {
    const qsizetype dash = skipWs(line, 0);
    if (dash >= line.size() || line.at(dash) != u'-') return -1;
    if (dash + 1 >= line.size() || !isJsWhitespace(line.at(dash + 1))) return -1;
    return skipWs(line, dash + 1);
}

bool isTableRule(const QString& line) {
    static const QRegularExpression re(
        QString(u"\\A%1*\\|?%1*:?-{3,}:?%1*(\\|%1*:?-{3,}:?%1*)*\\|?%1*\\z"_s).arg(QLatin1StringView(kWs)));
    return re.match(line).hasMatch();
}

QStringList cells(const QString& line) {
    QString s = jsTrim(line);
    if (s.startsWith(u'|')) s.remove(0, 1);
    if (s.endsWith(u'|')) s.chop(1);
    QStringList out = s.split(u'|');
    for (QString& c : out) c = jsTrim(c);
    return out;
}

QList<DocLine> parseCells(const QString& line) {
    QList<DocLine> out;
    for (const QString& c : cells(line)) out.append(parseDocInline(c));
    return out;
}

QJsonArray lineJson(const DocLine& line) {
    QJsonArray out;
    for (const DocInline& p : line) out.append(QJsonObject{{u"text"_s, p.text}, {u"bold"_s, p.bold}});
    return out;
}

QJsonArray linesJson(const QList<DocLine>& lines) {
    QJsonArray out;
    for (const DocLine& l : lines) out.append(lineJson(l));
    return out;
}

QString lineHtml(const DocLine& line) {
    QString out;
    for (const DocInline& p : line) out += p.bold ? u"<b>"_s + p.text.toHtmlEscaped() + u"</b>"_s : p.text.toHtmlEscaped();
    return out;
}

}  // namespace

DocLine parseDocInline(const QString& text) {
    // text.split(/(\*\*[^*]+\*\*)/g):分隔符(加粗)也留在结果里,空段丢掉
    static const QRegularExpression bold(u"\\*\\*[^*]+\\*\\*"_s);
    DocLine out;
    qsizetype at = 0;
    for (auto it = bold.globalMatch(text); it.hasNext();) {
        const auto m = it.next();
        if (m.capturedStart() > at) out.append({text.mid(at, m.capturedStart() - at), false});
        out.append({m.captured().mid(2, m.capturedLength() - 4), true});
        at = m.capturedEnd();
    }
    if (at < text.size()) out.append({text.mid(at), false});
    return out;
}

QList<DocBlock> parseDoc(const QString& source) {
    QString normalized = source;
    normalized.replace(u"\r\n"_s, u"\n"_s).replace(u'\r', u'\n');
    const QStringList lines = normalized.split(u'\n');
    QList<DocBlock> blocks;
    QStringList paragraph;
    const auto flush = [&] {
        if (!paragraph.isEmpty()) blocks.append({DocBlock::Paragraph, 0, parseDocInline(paragraph.join(QString())), {}, {}, {}});
        paragraph.clear();
    };
    for (qsizetype i = 0; i < lines.size(); ++i) {
        const QString& line = lines.at(i);
        QString content;
        if (const int level = headingLevel(line, &content)) {
            flush();
            blocks.append({DocBlock::Heading, level, parseDocInline(jsTrim(content)), {}, {}, {}});
            continue;
        }
        if (listItemStart(line) >= 0) {
            flush();
            DocBlock list{DocBlock::List, 0, {}, {}, {}, {}};
            for (; i < lines.size(); ++i) {
                const qsizetype start = listItemStart(lines.at(i));
                if (start < 0) break;
                list.items.append(parseDocInline(lines.at(i).mid(start)));
            }
            --i;
            blocks.append(list);
            continue;
        }
        if (jsTrim(line).startsWith(u'|') && isTableRule(lines.value(i + 1))) {
            flush();
            DocBlock table{DocBlock::Table, 0, {}, {}, parseCells(line), {}};
            for (i += 2; i < lines.size() && jsTrim(lines.at(i)).startsWith(u'|'); ++i) table.rows.append(parseCells(lines.at(i)));
            --i;
            blocks.append(table);
            continue;
        }
        if (jsTrim(line).isEmpty()) {
            flush();
            continue;
        }
        paragraph.append(jsTrim(line));
    }
    flush();
    return blocks;
}

QJsonArray docBlocksToJson(const QList<DocBlock>& blocks) {
    QJsonArray out;
    for (const DocBlock& b : blocks) {
        switch (b.kind) {
        case DocBlock::Heading: out.append(QJsonObject{{u"kind"_s, u"heading"_s}, {u"level"_s, b.level}, {u"inline"_s, lineJson(b.inline_)}}); break;
        case DocBlock::Paragraph: out.append(QJsonObject{{u"kind"_s, u"paragraph"_s}, {u"inline"_s, lineJson(b.inline_)}}); break;
        case DocBlock::List: out.append(QJsonObject{{u"kind"_s, u"list"_s}, {u"items"_s, linesJson(b.items)}}); break;
        case DocBlock::Table: {
            QJsonArray rows;
            for (const auto& r : b.rows) rows.append(linesJson(r));
            out.append(QJsonObject{{u"kind"_s, u"table"_s}, {u"head"_s, linesJson(b.head)}, {u"rows"_s, rows}});
            break;
        }
        }
    }
    return out;
}

QString docToHtml(const QList<DocBlock>& blocks) {
    // 字号照 shell.css:.plain-doc 12.5px,h2 17px / 700,h3 13.5px / 650,h4 12.5px / 650(Qt 富文本只认 bold / 600 一档)
    QString out;
    for (const DocBlock& b : blocks) {
        switch (b.kind) {
        case DocBlock::Heading: {
            static const char* const style[] = {"", "font-size:17px;font-weight:700;margin:4px 0 8px",
                                                "font-size:13.5px;font-weight:600;margin:16px 0 6px", "font-size:12.5px;font-weight:600;margin:12px 0 4px"};
            out += u"<p style=\"%1\">%2</p>"_s.arg(QLatin1StringView(style[b.level]), lineHtml(b.inline_));
            break;
        }
        case DocBlock::Paragraph: out += u"<p style=\"margin:0 0 8px\">"_s + lineHtml(b.inline_) + u"</p>"_s; break;
        case DocBlock::List:
            out += u"<ul style=\"margin:0 0 8px\">"_s;
            for (const DocLine& item : b.items) out += u"<li>"_s + lineHtml(item) + u"</li>"_s;
            out += u"</ul>"_s;
            break;
        case DocBlock::Table:
            out += u"<table border=\"1\" cellspacing=\"0\" cellpadding=\"4\" style=\"margin:0 0 8px;border-color:#d0d0d5\"><tr>"_s;
            for (const DocLine& c : b.head) out += u"<th>"_s + lineHtml(c) + u"</th>"_s;
            out += u"</tr>"_s;
            for (const auto& row : b.rows) {
                out += u"<tr>"_s;
                for (const DocLine& c : row) out += u"<td>"_s + lineHtml(c) + u"</td>"_s;
                out += u"</tr>"_s;
            }
            out += u"</table>"_s;
            break;
        }
    }
    return out;
}

}  // namespace ibkr::shell
