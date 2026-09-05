"""对拍脚本:重算基线并与 baseline/run_0.json 逐字段比对。

有任何差异 → 打印 diff 并以非零码退出。这是每个改造阶段的验收闸门之一:
改动之后回测/校验/追踪的每一个数字都必须和改动之前逐字节一致。
"""
from __future__ import annotations

import json
import sys
from typing import Any, List

from baseline_lib import BASELINE_FILE, compute_baseline

_MAX_DIFFS = 50


def _diff(path: str, expected: Any, actual: Any, out: List[str]) -> None:
    if len(out) >= _MAX_DIFFS:
        return
    if type(expected) is not type(actual):
        out.append("%s: 类型 %s != %s(基线 %r,现值 %r)"
                   % (path, type(expected).__name__, type(actual).__name__, expected, actual))
        return
    if isinstance(expected, dict):
        for key in sorted(set(expected) | set(actual)):
            if key not in expected:
                out.append("%s.%s: 基线中不存在,现值 %r" % (path, key, actual[key]))
            elif key not in actual:
                out.append("%s.%s: 现值中缺失,基线 %r" % (path, key, expected[key]))
            else:
                _diff("%s.%s" % (path, key), expected[key], actual[key], out)
        return
    if isinstance(expected, list):
        if len(expected) != len(actual):
            out.append("%s: 长度 %d != %d" % (path, len(expected), len(actual)))
        for i, (e, a) in enumerate(zip(expected, actual)):
            _diff("%s[%d]" % (path, i), e, a, out)
        return
    # 标量:float 经 JSON 往返无损,直接判等即可做到逐字节
    if expected != actual or repr(expected) != repr(actual):
        out.append("%s: 基线 %r != 现值 %r" % (path, expected, actual))


def main() -> int:
    if not BASELINE_FILE.exists():
        print("缺少 %s,先运行 scripts/make_baseline.py" % BASELINE_FILE)
        return 2
    expected = json.loads(BASELINE_FILE.read_text(encoding="utf-8"))
    actual = compute_baseline()

    diffs: List[str] = []
    _diff("$", expected, actual, diffs)
    if diffs:
        print("基线比对失败,共 %d+ 处差异(最多显示 %d 条):" % (len(diffs), _MAX_DIFFS))
        for line in diffs:
            print("  " + line)
        return 1
    print("基线比对通过:回测/校验/追踪输出与 run_0.json 逐字段一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
