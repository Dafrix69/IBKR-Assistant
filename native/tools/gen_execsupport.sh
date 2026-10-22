#!/bin/sh
# 重生成 execsupport 簇的全部夹具(原 TS 模块现跑,运行时 = 打包应用的 Electron 41)。
# 用法:native/tools/gen_execsupport.sh [--check]    --check:每个生成器跑两次,逐字节比,不一样就报错(夹具必须可复现)
# 改过 engine-ts 先 `cd engine-ts && npx tsc`(生成器 import 的是 dist)。
set -e
root=$(cd "$(dirname "$0")/../.." && pwd)
electron="$root/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
fixtures="$root/native/tests/fixtures"
for name in qualify_gate ib_link account_feeds auto_mid ib_bars held_streams option_marks; do
    ELECTRON_RUN_AS_NODE=1 "$electron" "$fixtures/gen_$name.mjs" "$root/engine-ts"
    if [ "$1" = "--check" ]; then
        first=$(shasum "$fixtures/$name.json" | cut -d' ' -f1)
        ELECTRON_RUN_AS_NODE=1 "$electron" "$fixtures/gen_$name.mjs" "$root/engine-ts" > /dev/null
        second=$(shasum "$fixtures/$name.json" | cut -d' ' -f1)
        [ "$first" = "$second" ] || { echo "$name.json 两次生成不一样" >&2; exit 1; }
    fi
done
