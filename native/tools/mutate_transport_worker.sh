#!/bin/sh
# 用法:mutate_transport_worker.sh <a|b|c|d|e|f>
# 在私有副本里跑 transport 簇的变异检验(brief 第 3 条:绝不在项目的源码上改):
#   work/mut-transport/<w>/native 是项目 native/ 的拷贝(旁边 desktop / engine-ts / docs / prompts 是符号链接),
#   work/mut-transport/<w>/build 是它自己的编译目录。
w=$1
src=/Users/dafrix/Developer/ibkr/IBKR-Assistant
base=/Users/dafrix/Developer/ibkr/work/mut-transport
mkdir -p $base/$w
rsync -a --delete --exclude .vscode --exclude build $src/native/ $base/$w/native/
for d in desktop engine-ts docs prompts; do [ -e $base/$w/$d ] || ln -s $src/$d $base/$w/$d; done
mkdir -p $base/$w/build && cd $base/$w/build
cmake -G Ninja -S $base/$w/native -B . -DCMAKE_BUILD_TYPE=Debug -DCMAKE_CXX_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang++ -DCMAKE_C_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang -DCMAKE_PREFIX_PATH=/opt/homebrew -DIBKR_BUILD_UI=OFF > cfg.log 2>&1
case $w in
  a) t="tst_rpc_server tst_rpc";;
  b) t="tst_rpc_context";;
  c) t="tst_cli";;
  d) t="tst_zod_gaps tst_contract tst_models";;
  e) t="tst_zod_gaps tst_rpc_server";;
  f) t="tst_contract tst_zod_gaps tst_rpc_context";;
esac
ninja $t > build.log 2>&1 || { echo "初始编译失败"; tail -20 build.log; exit 1; }
WORKER=$w python3 $base/$w/native/tools/mutate_transport.py > mutate.log 2>&1
