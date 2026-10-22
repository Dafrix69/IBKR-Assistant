#!/usr/bin/env python3
"""TS → C++ 移植的覆盖表:engine-ts/src 的每个文件,对应哪个 C++ 文件(看 C++ 头文件前三行注释里点名的 .ts)。
   python3 native/tools/port_status.py > docs/briefs/qt-port-status.md
"""
import glob, os, re, sys
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'engine-ts/src'); NAT = os.path.join(ROOT, 'native/engine')
SKIP = {'futu.ts': '富途不移植(用户 2026-10-20)', 'futuBridge.ts': '同上', 'futuBroker.ts': '同上', 'types/futu-api.d.ts': '同上',
        'rpc.ts': '只是转出的壳', 'contract/index.ts': '契约登记表:C++ 侧在 transport 的方法表里体现'}
# 头文件没写全路径、或者一个 TS 文件对应的 C++ 不在头注释里的,手写在这里
MANUAL = {'keychainChild.ts': 'util/secrets (+ ibkr-engine --keychain-child)', 'ibTypes.ts': 'execution/ib_types.h',
          'rpcError.ts': 'util/rpc_error.h'}
cited = {}
for h in glob.glob(NAT + '/**/*.h', recursive=True):
    head = ''.join(open(h, encoding='utf-8', errors='ignore').readlines()[:3])
    for ts in re.findall(r'[A-Za-z/]+\.ts', head):
        ts = ts.replace('ts/src/', '').replace('engine-ts/src/', '')
        cited.setdefault(ts, set()).add(os.path.relpath(h, NAT)[:-2])
rows = []
for p in sorted(glob.glob(SRC + '/**/*.ts', recursive=True)):
    rel = os.path.relpath(p, SRC); base = os.path.basename(rel)
    n = sum(1 for _ in open(p, errors='ignore'))
    if rel in SKIP: st, where = '跳过', SKIP[rel]
    elif rel in MANUAL: st, where = '已搬', MANUAL[rel]
    elif rel in cited or base in cited:
        st, where = '已搬', ', '.join(sorted(cited.get(rel) or cited.get(base)))
    else: st, where = '待搬', ''
    rows.append((rel, n, st, where))
tot = sum(r[1] for r in rows if r[2] != '跳过'); done = sum(r[1] for r in rows if r[2] == '已搬')
print('# Qt 重写 · TS → C++ 覆盖表\n')
print('由 `native/tools/port_status.py` 生成,不手改。"已搬"= C++ 有对应文件(头注释点名了这个 TS 文件),不等于已验收。\n')
print(f'行数:已搬 {done} / 应搬 {tot}({100*done/tot:.0f}%)。\n')
print('| TS 文件 | 行数 | 状态 | C++ |\n|---|---:|---|---|')
for r in rows: print(f'| {r[0]} | {r[1]} | {r[2]} | {r[3]} |')
