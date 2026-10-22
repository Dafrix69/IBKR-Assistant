import QtQuick

// 对话框(AntD Modal + theme/antd.ts):32% 的黑色遮罩;实底弹层(bgPopup)、20 圆角、内边距 20 × 24、卡片投影;
// 离窗口顶 100;标题 13px 字重 590;右上角 32 的关闭钮。Esc 与点遮罩都关。内容放在里面,高度按内容。
Item {
    id: root
    property string title: ""
    property int panelWidth: 520
    default property alias body: bodyItem.data
    /// 只在用户关掉时发(Esc、点遮罩、点关闭,都走 close());程序里直接设 visible = false 不发(查标的跟着 store 开关靠这一点)
    signal closed()
    anchors.fill: parent
    z: 90
    visible: false
    function open() { visible = true; forceActiveFocus() }
    function close() { visible = false; closed() }
    Keys.onEscapePressed: close()

    Rectangle {
        anchors.fill: parent
        color: Qt.rgba(0, 0, 0, 0.32)
        TapHandler { onTapped: root.close() }
    }
    Glass {
        id: panel
        x: (root.width - width) / 2
        // 离顶 100;放不下就往上挪,再放不下就缩高、正文滚动
        y: Math.max(20, Math.min(100, root.height - height - 20))
        width: Math.min(root.panelWidth, root.width - 32)
        height: Math.min(root.height - 40, head.height + 8 + bodyItem.childrenRect.height + 40)
        radius: 20
        fill: Theme.bgPopup
        edge: Theme.edgeCard
        TapHandler {}  // 面板上的点不落到遮罩
        // 标题一行(.ant-modal-title:13px 590、行高 1.5714 = 20.43,字按 CSS 的半行距摆);正文离它 8
        Label {
            id: head
            x: 24; y: 20
            width: parent.width - 48 - 24
            text: root.title
            elide: Text.ElideRight
            size: Theme.fontBody; weight: Theme.weightSemibold; css: 1.5714
        }
        Rectangle {
            x: parent.width - 8.6 - width; y: 8.6
            width: 32; height: 32; radius: 9
            color: closeHover.hovered ? Theme.bgFill : "transparent"
            Text { anchors.centerIn: parent; text: "✕"; color: Theme.labelSecondary; font.pixelSize: 13; font.family: Theme.fontFamily }
            HoverHandler { id: closeHover }
            TapHandler { onTapped: root.close() }
        }
        Flickable {
            x: 24; y: head.y + head.height + 8
            width: parent.width - 48
            height: parent.height - y - 20
            contentHeight: bodyItem.childrenRect.height
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            Item { id: bodyItem; width: parent.width }
        }
    }
}
