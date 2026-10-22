import QtQuick
import QtQuick.Effects

// 一块浮起来的面:着色的面 + 投影 + 外圈 0.5px + 内圈 + 顶上一道高光(styles.css 的 --glass-edge 那一族)。
// edge 取 Theme.edgePanel / edgeSmall / edgeCard / edgeControl / edgePopup / edgeNone。内容放在里面,按面的大小摆。
Item {
    id: root
    default property alias content: inner.data
    property real radius: Theme.radiusPanel
    property color fill: Theme.glassBg
    property var edge: Theme.edgePanel
    /// 卡片还有一道 1px 的发丝边(AntD Card 的 colorBorderSecondary)
    property color border: "transparent"
    /// 发丝边的粗细(卡片 1px;记录详情那种 0.5px)
    property real borderWidth: 1
    /// 内容离面的边多远
    property real padding: 0
    readonly property alias contentItem: inner

    Repeater {
        model: root.edge.drops
        RectangularShadow {
            anchors.fill: parent
            radius: root.radius
            offset.y: modelData.y
            blur: modelData.blur
            color: modelData.color
        }
    }
    // 外圈:压在面外面半个像素
    Rectangle {
        anchors.fill: parent
        anchors.margins: -0.5
        radius: root.radius + 0.5
        color: "transparent"
        border.width: 0.5
        border.color: root.edge.ring
        visible: root.edge.ring.a > 0
    }
    Rectangle {
        anchors.fill: parent
        radius: root.radius
        color: root.fill
        border.width: root.border.a > 0 ? root.borderWidth : 0.5
        border.color: root.border.a > 0 ? root.border : root.edge.innerRing
    }
    // 顶上一道高光:只露出上沿那一截
    Item {
        visible: root.edge.highlight.a > 0
        width: parent.width
        height: Math.max(2, root.radius)
        clip: true
        Rectangle {
            width: parent.width
            height: root.height
            radius: root.radius
            color: "transparent"
            border.width: 1
            border.color: root.edge.highlight
        }
    }
    Item {
        id: inner
        anchors.fill: parent
        anchors.margins: root.padding
    }
}
