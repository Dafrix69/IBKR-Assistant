#include "shell/window_state.h"

#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell {

std::optional<WindowState> loadWindowState(const QString& path, const QList<QRect>& workAreas) {
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) return std::nullopt;  // 第一次打开
    const QJsonObject o = QJsonDocument::fromJson(f.readAll()).object();
    const QJsonValue xs[] = {o.value("x"_L1), o.value("y"_L1), o.value("width"_L1), o.value("height"_L1)};
    for (const QJsonValue& v : xs)
        if (!v.isDouble() || !std::isfinite(v.toDouble())) return std::nullopt;  // 文件坏了
    const double x = xs[0].toDouble(), y = xs[1].toDouble(), w = xs[2].toDouble(), h = xs[3].toDouble();
    bool onScreen = false;
    for (const QRect& a : workAreas)
        if (x < a.x() + a.width() - 80 && x + w > a.x() + 80 && y >= a.y() - 20 && y < a.y() + a.height() - 60) onScreen = true;
    if (!onScreen) return std::nullopt;
    return WindowState{QRect(int(x), int(y), int(w), int(h)), o.value("maximized"_L1) == QJsonValue(true)};
}

void saveWindowState(const QString& path, const WindowState& state) {
    QSaveFile f(path);
    if (!f.open(QIODevice::WriteOnly)) return;
    const QRect& b = state.bounds;
    f.write(QJsonDocument(QJsonObject{{u"x"_s, b.x()}, {u"y"_s, b.y()}, {u"width"_s, b.width()}, {u"height"_s, b.height()}, {u"maximized"_s, state.maximized}})
                .toJson(QJsonDocument::Compact));
    f.commit();
}

}  // namespace ibkr::shell
