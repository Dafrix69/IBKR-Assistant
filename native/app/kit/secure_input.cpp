#include "secure_input.h"

#if defined(Q_OS_MACOS)
#include <Carbon/Carbon.h>
#endif

namespace ibkr::kit {

namespace {
void systemSecure(bool on) {
#if defined(Q_OS_MACOS)
    if (on) EnableSecureEventInput();
    else DisableSecureEventInput();
#else
    Q_UNUSED(on);
#endif
}
}  // namespace

SecureInput::~SecureInput() {
    while (depth_ > 0) {
        systemSecure(false);
        --depth_;
    }
}

void SecureInput::focus(bool on) {
    if (on) {
        systemSecure(true);
        ++depth_;
    } else if (depth_ > 0) {  // 只关自己开过的:没开过就关会把别人的计数减掉
        systemSecure(false);
        --depth_;
    }
}

}  // namespace ibkr::kit
