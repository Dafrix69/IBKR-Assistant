// 条款文本的小解析器:照 desktop/renderer-react/src/lib/docParse.ts 逐条搬,不用 Qt 的 Markdown。
//
// 为什么不用 Text.MarkdownText:它是 CommonMark,"盯盘。**软件没有开着……触发。**托管单"这种句号贴着 ** 的加粗它不认,
// 条款里最要紧的那几句会露出星号;Electron 版用的是这个解析器,两边画出来的得是同一份。
// 只认:# / ## / ### 标题、段落、- 列表、| 表格、行内 **加粗**。别的语法当普通文字。期望值由 node 跑原模块现算
// (tests/fixtures/gen_doc_parse.mjs)。
#pragma once

#include <QJsonArray>
#include <QList>
#include <QString>

namespace ibkr::shell {

struct DocInline {
    QString text;
    bool bold = false;
};
using DocLine = QList<DocInline>;

struct DocBlock {
    enum Kind { Heading, Paragraph, List, Table } kind = Paragraph;
    int level = 0;            // 标题:1–3
    DocLine inline_;          // 标题、段落
    QList<DocLine> items;     // 列表
    QList<DocLine> head;      // 表格
    QList<QList<DocLine>> rows;
};

DocLine parseDocInline(const QString& text);
QList<DocBlock> parseDoc(const QString& source);
/// 同 docParse.ts 的输出结构(测试对照用)
QJsonArray docBlocksToJson(const QList<DocBlock>& blocks);
/// 给 QML 的 Text.RichText:文字全部转义,只有我们自己拼的标签;样式照 shell.css 的 .plain-doc
QString docToHtml(const QList<DocBlock>& blocks);

}  // namespace ibkr::shell
