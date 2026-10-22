import QtQuick

// 价位轨(graphics.tsx 的 PriceRail):几个价位落在同一根横轴上;viewBox 600 × 62,宽最多 720 按比例缩放。
// 现价是一颗带白边的蓝点,别的是 3.5 × 16 的竖条;标签上下交错摆,贴边的往里靠。marks:[{ key, price, label, kind }]
Item {
    id: root
    property var marks: []
    property int digits: 2
    readonly property var live: (marks || []).filter(function (m) { return typeof m.price === "number" && isFinite(m.price) })
    readonly property real scaleK: width / 600
    visible: live.length >= 2
    implicitHeight: visible ? Math.min(width, 720) * 62 / 600 : 0
    height: implicitHeight
    function railTint(kind) {
        return kind === "stop" ? Theme.down : kind === "target" ? Theme.up : kind === "cost" ? Theme.labelSecondary : kind === "now" ? Theme.blue : Theme.orange
    }
    Canvas {
        id: canvas
        width: Math.min(root.width, 720)
        height: root.implicitHeight
        property var marks: root.live
        property bool dark: Theme.dark
        onMarksChanged: requestPaint()
        onDarkChanged: requestPaint()
        onWidthChanged: requestPaint()
        onPaint: {
            var g = getContext("2d"); g.reset()
            var k = width / 600; g.scale(k, k)
            var W = 600, H = 62, padX = 34, axisY = 31
            var live = marks
            if (live.length < 2) return
            var prices = live.map(function (m) { return m.price })
            var min = Math.min.apply(null, prices), max = Math.max.apply(null, prices)
            var span = max - min || Math.abs(max) * 0.01 || 1
            function x(p) { return padX + ((p - min) / span) * (W - padX * 2) }
            g.lineCap = "round"; g.lineWidth = 6; g.strokeStyle = Theme.bgFillStrong
            g.beginPath(); g.moveTo(padX - 14, axisY); g.lineTo(W - padX + 14, axisY); g.stroke()
            var sorted = live.slice().sort(function (a, b) { return a.price - b.price })
            for (var i = 0; i < sorted.length; ++i) {
                var m = sorted[i], cx = x(m.price), above = i % 2 === 0, color = root.railTint(m.kind)
                if (m.kind === "now") {
                    g.globalAlpha = 0.18; g.fillStyle = Theme.blue; g.beginPath(); g.arc(cx, axisY, 9, 0, 2 * Math.PI); g.fill()
                    g.globalAlpha = 1; g.beginPath(); g.arc(cx, axisY, 5.5, 0, 2 * Math.PI); g.fill()
                    g.lineWidth = 2; g.strokeStyle = "#ffffff"; g.stroke()
                } else {
                    g.fillStyle = color; g.beginPath(); g.roundedRect(cx - 1.75, axisY - 8, 3.5, 16, 1.75, 1.75); g.fill()
                }
            }
        }
    }
    // 标签:上下交错、贴边的往里靠;字号随缩放(viewBox 里是 11)
    Repeater {
        model: root.live.slice().sort(function (a, b) { return a.price - b.price })
        Row {
            id: lab
            required property var modelData
            required property int index
            readonly property real k: canvas.width / 600
            readonly property real cx: {
                var prices = root.live.map(function (m) { return m.price })
                var min = Math.min.apply(null, prices), max = Math.max.apply(null, prices)
                var span = max - min || Math.abs(max) * 0.01 || 1
                return 34 + ((modelData.price - min) / span) * (600 - 68)
            }
            readonly property string anchor: cx < 34 + 30 ? "start" : cx > 600 - 34 - 30 ? "end" : "middle"
            readonly property real tx: anchor === "start" ? cx - 6 : anchor === "end" ? cx + 6 : cx
            x: (anchor === "start" ? tx : anchor === "end" ? tx - width / k : tx - width / k / 2) * k
            y: ((index % 2 === 0) ? 11 : 62 - 3) * k - labelText.baselineOffset
            spacing: 5 * k
            Text {
                id: labelText
                text: lab.modelData.label
                color: lab.modelData.kind === "cost" ? Theme.labelSecondary : root.railTint(lab.modelData.kind)
                font.pointSize: Theme.px(11 * lab.k); font.weight: 600; font.family: Theme.fontFamily
            }
            Text {
                text: Number(lab.modelData.price).toFixed(root.digits)
                color: Theme.label
                font.pointSize: Theme.px(11 * lab.k); font.weight: 600; font.family: Theme.fontMono
            }
        }
    }
}
