"""生成回测基线:baseline/bars_fixture.json + baseline/run_0.json。

bar fixture 只在文件不存在时生成——fixture 一旦落盘就是"固定的历史数据",
之后重跑本脚本只会基于既有 fixture 重算 run_0.json。
"""
from __future__ import annotations

import json
from pathlib import Path

from baseline_lib import BARS_FIXTURE, BASELINE_FILE, compute_baseline, generate_fixture_bars


def main() -> None:
    Path(BARS_FIXTURE).parent.mkdir(parents=True, exist_ok=True)
    if not BARS_FIXTURE.exists():
        bars = generate_fixture_bars()
        BARS_FIXTURE.write_text(
            json.dumps(bars, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        print("已生成 bar fixture:%s(%d 根)" % (BARS_FIXTURE, len(bars)))
    else:
        print("bar fixture 已存在,不再生成:%s" % BARS_FIXTURE)

    baseline = compute_baseline()
    BASELINE_FILE.write_text(
        json.dumps(baseline, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8"
    )
    print("已写入基线:%s" % BASELINE_FILE)


if __name__ == "__main__":
    main()
