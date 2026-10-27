#include "fatal_dialogs.h"

#include "desktop_shell.h"
#include "platform.h"
#include "shell/alerter.h"
#include "shell/config_guard.h"
#include "shell/engine_supervisor.h"
#include "shell/fatal_line.h"
#include "shell/log_file.h"
#include "shell/store_guard.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QMessageBox>
#include <QPushButton>
#include <QTimer>

using namespace Qt::StringLiterals;

namespace ibkr::app {

namespace {

/// 一个对话框、几个按钮(第一个是默认、最后一个是取消),返回点了哪个的文字;关掉对话框算最后一个
QString ask(QMessageBox::Icon icon, const QString& title, const QString& message, const QString& detail, const QStringList& buttons) {
    QMessageBox box(icon, title, message);
    box.setInformativeText(detail);
    QList<QAbstractButton*> made;
    for (qsizetype i = 0; i < buttons.size(); ++i) {
        QPushButton* b = box.addButton(buttons[i], i == buttons.size() - 1 ? QMessageBox::RejectRole : QMessageBox::AcceptRole);
        made.append(b);
        if (i == 0) box.setDefaultButton(b);
    }
    box.setEscapeButton(made.last());
    box.exec();
    const qsizetype at = made.indexOf(box.clickedButton());
    return at < 0 ? buttons.last() : buttons[at];
}

}  // namespace

FatalDialogs::FatalDialogs(shell::EngineSupervisor* supervisor, shell::LogFile* log, shell::Alerter* alerter, DesktopShell* desktop, QString configPath, QObject* parent)
    : QObject(parent), supervisor_(supervisor), log_(log), alerter_(alerter), desktop_(desktop), configPath_(std::move(configPath)) {}

void FatalDialogs::onEngineExited(const shell::EngineExit& info) {
    if (desktop_ && desktop_->quitting()) return;
    if (info.code == shell::config::kExitConfig) {
        const auto line = shell::configFatalLine(info.detail);
        // 对话框是个内层事件循环:放到下一拍再弹,别压在引擎退出的回调里
        const QString kind = line ? line->kind : u"invalid"_s, message = line ? line->message : u"配置文件读不进来"_s;
        QTimer::singleShot(0, this, [this, kind, message] { handleConfig(kind, message); });
    } else if (info.code == shell::store::kExitStore) {
        const auto line = shell::storeFatalLine(info.detail);
        const QString kind = line ? line->kind : u"corrupt"_s, message = line ? line->message : u"交易库打不开"_s;
        const QString db = line && line->dbPath ? *line->dbPath : QString();
        QTimer::singleShot(0, this, [this, kind, message, db] { handleStore(kind, message, db); });
    }
}

void FatalDialogs::handleConfig(const QString& kind, const QString& message) {
    if (configOpen_ || (desktop_ && desktop_->quitting())) return;
    configOpen_ = true;
    const QString RESTORE = u"恢复上一份可用的配置"_s, REVEAL = u"打开配置文件所在位置"_s, RETRY = u"我改好了,重试"_s, QUIT = u"退出"_s;
    static const QHash<QString, QString> whys{{u"missing"_s, u"配置文件不见了"_s}, {u"syntax"_s, u"配置文件的格式坏了"_s}, {u"invalid"_s, u"配置文件里有一项不合规"_s}};
    const QString why = whys.value(kind, u"配置文件读不进来"_s);
    for (;;) {
        const shell::config::Inspection state = shell::config::inspect(configPath_);
        const bool canRestore = state.backupUsable && !state.sameAsCurrent;
        QStringList buttons;
        if (canRestore) buttons << RESTORE;
        buttons << REVEAL << RETRY << QUIT;
        const QString note = canRestore
            ? u"\n\n上一份可用的配置备份于 %1。现在这份会改名留在旁边,不会删。"_s
                  .arg(state.backupAt ? QDateTime::fromMSecsSinceEpoch(qint64(*state.backupAt)).toString(u"yyyy/M/d HH:mm:ss"_s) : QString())
            : u"\n\n没有可以恢复的备份(还没有从界面改过设置)。请打开配置文件修正,或对照 settings.example.json 重写。"_s;
        const QString choice = ask(QMessageBox::Warning, u"配置文件有问题"_s, u"%1,交易引擎没有启动"_s.arg(why),
                                   u"%1\n\n文件:%2\n引擎没有启动期间,持仓追踪的止盈止损不在盯盘。%3"_s.arg(message, configPath_, note), buttons);
        if (choice == REVEAL) {
            platform::revealFile(configPath_);
            continue;  // 对话框再出来一次:改完了好点「重试」
        }
        if (choice == RESTORE) {
            QString error;
            const auto done = shell::config::restoreBackup(configPath_, double(QDateTime::currentMSecsSinceEpoch()), &error);
            if (!done) {
                log_->error(u"[config] 恢复配置失败:"_s + error);
                QMessageBox::critical(nullptr, u"恢复失败"_s, error);
                continue;
            }
            log_->warn(u"[config] 已从备份恢复配置,原文件 %1"_s.arg(done->brokenCopy));
            alerter_->systemNotify(u"已恢复上一份可用的配置"_s, QString());
        }
        configOpen_ = false;
        if (choice == QUIT) {
            QCoreApplication::quit();
            return;
        }
        supervisor_->startAgain();
        return;
    }
}

void FatalDialogs::handleStore(const QString& kind, const QString& message, const QString& dbPath) {
    if (storeOpen_ || (desktop_ && desktop_->quitting())) return;
    storeOpen_ = true;
    const QString RESTORE = u"用最近的备份恢复"_s, REVEAL = u"打开数据所在位置"_s, RETRY = u"重试"_s, QUIT = u"退出"_s;
    static const QHash<QString, QString> whys{{u"newer"_s, u"交易库是更新版本的软件写的"_s},
                                              {u"corrupt"_s, u"交易库文件损坏了"_s},
                                              {u"locked"_s, u"交易库被另一个程序占着"_s},
                                              {u"unwritable"_s, u"交易库所在的位置写不进去"_s}};
    const QString why = whys.value(kind, u"交易库打不开"_s);
    for (;;) {
        const QList<shell::store::Backup> backups = dbPath.isEmpty() ? QList<shell::store::Backup>() : shell::store::listBackups(dbPath);
        // 只有库本身坏了才谈得上恢复:被占着、写不进去、版本太新,换一份库解决不了
        const bool canRestore = kind == u"corrupt" && !backups.isEmpty();
        QStringList buttons;
        if (canRestore) buttons << RESTORE;
        if (!dbPath.isEmpty()) buttons << REVEAL;
        buttons << RETRY << QUIT;
        const QString note = canRestore ? u"\n\n最近的备份:%1(共 %2 份)。恢复后,这份备份之后的记录不在库里;坏掉的那份会改名留在旁边,不会删。"_s
                                              .arg(shell::store::describeBackup(backups.first()))
                                              .arg(backups.size())
                             : kind == u"corrupt" ? u"\n\n没有找到可以恢复的备份。"_s
                                                  : QString();
        const QString choice = ask(QMessageBox::Critical, u"交易库打不开"_s, u"%1,交易引擎没有启动"_s.arg(why),
                                   u"%1\n\n%2引擎没有启动期间,持仓追踪的止盈止损不在盯盘。%3"_s.arg(message, dbPath.isEmpty() ? QString() : u"文件:%1\n"_s.arg(dbPath), note),
                                   buttons);
        if (choice == REVEAL) {
            platform::revealFile(dbPath);
            continue;
        }
        if (choice == RESTORE) {
            QString error;
            const auto done = shell::store::restoreBackup(dbPath, backups.first().name, double(QDateTime::currentMSecsSinceEpoch()), &error, u"corrupt"_s);
            if (!done) {
                log_->error(u"[backup] 恢复交易库失败:"_s + error);
                QMessageBox::critical(nullptr, u"恢复失败"_s, error);
                continue;
            }
            log_->warn(u"[backup] 已从备份恢复交易库(原库打不开):%1,原库 %2"_s.arg(done->restored, done->kept));
            alerter_->systemNotify(u"交易库已恢复"_s, u"已恢复到 %1。"_s.arg(shell::store::describeBackup(backups.first())));
        }
        storeOpen_ = false;
        if (choice == QUIT) {
            QCoreApplication::quit();
            return;
        }
        supervisor_->startAgain();
        return;
    }
}

}  // namespace ibkr::app
