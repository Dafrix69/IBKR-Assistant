// 浮点感知的 JSON 解析与 Python 风格序列化(engine-ts/src/pyjson.ts 逐句搬)。
// 提示词指纹 = sha256(system + "\n--\n" + json.dumps(fewshot, sort_keys=True, ensure_ascii=False)):Python 把 "7520.0" 读成 float、
// dumps 回 "7520.0",JSON.parse 会丢掉这个区别。这里自带解析器,数带着"是不是 float"的记号。
// 解析的宽松处照原样(\u 后面读不出十六进制得到 U+0000、未知的转义字母原样留下、结尾的垃圾不管)。期望值:tests/fixtures/gen_pyjson.mjs
#pragma once

#include "util/ordered_json.h"

#include <QJsonValue>
#include <QString>

#include <utility>
#include <vector>

namespace ibkr::util {

struct JVal {
    enum Kind { Null, Bool, Int, Float, Str, Arr, Obj } kind = Null;
    bool boolean = false;
    QString text;    // Int:原文;Str:内容
    double number = 0;  // Float
    std::vector<JVal> items;
    std::vector<std::pair<QString, JVal>> entries;
};

/// 读不出时抛 JsError,话同 TS 版
JVal parseJson(const QString& text);
/// 丢掉 float 记号,给业务侧用
QJsonValue toPlain(const JVal& v);
/// 同上,落成保序的 OJson(JS 对象的键序:像下标的键在前;QJsonObject 会按字母排,发给模型的少样本要原样的次序)
OJson toPlainOJson(const JVal& v);
/// json.dumps(v, ensure_ascii=False):保持键序,分隔符 ", " 与 ": "
QString pyDumps(const JVal& v);
/// json.dumps(v, ensure_ascii=False, sort_keys=True)
QString pyDumpsSorted(const JVal& v);

}  // namespace ibkr::util
