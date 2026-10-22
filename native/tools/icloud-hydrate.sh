#!/bin/sh
# 把 iCloud 换出去的占位文件(dataless)一轮一轮读回本地,直到一个不剩。要在沙箱外跑(终端面板):
# 沙箱里的读取触发不了 iCloud 下载,只会超时。
#   sh native/tools/icloud-hydrate.sh
cd "$(dirname "$0")/../.." || exit 1
DIRS="native engine-ts desktop/node_modules/electron prompts docs config"
round=0
while :; do
  round=$((round + 1))
  n=$(find $DIRS -type f -flags +dataless 2>/dev/null | wc -l | tr -d ' ')
  echo "$(date +%T) 第 $round 轮,剩 $n 个"
  [ "$n" -eq 0 ] && break
  find $DIRS -type f -flags +dataless -print0 2>/dev/null | xargs -0 -n2 -P8 cat >/dev/null 2>&1
  sleep 30
done
echo HYDRATE_ALL_LOCAL
