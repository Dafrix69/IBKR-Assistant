#include "shell/alert_tone.h"

using namespace Qt::StringLiterals;

namespace ibkr::shell::tone {

QString soundFor(const QString& direction) {
    if (direction == u"up") return u"Glass"_s;
    if (direction == u"down") return u"Submarine"_s;
    return u"Tink"_s;
}

}  // namespace ibkr::shell::tone
