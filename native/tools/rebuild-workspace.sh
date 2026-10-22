#!/bin/sh
# 一条命令把工作区建回来(新机器、清过 build、改了 engine-ts 之后)。
#
#   sh native/tools/rebuild-workspace.sh            # 在 IBKR-Assistant 根目录或任何地方跑都行
#
# 项目在 ~/Developer/ibkr(不在 iCloud);编译目录放在它旁边的 work/,重启不丢。/tmp 开机即清空,不放任何要留的东西。
# 建出来的:
#   engine-ts/dist                       tsc 编译产物 = 对拍夹具的 oracle(直接用项目里这份,不再另做镜像)
#   ../work/native-build                 native/ 的 Debug 编译目录(含各簇 parts)
# oracle 运行时就是 desktop/node_modules 里的 Electron 41:
#   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron gen_x.mjs engine-ts
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=${IBKR_WORK_DIR:-$(cd "$ROOT/.." && pwd)/work}
mkdir -p "$W"

echo "== engine-ts 编译(oracle)"
(cd "$ROOT/engine-ts" && npx tsc)

echo "== Electron 运行时自检"
ELECTRON_RUN_AS_NODE=1 "$ROOT/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" \
  -e 'console.log("node", process.versions.node, "v8", process.versions.v8)'

echo "== native 编译"
cmake -S "$ROOT/native" -B "$W/native-build" -G Ninja -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_PREFIX_PATH=/opt/homebrew -DCMAKE_CXX_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang++ \
  -DIBKR_SKIP_PARTS="${IBKR_SKIP_PARTS:-OFF}"
cmake --build "$W/native-build" -j6
(cd "$W/native-build" && QT_QPA_PLATFORM=offscreen ctest -j6 --output-on-failure)
echo "== 完成"
