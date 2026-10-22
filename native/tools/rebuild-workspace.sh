#!/bin/sh
# 一条命令把工作区建回来(新机器、清过 build 之后)。
#
#   sh native/tools/rebuild-workspace.sh            # 在 IBKR-Assistant 根目录或任何地方跑都行
#
# 项目在 ~/Developer/ibkr(不在 iCloud);编译目录放在它旁边的 work/,重启不丢。/tmp 开机即清空,不放任何要留的东西。
# 建出来的:
#   ../work/native-build                 native/ 的 Debug 编译目录(含各簇 parts)
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=${IBKR_WORK_DIR:-$(cd "$ROOT/.." && pwd)/work}
mkdir -p "$W"

echo "== native 编译"
cmake -S "$ROOT/native" -B "$W/native-build" -G Ninja -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_PREFIX_PATH=/opt/homebrew -DCMAKE_CXX_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang++ \
  -DIBKR_SKIP_PARTS="${IBKR_SKIP_PARTS:-OFF}"
cmake --build "$W/native-build" -j6
(cd "$W/native-build" && QT_QPA_PLATFORM=offscreen ctest -j6 --output-on-failure)
echo "== 完成"
