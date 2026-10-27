// 期权主动成交记盘的离线报告:读 option-flow/ 两天的底账,按 quote-rule-v1 重算分类,出次日持仓量对照与各条规则占了多少张。不连券商。
#include "analysis/option_flow.h"
#include "domain/option_flow_log.h"
#include "util/jsobj.h"
#include <QCoreApplication>
#include <QCommandLineParser>
#include <QDir>
#include <QFileInfo>
#include <cstdio>
#include <map>
using namespace Qt::StringLiterals;
namespace of = ibkr::analysis::optionflow;
namespace js = ibkr::util::js;
int main(int argc, char** argv) {
    QCoreApplication app(argc,argv);
    QCommandLineParser cli;
    cli.setApplicationDescription(u"离线读取期权主动成交记盘,不连接券商。持仓量变化只检验覆盖率与开仓占比,不检验买卖方向。"_s);
    cli.addHelpOption();
    cli.addOptions({{u"dir"_s,u"记盘目录(交易库旁边的 option-flow)"_s,u"path"_s}, {u"date"_s,u"记盘那天,美东 YYYY-MM-DD"_s,u"date"_s},
        {u"next"_s,u"读次日持仓量的那天;不传取目录里 date 之后的第一个文件"_s,u"date"_s},
        {u"accuracy"_s,u"改出逐笔对照:拿 option-flow-tbt 里同一天的逐笔量记盘分类的准确率"_s},
        {u"tbt-dir"_s,u"逐笔目录;不传取 dir 旁边的 option-flow-tbt"_s,u"path"_s}});
    cli.process(app);
    if (!cli.isSet(u"dir"_s) || !cli.isSet(u"date"_s)) cli.showHelp(2);
    try {
        const ibkr::domain::OptionFlowLog log(cli.value(u"dir"_s));
        const QString date = cli.value(u"date"_s);
        QString next = cli.value(u"next"_s);
        if (next.isEmpty())
            for (const QString& d : log.dates())
                if (d > date) { next = d; break; }
        const auto day = log.read(date);
        if (day.isEmpty()) { std::fputs("这一天没有记盘\n",stderr); return 2; }
        if (cli.isSet(u"accuracy"_s)) {
            const QString tbtDir = cli.isSet(u"tbt-dir"_s) ? cli.value(u"tbt-dir"_s) : QFileInfo(cli.value(u"dir"_s)).absoluteDir().filePath(u"option-flow-tbt"_s);
            const auto tbt = ibkr::domain::OptionFlowLog(tbtDir).read(date);
            if (tbt.isEmpty()) { std::fputs("这一天没有逐笔记录\n",stderr); return 2; }
            ibkr::util::OJson acc = of::accuracy(day, tbt);
            ibkr::util::OJson errors = js::array();
            for (const auto& r : tbt) if (js::str(r.get(u"kind"_s)) == u"tbt_err") errors.items.append(r);
            acc.set(u"date"_s, js::S(date));
            acc.set(u"tbt_errors"_s, errors);
            std::puts(js::stringify(acc).toUtf8().constData());
            return 0;
        }
        ibkr::util::OJson result = of::oiCheck(day, next.isEmpty() ? QList<ibkr::util::OJson>{} : log.read(next));
        // 每条规则分到了多少张(组合单之前的原样;看 unknown 里哪一类最多)
        std::map<QString,double> byRule;
        for (const auto& r : day) if (const auto p = of::printFrom(r)) byRule[of::classify(*p).rule] += p->dv;
        ibkr::util::OJson rules = js::object();
        for (const auto& [rule, dv] : byRule) rules.set(rule, js::N(dv));
        result.set(u"date"_s, js::S(date));
        result.set(u"next"_s, next.isEmpty() ? js::Null() : js::S(next));
        result.set(u"by_rule"_s, rules);
        std::puts(js::stringify(result).toUtf8().constData());
        return 0;
    } catch (const std::exception&) {
        std::fputs("报告失败:检查目录与日期\n",stderr);
        return 2;
    }
}
