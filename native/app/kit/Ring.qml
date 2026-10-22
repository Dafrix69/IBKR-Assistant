import QtQuick

// 环形量表(graphics.tsx 的 Ring):底环 bgFillStrong,进度环从 12 点顺时针,圆头;中间放数(13px 700)和一个小单位(9.5px 二级色)
Item {
    id: root
    property real value: 0
    property int size: 56
    property int stroke: 6
    property string tint: "blue"
    property string text: ""
    property string unit: ""
    readonly property real v: isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
    width: size; height: size
    Canvas {
        anchors.fill: parent
        property real v: root.v
        property color base: Theme.bgFillStrong
        property color fg: Theme.tintOf(root.tint)
        onVChanged: requestPaint()
        onBaseChanged: requestPaint()
        onFgChanged: requestPaint()
        onPaint: {
            var g = getContext("2d"); g.reset()
            var r = (root.size - root.stroke) / 2, c = root.size / 2
            g.lineWidth = root.stroke
            g.strokeStyle = base; g.beginPath(); g.arc(c, c, r, 0, 2 * Math.PI); g.stroke()
            if (v > 0) {
                g.strokeStyle = fg; g.lineCap = "round"; g.beginPath()
                g.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * v); g.stroke()
            }
        }
    }
    // 中间的数与单位(.ring-center:行高 1.05,竖排居中)
    Column {
        anchors.centerIn: parent
        Label { anchors.horizontalCenter: parent.horizontalCenter; text: root.text; size: 13; weight: 700; family: Theme.fontDisplay; css: 1.05; tnum: true }
        Label { visible: root.unit !== ""; anchors.horizontalCenter: parent.horizontalCenter; text: root.unit; size: 9.5; weight: 500; css: 1.05; color: Theme.labelSecondary }
    }
}
