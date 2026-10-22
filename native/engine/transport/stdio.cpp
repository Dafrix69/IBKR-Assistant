#include "transport/stdio.h"

#include "util/post.h"

#include <cstdio>
#include <iostream>
#include <string>
#include <thread>

#ifdef Q_OS_WIN
#include <fcntl.h>
#include <io.h>
#endif

namespace ibkr::rpc {

void StdinLines::start() {
    StdinLines* self = this;
    // 线程不 join:进程退出时它多半正阻塞在读上。它只认 self,所以 self 要活到进程结束(main 里 new 出来、不删)
    std::thread([self] {
        // 按行读(fread 会一直等到读满一整块才回来,界面那头一行一行地发,不能等)。
        // 最后一行没有换行也算一行(同 Node 的 readline)
        std::string text;
        while (std::getline(std::cin, text)) {
            util::postQueued(self, [self, one = QByteArray::fromStdString(text)] { emit self->line(one); });
        }
        util::postQueued(self, [self] { emit self->eof(); });
    }).detach();
}

void prepareStdout() {
#ifdef Q_OS_WIN
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stdin), _O_BINARY);
#endif
}

void writeStdoutLine(const QByteArray& line) {
    std::fwrite(line.constData(), 1, static_cast<size_t>(line.size()), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

}  // namespace ibkr::rpc
