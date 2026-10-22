#!/usr/bin/env python3
"""ibwire 的反向检验:把 wire_in.cpp / codec.cpp 里点名的几处逐一改回"错的写法",重编 tst_ib_wire,看它红不红。
每一处改完都在 finally 里还原并重编(旧的二进制会给假结果)。

    python3 native/tools/mutate_ibwire.py [build 目录]             # 点名的几处;缺省 /Users/dafrix/Developer/ibkr/work/build-ibwire
    python3 native/tools/mutate_ibwire.py [build 目录] boundary [行号,…]   # wire_in.cpp 里每一道版本闸差一:>= 改 >,< 改 <=
"""
import os
import subprocess
import sys

NATIVE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = sys.argv[1] if len(sys.argv) > 1 else '/Users/dafrix/Developer/ibkr/work/build-ibwire'
MODE = sys.argv[2] if len(sys.argv) > 2 else 'named'

# (文件, 原文, 改成)。前五条:消息自带的版本格读成 NaN 时,TS 的 `if (this.version >= N) {…}` 跳过,
# 写成 `if (version < N) return;` 就会接着读(review B1)。最后一条:分帧按 Node 的 UTF-8 解码(review M1)。
MUTANTS = [
    ('engine/execution/tws/wire_in.cpp', 'if (!(version >= 11)) return;', 'if (version < 11) return;'),
    ('engine/execution/tws/wire_in.cpp', 'if (!(version >= 29)) return;', 'if (version < 29) return;'),
    ('engine/execution/tws/wire_in.cpp', 'if (!(version >= 26)) return;', 'if (version < 26) return;'),
    ('engine/execution/tws/wire_in.cpp', 'if (!(version >= 21)) return;', 'if (version < 21) return;'),
    ('engine/execution/tws/wire_in.cpp', 'if (!(version >= 16)) return;', 'if (version < 16) return;'),
    ('engine/execution/tws/codec.cpp', 'util::nodeUtf8(buffer.sliced(at + 4, size).toByteArray())', 'QString::fromUtf8(buffer.sliced(at + 4, size))'),
]


def boundary_mutants():
    # 版本(接口版本或消息自带的版本号)和常数比的每一处:差一的写法,分界上的样本(gen_ib_wire.mjs 的 boundaryCases)应该咬住
    import re
    rel = 'engine/execution/tws/wire_in.cpp'
    lines = open(os.path.join(NATIVE, rel), encoding='utf-8').read().split('\n')
    pat = re.compile(r'\b(version|sv|serverVersion\(\)|serverVersion_)\s*(>=|<)\s*(mv::k\w+|\d+)')
    out = []
    for i, line in enumerate(lines):
        code = line.split('//')[0]
        if line.strip().startswith('//'):
            continue
        for m in pat.finditer(code):
            op = '>' if m.group(2) == '>=' else '<='
            new = code[:m.start(2)] + op + code[m.end(2):] + line[len(code):]
            out.append((rel, i, new))
    return out


def build():
    r = subprocess.run(['cmake', '--build', BUILD, '--target', 'tst_ib_wire', '-j4'], capture_output=True, text=True)
    return r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]


def run():
    env = dict(os.environ, QT_QPA_PLATFORM='offscreen')
    try:
        r = subprocess.run([os.path.join(BUILD, 'tests/tst_ib_wire')], capture_output=True, text=True, timeout=300, env=env)
    except subprocess.TimeoutExpired:
        return False, ['FAIL! timeout']
    fails = [l for l in r.stdout.splitlines() if l.startswith('FAIL!')]
    return r.returncode == 0, fails


ok, log = build()
if not ok:
    sys.exit('原样编不过:\n' + log)
if not run()[0]:
    sys.exit('原样就是红的,先修好再做反向检验')
survived = 0
todo = boundary_mutants() if MODE == 'boundary' else MUTANTS
if MODE == 'boundary' and len(sys.argv) > 3:  # 只跑这几行(逗号分隔的行号)
    only = {int(x) - 1 for x in sys.argv[3].split(',')}
    todo = [m for m in todo if m[1] in only]
for rel, old, new in todo:
    path = os.path.join(NATIVE, rel)
    orig = open(path, encoding='utf-8').read()
    if isinstance(old, int):  # 按行
        lines = orig.split('\n')
        lines[old] = new
        mutated = '\n'.join(lines)
        new = f'{old + 1}: {new.strip()}'
    else:
        if orig.count(old) != 1:
            sys.exit(f'{rel}:找不到唯一的「{old}」')
        mutated = orig.replace(old, new)
    try:
        open(path, 'w', encoding='utf-8').write(mutated)
        built, log = build()
        if not built:
            print(f'编不过   {rel}: {new}\n{log}')
            continue
        passed, fails = run()
        print(('存活 !! ' if passed else '红了    ') + f'{rel}: {new}' + ('' if passed else f'  ({fails[0][:120] if fails else "crash/timeout"})'), flush=True)
        survived += passed
    finally:
        open(path, 'w', encoding='utf-8').write(orig)
        build()
print(f'{len(todo)} 处,存活 {survived}', flush=True)
sys.exit(1 if survived else 0)
