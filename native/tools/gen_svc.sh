#!/bin/sh
# 跑 svc2 簇的对拍夹具生成器:  native/tools/gen_svc.sh fillsync [brokerlink ...]   (缺省:svc2 簇自己的那几个。别的簇的生成器、夹具不碰)
# 用打包应用的运行时 Electron(Node 24)跑 tests/fixtures/gen_svc_<名>.mjs;跑两遍比对逐字节相同
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ELECTRON="$ROOT/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
names="$*"
[ -z "$names" ] && names="fillsync brokerlink marketdata trades events intel pool assignment ivrecorder flyplanner ideasemantic"
for n in $names; do
  [ -f "$HERE/tests/fixtures/gen_svc_$n.mjs" ] || continue   # 还没写的跳过
  out="$HERE/tests/fixtures/svc_$n.json"
  ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$HERE/tests/fixtures/gen_svc_$n.mjs" "$ROOT/engine-ts" || exit 1
  if [ -n "$TWICE" ]; then a="$(md5 -q "$out")"; ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$HERE/tests/fixtures/gen_svc_$n.mjs" "$ROOT/engine-ts" >/dev/null || exit 1; b="$(md5 -q "$out")"; [ "$a" = "$b" ] && echo "  两遍逐字节相同" || { echo "  两遍不同!"; exit 1; }; fi
done
