#!/usr/bin/env python3
"""重做基线的核对:把 IBKR_REBASELINE 目录里 C++ 现算的夹具,对着仓库里的旧夹具逐条归类。

用法:  python3 -I tools/rebaseline_check.py <旧夹具目录> <新夹具目录> [--show N]

只认这几种差别,别的一律算「说不清」,退出码 1,不许把新夹具拷回去:

  结构    只许 expected / out 底下变;脚本、配置、输入、用例个数一样都不许动。
  键      状态与设置里撤掉的键:policies.auto_execute / allow_live_trading / consecutive_failure_breaker、
          status.auto_execute / allow_live_trading;熔断状态里的 consecutive_failures / consecutive_parse_failures / auto。
          从旧的里删掉之后再比。
  调用    记录里熔断开关的 recordFailure / recordSuccess 两种调用(自动熔断的计数),从旧的里删掉之后再比。
  校验    旧的里 code 为 LIVE_TRADING_DISABLED 的那一条校验问题,删掉之后再比。
  追踪    closeBlockers 里撤掉的两条原因(全局自动执行未打开 / 实盘账户需要先在「设置」里允许实盘下单),删掉之后再比;
          平仓闸门不再调 engine.accountIsPaper,记录里的这一种调用删掉之后再比。
  快照    世界的每一步只在状态变了时记 snap;熔断计数删掉之后和上一份一样的 snap 从旧的里拿掉。
  文件    breaker.json 的原文只留 engaged / reason / at;和快照一样,只记变了的那几个文件。
  占位    旧夹具里值为 "__undefined__" 的键(读的时候本来就当没有),删掉之后再比。
  措辞    「自动执行已熔断(」改成「已熔断(」。

上面这些删完还不一样的用例,要在旧的那一份里找得到撤掉的那几道闸留下的痕迹,才算「行为变了」:
  自动执行  ValidatedOnly、「自动执行未打开」「自动执行没有打开」「允许自动执行」;
  实盘      LIVE_TRADING_DISABLED、「允许实盘」;
  自动熔断  「自动熔断」、recordFailure 合上了熔断("auto": true 且 engaged);
  确认框    确认凭据、purpose。
找不到痕迹的仍然算「说不清」。
"""
import json
import os
import sys

DROP_KEYS_POLICIES = {"auto_execute", "allow_live_trading", "consecutive_failure_breaker"}
DROP_KEYS_BREAKER = {"consecutive_failures", "consecutive_parse_failures", "auto"}
DROP_BLOCKERS = {"全局自动执行未打开", "实盘账户需要先在「设置」里允许实盘下单"}
MARKERS = {
    "撤掉的键": ["policies.auto_execute", "policies.allow_live_trading", "policies.consecutive_failure_breaker", "'auto_execute'"],
    "自动执行": ["ValidatedOnly", "自动执行未打开", "自动执行没有打开", "允许自动执行", "仅解析"],
    "实盘": ["LIVE_TRADING_DISABLED", "允许实盘"],
    "自动熔断": ["自动熔断", "\"auto\": true", "\"auto\":true"],
    "确认框": ["确认凭据", "purpose"],
}


def strip(v):
    """对旧值做允许的删减"""
    if isinstance(v, dict):
        out = {}
        breaker_like = "engaged" in v and "reason" in v
        for k, x in v.items():
            if x == "__undefined__":  # 夹具里 undefined 的键;重做出来的直接不写这个键,读法一样
                continue
            if k in DROP_KEYS_POLICIES:
                continue
            if breaker_like and k in DROP_KEYS_BREAKER:
                continue
            out[k] = strip(x)
        return out
    if isinstance(v, list):
        out = []
        prev_snap = None
        prev_files = {}
        for x in v:
            if isinstance(x, dict) and x.get("c") == "breaker" and x.get("m") in ("recordFailure", "recordSuccess"):
                continue
            # 托管 / 到价平仓的闸门不再问账户是不是纸面
            if isinstance(x, dict) and x.get("s") == "engine" and x.get("m") == "accountIsPaper":
                continue
            if isinstance(x, dict) and x.get("code") == "LIVE_TRADING_DISABLED":
                continue
            if isinstance(x, str) and x in DROP_BLOCKERS:
                continue
            y = None if x == "__undefined__" else strip(x)
            # 世界的每一步只在状态变了时记 snap:熔断计数不再变,删减之后和上一份一样的 snap 就不该记
            if isinstance(y, dict) and "op" in y and "snap" in y:
                if y["snap"] == prev_snap:
                    y = {k: w for k, w in y.items() if k != "snap"}
                else:
                    prev_snap = y["snap"]
            # 文件同理:只记变了的那几个
            if isinstance(y, dict) and "op" in y and isinstance(y.get("files"), dict):
                changed = {f: c for f, c in y["files"].items() if prev_files.get(f) != c}
                prev_files.update(y["files"])
                y = {k: w for k, w in y.items() if k != "files"}
                if changed:
                    y["files"] = changed
            out.append(y)
        return out
    if isinstance(v, str):
        # 熔断状态文件的原文
        if v.startswith('{"engaged":'):
            try:
                o = json.loads(v)
                return json.dumps({k: o[k] for k in ("engaged", "reason", "at") if k in o}, ensure_ascii=False, separators=(",", ":"))
            except ValueError:
                return v
        # 措辞:熔断已不只管"自动执行"
        return v.replace("自动执行已熔断(", "已熔断(")
    return v


