#include "util/collate.h"

#include <QCollator>

namespace ibkr::util {

int localeCompare(const QString& a, const QString& b) {
    static const QCollator collator(QLocale(QLocale::English, QLocale::UnitedStates));
    return collator.compare(a, b);
}

}  // namespace ibkr::util
