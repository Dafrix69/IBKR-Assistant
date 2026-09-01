# -*- coding: utf-8 -*-
"""生成一个能在浏览器里看的界面预览台。

Electron 窗口截不了图,而 UI 不看见就没法改。这里把真正的 index.html / styles.css /
app.js 原样装进来(全部内联,免得被当成快照转成 data: URL 之后外链全断),
只把 contextBridge 换成一份**假的、但形状真实**的数据源——所以看到的排版、
间距、层级和真应用完全一致。
"""
import pathlib
import sys

root = pathlib.Path(sys.argv[1])            # desktop/
out = pathlib.Path(sys.argv[2])
stub_path = pathlib.Path(sys.argv[3])       # 假 contextBridge

html = (root / "renderer" / "index.html").read_text(encoding="utf-8")
body = html.split("<body>", 1)[1].rsplit("</body>", 1)[0]
body = body.replace('<script src="app.js"></script>', "")

css = (root / "renderer" / "styles.css").read_text(encoding="utf-8")
js = (root / "renderer" / "app.js").read_text(encoding="utf-8")
stub = stub_path.read_text(encoding="utf-8")

parts = [
    '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8" />\n',
    "<title>Dafri Trading 预览台</title>\n<style>\n",
    css,
    "\n</style>\n</head>\n<body>\n<script>\n",
    stub,
    "\n</script>\n",
    body,
    "\n<script>\n",
    js,
    "\n</script>\n</body>\n</html>\n",
]
page = "".join(parts)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(page, encoding="utf-8")
print("预览台:", out.resolve().as_uri())
print("大小:", len(page), "字符")
