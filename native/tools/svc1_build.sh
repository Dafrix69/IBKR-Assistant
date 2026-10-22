#!/bin/sh
# svc1 簇的编译入口:共用 work/build-svc1,多个助手同时编会互相踩,所以全部排在一把锁后面(lockf)。
#   native/tools/svc1_build.sh tst_svc_alerts [tst_svc_anomaly …]     只编这些目标,屏蔽沙箱里 ar/ranlib 写不了缓存的噪音
#   native/tools/svc1_build.sh --run tst_svc_alerts                    编完跑一遍(ONLY=… 环境变量可以挑场景)
BUILD=/Users/dafrix/Developer/ibkr/work/build-svc1
LOCK=/Users/dafrix/Developer/ibkr/work/build-svc1.lock
RUN=0
if [ "$1" = "--run" ]; then RUN=1; shift; fi
/usr/bin/lockf -k "$LOCK" sh -c "/opt/homebrew/bin/cmake '$BUILD' >/dev/null 2>&1; /opt/homebrew/bin/ninja -C '$BUILD' $* 2>&1 | grep -v 'xcrun_db\|^ar: \|^ranlib: '"
if [ "$RUN" = "1" ]; then
  for t in "$@"; do QT_QPA_PLATFORM=offscreen "$BUILD/tests/$t" 2>&1 | grep -v '^PASS'; done
fi
