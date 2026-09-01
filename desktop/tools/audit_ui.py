# -*- coding: utf-8 -*-
"""界面静态审计:找那些用肉眼一页页看很容易漏、但机器一扫就出来的问题。

    python tools/audit_ui.py

查四类:
  1. 没有可访问名字的按钮(读屏软件只会念"按钮")
  2. 没有标签也没有 placeholder 的输入框
  3. app.js 引用了但 index.html 里不存在的 DOM id(点了没反应的按钮多半是这个)
  4. 界面文案里漏出来的内部枚举(BUY / LMT / Submitted 这类)

不是替代人眼看,是把人眼不擅长的那部分交给机器。
"""
import pathlib
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
root = pathlib.Path(__file__).resolve().parent.parent
html = (root / "renderer" / "index.html").read_text(encoding="utf-8")
app = (root / "renderer" / "app.js").read_text(encoding="utf-8")

problems = []

# ---- 1. 按钮的可访问名字 ----
for m in re.finditer(r"<button\b([^>]*)>(.*?)</button>", html, re.S):
    attrs, inner = m.group(1), m.group(2)
    text = re.sub(r"<[^>]+>", "", inner).strip()
    if text or "aria-label" in attrs or "title=" in attrs:
        continue
    ident = re.search(r'id="([^"]+)"', attrs)
    problems.append("无名按钮:%s" % (ident.group(1) if ident else attrs.strip()[:40]))

# ---- 2. 输入框的标签 ----
labelled = set(re.findall(r'<label[^>]*for="([^"]+)"', html))
for m in re.finditer(r"<(input|select|textarea)\b([^>]*)>", html):
    attrs = m.group(2)
    if "type=\"checkbox\"" in attrs or "type=\"radio\"" in attrs:
        continue          # 这两种在本项目里都包在 <label> 里
    ident = re.search(r'id="([^"]+)"', attrs)
    if not ident:
        continue
    if ident.group(1) in labelled or "placeholder" in attrs or "aria-label" in attrs:
        continue
    problems.append("输入框没有标签也没有 placeholder:%s" % ident.group(1))

# ---- 3. 引用了不存在的 id ----
ids = set(re.findall(r'id="([^"]+)"', html))
used = set(re.findall(r"\$\('([^']+)'\)", app)) | set(
    re.findall(r"getElementById\('([^']+)'\)", app)
)
# 运行时动态创建的不算
created = set(re.findall(r"\.id = '([^']+)'", app))
for name in sorted(used - ids - created):
    problems.append("引用了不存在的 DOM id:%s" % name)

# ---- 4. 漏到界面上的内部枚举 ----
# 只查静态 HTML 里的可见文本;动态渲染的那部分由预览台的运行时扫描覆盖。
LEAKS = ("Submitted", "PreSubmitted", "Filled", "Cancelled", "Inactive")
visible = re.sub(r"<script.*?</script>", "", html, flags=re.S)
visible = re.sub(r"<[^>]+>", " ", visible)
for token in LEAKS:
    if re.search(r"\b%s\b" % token, visible):
        problems.append("界面文案里有内部枚举:%s" % token)

if problems:
    print("发现 %d 个问题:" % len(problems))
    for p in problems:
        print("  ·", p)
    sys.exit(1)
print("界面静态审计:未发现问题")
