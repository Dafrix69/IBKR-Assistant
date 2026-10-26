#include "domain/terrain_log.h"
#include "util/jsobj.h"
#include "util/error.h"
#include <QCoreApplication>
#include <QCommandLineParser>
#include <QDateTime>
#include <cstdio>
#include <cmath>
using namespace Qt::StringLiterals;
int main(int argc, char** argv) {
    QCoreApplication app(argc,argv);
    QCommandLineParser cli;
    cli.setApplicationDescription(u"离线读取地形记录,不连接券商。--at 必须带 Z 或 UTC 偏移。"_s);
    cli.addHelpOption();
    cli.addOptions({{u"dir"_s,u"地形记录目录"_s,u"path"_s}, {u"date"_s,u"美东交易日期 YYYY-MM-DD"_s,u"date"_s},
        {u"at"_s,u"回放时刻 ISO 8601;不传则输出全日时间线"_s,u"time"_s},
        {u"max-age-ms"_s,u"最大观察帧龄,不是行情延迟上限"_s,u"ms"_s,u"300000"_s}});
    cli.process(app);
    if (!cli.isSet(u"dir"_s) || !cli.isSet(u"date"_s)) cli.showHelp(2);
    try {
        ibkr::domain::TerrainLog log(cli.value(u"dir"_s));
        ibkr::util::OJson result;
        if (cli.isSet(u"at"_s)) {
            const QString input = cli.value(u"at"_s);
            auto at = QDateTime::fromString(input,Qt::ISODateWithMs);
            if (!at.isValid()) at = QDateTime::fromString(input,Qt::ISODate);
            bool ok = false;
            const double age = cli.value(u"max-age-ms"_s).toDouble(&ok);
            if (!at.isValid() || at.timeSpec() == Qt::LocalTime || !ok || !std::isfinite(age) || age < 0)
                throw ibkr::util::JsError(u"--at 必须含时区,--max-age-ms 必须是非负有限数"_s);
            result = log.replay(cli.value(u"date"_s),double(at.toMSecsSinceEpoch()),age);
        } else {
            int rejected = 0;
            const auto rows = log.read(cli.value(u"date"_s),&rejected);
            result = ibkr::util::js::object({{u"records"_s,ibkr::util::js::array(rows)}, {u"rejected_records"_s,ibkr::util::js::N(rejected)}});
        }
        std::puts(ibkr::util::js::stringify(result).toUtf8().constData());
        return 0;
    } catch (const std::exception&) {
        std::fputs("地形回放失败:检查目录权限、日期、时区和最大帧龄参数\n",stderr);
        return 2;
    }
}
