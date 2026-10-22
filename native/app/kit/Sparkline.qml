import QtQuick

// 迷你走势(React 版 ui/graphics 的 Sparkline):一根 1.6px 的圆头折线 + 最后一个点 2.2 的圆;fill 时线下面 14% 的面。上下左右留 2.5。
Canvas {
    id: root
    property var values: []
    property color tint: Theme.gray
    property bool fill: false
    implicitWidth: 64
    implicitHeight: 22
    onValuesChanged: requestPaint()
    onTintChanged: requestPaint()
    onWidthChanged: requestPaint()
    onPaint: {
        var ctx = getContext("2d")
        ctx.reset()
        var pts = (values || []).filter(function (v) { return isFinite(v) })
        if (pts.length < 2) return
        var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts)
        var span = max - min || 1
        var pad = 2.5
        function x(i) { return pad + (i / (pts.length - 1)) * (width - pad * 2) }
        function y(v) { return pad + (1 - (v - min) / span) * (height - pad * 2) }
        ctx.beginPath()
        for (var i = 0; i < pts.length; ++i) { if (i) ctx.lineTo(x(i), y(pts[i])); else ctx.moveTo(x(i), y(pts[i])) }
        if (fill) {
            ctx.save()
            ctx.lineTo(x(pts.length - 1), height); ctx.lineTo(x(0), height); ctx.closePath()
            ctx.globalAlpha = 0.14; ctx.fillStyle = tint; ctx.fill()
            ctx.restore()
            ctx.beginPath()
            for (var j = 0; j < pts.length; ++j) { if (j) ctx.lineTo(x(j), y(pts[j])); else ctx.moveTo(x(j), y(pts[j])) }
        }
        ctx.lineWidth = 1.6; ctx.lineCap = "round"; ctx.lineJoin = "round"
        ctx.strokeStyle = tint
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(x(pts.length - 1), y(pts[pts.length - 1]), 2.2, 0, Math.PI * 2)
        ctx.fillStyle = tint
        ctx.fill()
    }
}
