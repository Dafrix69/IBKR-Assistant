import QtQuick

// 抽屉(AntD Drawer):32% 的遮罩;右侧实底面板(默认 520 宽),左边一道投影;头 16 × 24,关闭钮在标题左边,标题 15px 字重 590;
// 正文内边距 24(在滚动区里面)、可滚。Esc 与点遮罩都关。
Item {
    id: root
    property string title: ""
    /// 标题的字(档案:20px 700 的显示字体);后面跟一小段二级色的字(「档案」)
    property real titleSize: Theme.fontLarge
    property int titleWeight: Theme.weightSemibold
    property string titleFamily: Theme.fontFamily
    property string subtitle: ""
    /// 头上右边的按钮(AntD 的 extra)
    property alias extra: extraBox.data
    property int panelWidth: 520
    /// 正文滚到哪(截图对比用)
    property alias bodyScroll: bodyFlick.contentY
    // 头:上 16、标题一行(行高 1.5714)、下 16 + 1 的分隔线
    readonly property real titleLine: titleSize * 1.5714
    readonly property real headH: 16 + titleLine + 17
    default property alias body: bodyItem.data
    /// 只在用户关掉时发(Esc、点遮罩、点关闭,都走 close());程序里直接设 visible = false 不发——
    /// 抽屉跟着 store 开关的地方(标的档案)靠这一点才不会来回打转
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
    Rectangle {
        id: panel
        anchors.right: parent.right
        width: Math.min(root.panelWidth, root.width)
        height: parent.height
        color: Theme.bgPopup
        TapHandler {}
        // 左边的投影:-6px 0 16px rgba(0,0,0,.08)
        Rectangle {
            anchors.right: parent.left
            width: 16; height: parent.height
            gradient: Gradient {
                orientation: Gradient.Horizontal
                GradientStop { position: 0; color: "transparent" }
                GradientStop { position: 1; color: Qt.rgba(0, 0, 0, Theme.dark ? 0.3 : 0.08) }
            }
        }
        Rectangle {
            x: 24; y: 16 + (root.titleLine - 23) / 2
            width: 23; height: 23; radius: 9
            color: closeHover.hovered ? Theme.bgFill : "transparent"
            Text { anchors.centerIn: parent; text: "✕"; color: Theme.labelSecondary; font.pixelSize: 14; font.family: Theme.fontFamily }
            HoverHandler { id: closeHover }
            TapHandler { onTapped: root.close() }
        }
        Label {
            id: titleLabel
            x: 55; y: 16
            text: root.title
            size: root.titleSize; weight: root.titleWeight; family: root.titleFamily; css: 1.5714
        }
        Label {
            visible: root.subtitle !== ""
            x: titleLabel.x + titleLabel.implicitWidth + 8
            anchors.baseline: titleLabel.baseline
            text: root.subtitle
            size: 12; weight: Theme.weightMedium; color: Theme.labelSecondary
        }
        Item {
            id: extraBox
            anchors.right: parent.right; anchors.rightMargin: 24
            y: 16 + (root.titleLine - height) / 2 + 0.6
            width: childrenRect.width; height: childrenRect.height
        }
        // 正文(.ant-drawer-body):内边距 24 在滚动区里面(滚起来连内边距一起走,同 AntD 的 overflow: auto)
        Flickable {
            id: bodyFlick
            y: root.headH
            width: parent.width
            height: parent.height - y
            contentHeight: 24 + bodyItem.childrenRect.height + 24
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            Item { id: bodyItem; x: 24; y: 24; width: parent.width - 48 }
        }
    }
}
