#!/usr/bin/env python3
"""handlers1 变异检验(私有副本里做,不动项目源码)。
做法:把 tracker_handlers.cpp / trading_handlers.cpp 的变异版拷到 work/mut-handlers1/,用 build-handlers1 里取出的同一条编译命令单独编成 .o,
链接测试时把它放在 libibkr_transport.a 前面(静态库里的原成员不再被拉入),跑对应的测试;测试红 = 杀掉。
用法: mutate_handlers1.py <tracker|trading> [最多个数] [种子] [并行数]
"""
import os, random, re, shlex, subprocess, sys, json, shutil
from concurrent.futures import ThreadPoolExecutor

WORK = '/Users/dafrix/Developer/ibkr/work'
BUILD = f'{WORK}/build-handlers1'
MUT = f'{WORK}/mut-handlers1'
SRC = '/Users/dafrix/Developer/ibkr/IBKR-Assistant/native/engine/transport/handlers'
which = sys.argv[1]
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 120
seed = int(sys.argv[3]) if len(sys.argv) > 3 else 1
par = int(sys.argv[4]) if len(sys.argv) > 4 else 3
fn = {'tracker': 'tracker_handlers.cpp', 'trading': 'trading_handlers.cpp', 'ordinary': 'settings_handlers.cpp'}[which]
test = f'tst_h1_{which}'
orig = open(f'{SRC}/{fn}', encoding='utf-8').read().split('\n')

SWAPS = [('&&', '||'), ('||', '&&'), (' == ', ' != '), (' != ', ' == '), (' >= ', ' > '), (' <= ', ' < '), (' > ', ' >= '), (' < ', ' <= '),
         ('true', 'false'), ('false', 'true'), ('-32602', '-32603'), ('-32019', '-32018'), ('-32018', '-32017'), ('-32005', '-32006'), ('-32003', '-32002'), ('-32004', '-32005'),
         ('co_await ', ''), ('isLong(position)', '!isLong(position)'), (' ? ', ' ? !'), ('.left(200)', '.left(199)'), ('.left(8)', '.left(7)'), ('15\'000', '14\'000'), ('waiting + 1', 'waiting')]
cands = []
for i, line in enumerate(orig):
    s = line.strip()
    if s.startswith('//') or s.startswith('///') or s.startswith('*') or not s or s.startswith('#'): continue
    for a, b in SWAPS:
        if a in line and not a.startswith('co_await'):
            cands.append((i, a, b, 'swap'))
    m = re.match(r'^(\s*)if \((.*)\) (.*)$', line)
    if m and not m.group(2).startswith('!(') :
        cands.append((i, 'IF', None, 'negate-if'))
    m2 = re.match(r'^(\s*)(if \(.*\) )?(invalid|throw) ', line)
    if m2: cands.append((i, 'DROP', None, 'drop-throw'))
random.Random(seed).shuffle(cands)
cands = cands[:limit]
if os.environ.get('HAND'):  # 手挑的变异:[[旧文本, 新文本, 说明], …],旧文本在整份源码里必须只出现一次
    cands = [(-1, a, b, 'hand') for a, b, *_ in json.load(open(os.environ['HAND']))]

def apply(c):
    i, a, b, kind = c
    if kind == 'hand':
        full = '\n'.join(orig)
        if full.count(a) != 1: return None
        return full.replace(a, b)
    lines = list(orig)
    L = lines[i]
    if kind == 'swap':
        k = L.index(a); L = L[:k] + b + L[k + len(a):]
    elif kind == 'negate-if':
        m = re.match(r'^(\s*)if \((.*)\) (.*)$', L)
        if not m: return None
        # 只处理条件括号平衡的单行 if
        cond, rest = m.group(2), m.group(3)
        depth = 0; end = None
        full = L[L.index('if (') + 4:]
        for k, ch in enumerate(full):
            if ch == '(': depth += 1
            elif ch == ')':
                if depth == 0: end = k; break
                depth -= 1
        if end is None: return None
        L = m.group(1) + 'if (!(' + full[:end] + ')) ' + full[end + 1:].lstrip()
    elif kind == 'drop-throw':
        L = re.sub(r'(invalid|throw)\s', r'(void)0; //\g<0>', L, count=1)
        if '//' not in L: return None
    lines[i] = L
    return '\n'.join(lines)

base_cmd = shlex.split(open(f'{MUT}/compile_{which}.cmd').read())
def compile_cmd(src, out):
    cmd = []; skip = 0
    for t in base_cmd:
        if skip: skip -= 1; continue
        if t in ('-MT', '-MF', '-o'): skip = 1; continue
        if t == '-MD': continue
        if t == '-c': skip = 1; continue
        cmd.append(t)
    return cmd + ['-o', out, '-c', src]
link = subprocess.run(['ninja', '-t', 'commands', test], cwd=BUILD, capture_output=True, text=True).stdout.strip().split('\n')[-1]
link = link.replace(': && ', '').replace(' && :', '')
def link_cmd(obj, exe):
    t = shlex.split(link)
    out = []
    for k, tok in enumerate(t):
        if tok == '-o': out += ['-o', exe]; continue
        if k > 0 and t[k - 1] == '-o': continue
        if tok == 'engine/libibkr_transport.a': out.append(obj)
        out.append(tok)
    return out

def run_one(idx, c):
    d = f'{MUT}/m{which}{idx}'
    os.makedirs(d, exist_ok=True)
    try:
        text = apply(c) if c else open(f'{SRC}/{fn}', encoding='utf-8').read()
        if text is None: return (idx, c, 'skip')
        src = f'{d}/{fn}'
        open(src, 'w', encoding='utf-8').write(text)
        r = subprocess.run(compile_cmd(src, f'{d}/m.o'), cwd=BUILD, capture_output=True, text=True)
        if r.returncode: return (idx, c, 'compile-error')
        r = subprocess.run(link_cmd(f'{d}/m.o', f'{d}/exe'), cwd=BUILD, capture_output=True, text=True)
        if r.returncode: return (idx, c, 'link-error')
        r = subprocess.run([f'{d}/exe'], cwd=BUILD, capture_output=True, text=True, timeout=900)
        return (idx, c, 'survived' if r.returncode == 0 else 'killed')
    finally:
        shutil.rmtree(d, ignore_errors=True)

if __name__ == '__main__':
    print(f'{which}: 候选 {len(cands)} 个', flush=True)
    base = run_one(0, None)
    print('基线(未变异):', base[2], flush=True)
    if base[2] != 'survived': sys.exit(1)
    res = []
    with ThreadPoolExecutor(par) as ex:
        for idx, c, st in ex.map(lambda a: run_one(*a), [(k + 1, c) for k, c in enumerate(cands)]):
            res.append((idx, c, st))
            if st == 'survived': print(f'  幸存 #{idx} [{c[3]}] {c[1][:70]} → {str(c[2])[:60]}' + (f':{orig[c[0]].strip()[:100]}' if c[0] >= 0 else ''), flush=True)
    from collections import Counter
    print(Counter(s for _, _, s in res))
    json.dump([[i, list(c), s] for i, c, s in res], open(f'{MUT}/result_{which}.json', 'w'), ensure_ascii=False)
