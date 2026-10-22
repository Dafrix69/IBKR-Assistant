import QtQuick

// 空态(ui/kit 的 EmptyState = AntD 的小号 Empty + .empty-state):一个淡淡的托盘图标 + 一句三级色 12px 的话,不画虚线框。
// 量的 React 版:外边距 10、内边距上 8 下 10、图 28 + 下 4、字一行 1.47 → 整块 87.6,字从 50 起;在卡片列表里(最少 72 高、居中)也是同样的高。
// topMargin / bottomMargin:和上下那块的外边距合并时(CSS margin collapsing)调小
Item {
    id: root
    property string text: ""
    property real topMargin: 10
    /// 小号(.empty-state.compact):外 4、内 4、图 22
    property bool compact: false
    readonly property real pad: compact ? 4 : 8
    readonly property real padBottom: compact ? 4 : 10
    property real bottomMargin: compact ? 4 : 10
    readonly property real imageH: compact ? 22 : 28
    implicitHeight: topMargin + pad + imageH + 4 + label.implicitHeight + padBottom + bottomMargin
    Canvas {
        anchors.horizontalCenter: parent.horizontalCenter
        y: root.topMargin + root.pad
        width: 46 * root.imageH / 28; height: root.imageH
        opacity: 0.55
        onPaint: {
            var g = getContext("2d"); g.reset()
            g.scale(width / 46, height / 28)
            g.strokeStyle = Theme.labelTertiary; g.lineWidth = 1
            g.beginPath(); g.ellipse(4, 20, 38, 7); g.stroke()
            g.beginPath(); g.moveTo(8, 22); g.lineTo(13, 8); g.lineTo(33, 8); g.lineTo(38, 22); g.stroke()
            g.beginPath(); g.moveTo(8, 22); g.lineTo(16, 22); g.lineTo(18, 25); g.lineTo(28, 25); g.lineTo(30, 22); g.lineTo(38, 22); g.stroke()
        }
    }
    Label {
        id: label
        anchors.horizontalCenter: parent.horizontalCenter
        y: root.topMargin + root.pad + root.imageH + 4
        text: root.text
        color: Theme.labelTertiary
        size: Theme.fontCaption
    }
}
