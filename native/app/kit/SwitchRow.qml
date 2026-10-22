import QtQuick

// 分组列表里的一行开关(ui/kit 的 SwitchRow + .group-row / .switch-row):上下 11、左右 16;左边名字 13px 正文色,
// 下面一行 11px 二级色的小字(上 1);右边开关(46 × 26),离字 10。整行点一下就拨开关(整行是一个 label)
Item {
    id: root
    property string label: ""
    property string sub: ""
    /// 最左一枚 28 的实心图标瓦片(同 GroupRow;.switch-row > .row-icon 右边空 4 + 间距 12)
    property string icon: ""
    property string tint: "blue"
    readonly property real lead: icon !== "" ? 28 + 4 + 12 : 0
    property bool checked: false
    /// 开关左边再放一组小控件(「试弹」「试听」),间距 8
    property alias before: beforeBox.data
    signal toggled(bool on)
    implicitHeight: 11 + Math.max(texts.implicitHeight, sw.height, lead > 0 ? 28 : 0) + 11
    Rectangle {
        visible: root.lead > 0
        x: 16; y: (root.height - 28) / 2
        width: 28; height: 28; radius: 8
        color: Theme.tintOf(root.tint)
        Icon { anchors.centerIn: parent; name: root.icon; size: 17; color: "#ffffff" }
    }
    Column {
        id: texts
        x: 16 + root.lead
        y: 11 + (root.height - 22 - implicitHeight) / 2
        width: root.width - 32 - root.lead - sw.width - 10 - (beforeBox.width > 0 ? beforeBox.width + 8 : 0)
        Label { width: parent.width; wrap: true; text: root.label; size: 13 }
        Label { visible: root.sub !== ""; width: parent.width; wrap: true; text: root.sub; size: 11; color: Theme.labelSecondary; topPadding: 1 }
    }
    Item {
        id: beforeBox
        anchors.right: sw.left; anchors.rightMargin: width > 0 ? 8 : 0
        anchors.verticalCenter: sw.verticalCenter
        width: childrenRect.width; height: childrenRect.height
    }
    Switch {
        id: sw
        anchors.right: parent.right
        anchors.rightMargin: 16
        y: 11 + (root.height - 22 - height) / 2
        checked: root.checked
        enabled: root.enabled
        // 点开关本体也由整行那一个接(不然两个都接,一下翻两次又翻回来)
        tappable: false
    }
    TapHandler { enabled: root.enabled; onPressedChanged: if (pressed) root.forceActiveFocus(); onTapped: root.toggled(!root.checked) }
}
