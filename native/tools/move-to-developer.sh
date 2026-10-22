#!/bin/sh
# 把项目从 iCloud 同步的桌面搬到 ~/Developer/ibkr(不在 iCloud 里、重启不丢)。在终端里跑(沙箱外):
#   sh ~/Desktop/ibkr/IBKR-Assistant/native/tools/move-to-developer.sh
# 做的事:复制(不含 node_modules)→ 重新装依赖 → 复制 Claude 的项目记忆 → 旧目录改名成 ibkr-old(不删)。
set -eu

SRC="$HOME/Desktop/ibkr"
DST="$HOME/Developer/ibkr"

[ -d "$SRC" ] || { echo "找不到 $SRC" >&2; exit 1; }
[ -e "$DST" ] && { echo "$DST 已经存在,先看一下里面是什么再决定" >&2; exit 1; }

echo "== 1/5 检查源码是否都已下载到本地(node_modules 除外,之后重装)"
left=$(find "$SRC" -type f -flags +dataless -not -path '*/node_modules/*' | wc -l | tr -d ' ')
if [ "$left" -ne 0 ]; then
  find "$SRC" -type f -flags +dataless -not -path '*/node_modules/*' | head -20
  echo "还有 $left 个文件只在 iCloud 上,先跑 sh $SRC/IBKR-Assistant/native/tools/icloud-hydrate.sh" >&2
  exit 1
fi

echo "== 2/5 复制到 $DST(不含 node_modules)"
mkdir -p "$HOME/Developer"
rsync -a --exclude node_modules "$SRC/" "$DST/"

echo "== 3/5 重装依赖(按 package-lock 原样装)"
(cd "$DST/IBKR-Assistant/engine-ts" && npm ci)
(cd "$DST/IBKR-Assistant/desktop" && npm ci)

echo "== 4/5 复制 Claude 的项目记忆与会话记录"
OLDP="$HOME/.claude/projects/-Users-$(whoami)-Desktop-ibkr"
NEWP="$HOME/.claude/projects/-Users-$(whoami)-Developer-ibkr"
if [ -d "$OLDP" ] && [ ! -e "$NEWP" ]; then cp -R "$OLDP" "$NEWP"; fi

echo "== 5/5 旧目录改名,免得还有东西往里写"
mv "$SRC" "$HOME/Desktop/ibkr-old"

echo "完成。新位置:$DST。旧的在 ~/Desktop/ibkr-old,确认新位置一切正常后再自己删。"
