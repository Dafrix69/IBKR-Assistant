// 保序的 JSON(引擎与界面共用;界面那边的 shell/ordered_json.h 只是把名字引过去):读进来的对象键按文件里的先后次序留着,写回去同 JS 的 JSON.stringify(value, null, 2)。
// 为什么不用 QJsonObject:它把键排序。settings.json 是用户手改的文件,从备份恢复、改账户之后键的次序全乱了,
// 人再打开就找不着东西;Electron 版写回去的是原来的次序。重复的键同 JSON.parse:值取后一个、位置留在第一次出现处。
// 键序就是 JS 对象的键序:像数组下标的键("0"、"7"、"10")按数值排在最前,其余按出现的先后——JSON.parse 读进来、JSON.stringify 写回去都是这样。
// set() 维持这个次序;直接往 fields 里 append 的不管(只在已知没有这种键时那样用)。
#pragma once

#include <QJsonValue>
#include <QList>
#include <QPair>
#include <QString>

#include <optional>

namespace ibkr::util {

struct OJson {
    enum Type { Null, Bool, Number, String, Array, Object } type = Null;
    bool b = false;
    double n = 0;
    QString s;
    QList<OJson> items;
    QList<QPair<QString, OJson>> fields;

    static OJson null() { return {}; }
    static OJson boolean(bool v) { OJson o; o.type = Bool; o.b = v; return o; }
    static OJson number(double v) { OJson o; o.type = Number; o.n = v; return o; }
    static OJson string(const QString& v) { OJson o; o.type = String; o.s = v; return o; }

    bool isObject() const { return type == Object; }
    bool isArray() const { return type == Array; }
    /// 对象里的一个键;没有返回空
    const OJson* get(const QString& key) const;
    OJson* get(const QString& key);
    /// 有就改值(位置不动),没有就加在最后
    void set(const QString& key, const OJson& value);
    void remove(const QString& key);

    QJsonValue toQJson() const;
    /// 同 toQJson,另在每个有两个以上键的对象里加一个 "__keys"(原文的键序):QJsonObject 把键排序,
    /// 而界面有几处照 Object.entries / Object.keys 的次序摆(回测策略的参数、扫描结果的参数组合)
    QJsonValue toQJsonKeyed() const;
    static OJson fromQJson(const QJsonValue& v);
};

/// 是不是 JS 的规范数组下标("0"、"12";不认 "01"、"-1"、≥ 2^32 − 1);是就给出数值
std::optional<quint32> jsArrayIndex(const QString& key);
/// 嵌套深度上限(数组 / 对象一层算一层)。JS 的 JSON.parse 没有上限;这里的读法与拷贝、写出都是递归的,
/// 一行几十万个 `[` 会把栈撑破(RPC 的一行输入就能做到),所以超过按「不合规」处理。引擎里没有哪份真数据靠近它
inline constexpr int kMaxJsonDepth = 1000;
/// JSON.parse;不合规返回空,error 里是哪儿不对(措辞不同于 V8 的报错原文)
std::optional<OJson> parseOJson(const QString& text, QString* error = nullptr);
/// JSON.stringify(value, null, indent);indent 0 = 紧凑。NaN / ±Infinity 写成 null
QString stringifyOJson(const OJson& value, int indent = 2);

}  // namespace ibkr::util
