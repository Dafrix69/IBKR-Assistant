#!/usr/bin/env python3
"""svc2 对拍调试:  tools/svc_diff.py <夹具名> <场景名子串> [<编好的测试程序>]
跑测试程序(SVC_DUMP=场景名)把 C++ 的 {log, steps} 落到 $TMPDIR/svc_got.json,和夹具里的期望逐项比,指出第一处不同(日志第几条、哪一步)。"""
import json, os, subprocess, sys, tempfile
fx, name = sys.argv[1], sys.argv[2]
exe = sys.argv[3] if len(sys.argv) > 3 else f"/Users/dafrix/Developer/ibkr/work/build-svc2/tests/tst_svc_{fx}"
here = os.path.dirname(os.path.abspath(__file__))
env = dict(os.environ, SVC_DUMP=name)
subprocess.run([exe], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
got = json.load(open(os.path.join(tempfile.gettempdir(), "svc_got.json")))
d = json.load(open(os.path.join(here, "..", "tests/fixtures", f"svc_{fx}.json")))
sc = next(s for s in d["scenarios"] if name == s["name"])
exp = sc["expected"]
print("场景:", sc["name"])
el, gl = exp["log"], got["log"]
for i in range(max(len(el), len(gl))):
    a = el[i] if i < len(el) else None
    b = gl[i] if i < len(gl) else None
    if a != b:
        print(f"日志第 {i} 条起不同(TS {len(el)} 条 / C++ {len(gl)} 条)")
        for j in range(max(0, i - 4), i + 5):
            ta = json.dumps(el[j], ensure_ascii=False)[:200] if j < len(el) else "-"
            tb = json.dumps(gl[j], ensure_ascii=False)[:200] if j < len(gl) else "-"
            print(f"  {j:4d} {'  ' if ta == tb else '!!'} TS  {ta}")
            if ta != tb:
                print(f"       {'  '}   C++ {tb}")
        break
else:
    print("日志相同")
es, gs = exp["steps"], got["steps"]
for i in range(max(len(es), len(gs))):
    a = es[i] if i < len(es) else None
    b = gs[i] if i < len(gs) else None
    if a != b:
        print(f"第 {i} 步起不同; 脚本里这一步:", json.dumps(sc["script"]["steps"][i], ensure_ascii=False)[:300])
        print("  TS ", json.dumps(a, ensure_ascii=False)[:600])
        print("  C++", json.dumps(b, ensure_ascii=False)[:600])
        break
else:
    print("步骤相同")
