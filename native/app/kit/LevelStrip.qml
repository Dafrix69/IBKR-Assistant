import QtQuick

// 价位条(lib/LevelStrip.tsx):排版在 C++(shell/level_strip,按真字体量字宽),这里照那棵 SVG 元素树画。
// layout(width) 给出元素树;宽度变了重排
Item {
    id: root
    /// function(width) → 元素树 { tag, attrs, children }
    property var layout: null
    property var tree: layout && width > 0 ? layout(Math.floor(width)) : null
    implicitHeight: tree && tree.attrs ? Number(tree.attrs.height) : 0
    height: implicitHeight
    Canvas {
        id: canvas
        anchors.fill: parent
        property var tree: root.tree
        property bool dark: Theme.dark
        onTreeChanged: requestPaint()
        onDarkChanged: requestPaint()
        function kindColor(kind, fallback) {
            return kind === "resistance" ? Theme.down : kind === "support" ? Theme.up : kind === "own" ? Theme.orange : kind === "spot" ? Theme.blue : fallback
        }
        function path(g, d) {
            var t = d.match(/[MLl]|-?[\d.]+(?:e-?\d+)?/g), cmd = "", x = 0, y = 0
            g.beginPath()
            for (var i = 0; i < t.length;) {
                if (/[MLl]/.test(t[i])) { cmd = t[i]; ++i; continue }
                var a = Number(t[i]), b = Number(t[i + 1]); i += 2
                if (cmd === "M") { x = a; y = b; g.moveTo(x, y) } else if (cmd === "L") { x = a; y = b; g.lineTo(x, y) } else { x += a; y += b; g.lineTo(x, y) }
            }
            g.stroke()
        }
        onPaint: {
            var g = getContext("2d"); g.reset()
            if (!tree || !tree.children) return
            for (var i = 0; i < tree.children.length; ++i) {
                var el = tree.children[i], a = el.attrs, cls = (a["class"] || "").split(" "), kind = cls[1] || ""
                g.globalAlpha = 1
                if (el.tag === "line") {
                    var tick = cls[0] === "lstrip-tick"
                    g.lineCap = tick ? "round" : "butt"
                    g.lineWidth = cls[0] === "lstrip-axis" ? 1 : kind === "own" ? 3 : 2
                    g.strokeStyle = cls[0] === "lstrip-axis" ? Theme.separator : kindColor(kind === "neutral" ? "" : kind, Theme.labelTertiary)
                    g.beginPath(); g.moveTo(Number(a.x1), Number(a.y1)); g.lineTo(Number(a.x2), Number(a.y2)); g.stroke()
                } else if (el.tag === "path") {
                    var lead = cls[0] === "lstrip-lead"
                    g.lineWidth = lead ? 0.8 : 1
                    g.globalAlpha = lead ? 0.8 : 1
                    g.strokeStyle = lead ? kindColor(kind === "neutral" ? "" : kind, Theme.labelTertiary) : Theme.labelTertiary
                    path(g, a.d)
                } else if (el.tag === "circle") {
                    g.fillStyle = Theme.blue; g.strokeStyle = Theme.bgElevated; g.lineWidth = 1.5
                    g.beginPath(); g.arc(Number(a.cx), Number(a.cy), Number(a.r), 0, 2 * Math.PI); g.fill(); g.stroke()
                }
            }
        }
    }
    // 标签用 Text 摆(画布认不出 macOS 的隐藏字体名,也没有 Text 清楚):文字中心对在 x 上,基线对在 y 上
    Repeater {
        model: root.tree && root.tree.children ? root.tree.children.filter(function (e) { return e.tag === "text" }) : []
        Item {
            id: label
            required property var modelData
            readonly property string kind: (modelData.attrs["class"] || "").split(" ")[1] || ""
            x: Number(modelData.attrs.x) - width / 2
            y: Number(modelData.attrs.y) - nameText.baselineOffset
            width: labelRow.width; height: labelRow.height
            Tip { text: label.modelData.children[2] ? label.modelData.children[2].text : "" }
          Row {
            id: labelRow
            spacing: 3
            Text {
                id: nameText
                text: label.modelData.children[0].text || ""
                color: label.kind === "resistance" ? Theme.downText : label.kind === "support" ? Theme.upText : label.kind === "own" ? Theme.orangeText : label.kind === "spot" ? Theme.blue : Theme.labelSecondary
                font.pixelSize: 10; font.weight: label.kind === "own" ? 600 : 500; font.family: Theme.fontFamily
            }
            Text {
                text: label.modelData.children[1].text || ""
                color: label.kind === "spot" ? Theme.blue : Theme.label
                font.pixelSize: 10; font.weight: 600; font.family: Theme.fontMono
            }
          }
        }
    }
}
