#include "util/post.h"

namespace ibkr::util {

#if IBKR_TSAN
std::mutex& tsanHandoffMutex() {
    static std::mutex handoff;
    return handoff;
}
#endif

}  // namespace ibkr::util