# 用例里当输入的那几格:一个字都不许变(重做基线只会改 same() 比过的那几格期望)
INPUTS = {"name", "script", "base", "config", "settings", "now", "snapshot", "recent", "status", "statusMode", "extras", "orders", "limit",
          "args", "p", "raw", "auto", "c", "g", "sent", "cfg", "t", "text", "in", "input", "position", "values", "patch", "spec"}


def first_diff(a, b, path):
    if type(a) != type(b) or not isinstance(a, (dict, list)):
        return None if a == b else path
    if isinstance(a, dict):
        for k in list(a.keys()) + [k for k in b if k not in a]:
            if k not in a or k not in b:
                return path + [k]
            d = first_diff(a[k], b[k], path + [k])
            if d:
                return d
        return None
    if len(a) != len(b):
        return path + ["<len>"]
    for i, (x, y) in enumerate(zip(a, b)):
        d = first_diff(x, y, path + [i])
        if d:
            return d
    return None


def cases(root):
    """用例 = 根下各个列表里的每一格(scenarios[3]、cases[17]、blockers[2]……);根下别的键当一个用例"""
    for k, v in root.items():
        if isinstance(v, list):
            for i, x in enumerate(v):
                yield (k, i), x
        else:
            yield (k,), v


def main():
    old_dir, new_dir = sys.argv[1], sys.argv[2]
    show = int(sys.argv[sys.argv.index("--show") + 1]) if "--show" in sys.argv else 3
    bad = 0
    for name in sorted(os.listdir(new_dir)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(old_dir, name), encoding="utf-8") as f:
            old = json.load(f)
        with open(os.path.join(new_dir, name), encoding="utf-8") as f:
            new = json.load(f)
        structural, unexplained = [], []
        counts = {"撤掉的键": 0, "键/调用/校验/追踪": 0, "自动执行": 0, "实盘": 0, "自动熔断": 0, "确认框": 0}
        if old.keys() != new.keys():
            structural.append(["<根下的键>"])
        newcases = dict(cases(new))
        for key, o in cases(old):
            if key not in newcases:
                structural.append(list(key))
                continue
            n = newcases[key]
            if o == n:
                continue
            # 只因撤掉的键才报错的配置,现在读得进去:error 换成 out
            if isinstance(o, dict) and isinstance(n, dict) and "error" in o and "out" in n and any(k in o["error"] for k in DROP_KEYS_POLICIES):
                counts["撤掉的键"] += 1
                continue
            if isinstance(o, dict) and isinstance(n, dict):
                if o.keys() != n.keys():
                    structural.append(list(key) + ["<键>"])
                    continue
                moved = [k for k in o if k in INPUTS and o[k] != n[k]]
                if moved:
                    structural.append(list(key) + [moved[0]])
                    continue
                same_after_strip = all(strip(o[k]) == n[k] for k in o if k not in INPUTS)
            else:
                same_after_strip = strip(o) == n
            if same_after_strip:
                counts["键/调用/校验/追踪"] += 1
                continue
            text = json.dumps(o, ensure_ascii=False)
            hit = [cat for cat, words in MARKERS.items() if any(w in text for w in words)]
            if hit:
                counts[hit[0]] += 1
            else:
                unexplained.append((key, o, n))
        total = sum(counts.values()) + len(unexplained)
        print(f"{name}: 变了 {total} 条 — " + "、".join(f"{k} {v}" for k, v in counts.items() if v)
              + (f"、说不清 {len(unexplained)}" if unexplained else "") + (f";结构变了 {len(structural)} 处" if structural else ""))
        for p in structural[:show]:
            print("   结构:", p)
        for key, o, n in unexplained[:show]:
            label = o.get("name") if isinstance(o, dict) else ""
            oo = {k: v for k, v in o.items() if k not in INPUTS} if isinstance(o, dict) else o
            nn = {k: v for k, v in n.items() if k not in INPUTS} if isinstance(n, dict) else n
            d = first_diff(strip(oo), nn, list(key))
            print("   说不清:", key, label or "", "第一处:", d)
            if d and "--detail" in sys.argv:
                def at(v, p):
                    for x in p[len(key):]:
                        if x == "<len>":
                            break
                        try:
                            v = v[x]
                        except (KeyError, IndexError, TypeError):
                            return "<没有>"
                    return json.dumps(v, ensure_ascii=False)[:600]
                print("      旧:", at(strip(oo), d))
                print("      新:", at(nn, d))
        bad += len(unexplained) + len(structural)
    print("通过" if bad == 0 else f"有 {bad} 处说不清")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
