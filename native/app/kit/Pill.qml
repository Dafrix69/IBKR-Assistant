import QtQuick

// 状态胶囊(graphics.tsx 的 Pill + graphics.css 的 .pill):22 高、左右 9、全圆角,11.5px 字重 590;
// 字是着色 66% 混进正文色,底是着色 11%;可带 6px 圆点或涨跌小三角
Rectangle {
    id: root
    property string tint: "gray"
    property string text: ""
    property bool dot: false
    /// 涨跌小三角:up / down / 空
    property string tri: ""
    readonly property color tile: Theme.tintOf(tint)
    implicitWidth: row.implicitWidth + 18
    implicitHeight: 22
    radius: height / 2
    color: Theme.tint(tile, 0.11)
    Row {
        id: row
        anchors.centerIn: parent
        spacing: 5
        Rectangle { visible: root.dot; width: 6; height: 6; radius: 3; color: root.tile; anchors.verticalCenter: parent.verticalCenter }
        Canvas {
            visible: root.tri !== ""
            width: 8; height: 6
            anchors.verticalCenter: parent.verticalCenter
            property color c: label.color
            onCChanged: requestPaint()
            onPaint: {
                var g = getContext("2d"); g.reset(); g.fillStyle = c; g.beginPath()
                if (root.tri === "up") { g.moveTo(0, 6); g.lineTo(4, 0); g.lineTo(8, 6) } else { g.moveTo(0, 0); g.lineTo(4, 6); g.lineTo(8, 0) }
                g.closePath(); g.fill()
            }
        }
        Label { css: 0;
            id: label
            text: root.text
            color: Theme.mix(root.tile, Theme.label, 0.66)
            size: 11.5; weight: Theme.weightSemibold; family: Theme.fontFamily; tnum: true
            anchors.verticalCenter: parent.verticalCenter
        }
    }
}
