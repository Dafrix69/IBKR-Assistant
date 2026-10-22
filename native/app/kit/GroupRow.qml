import QtQuick

// 分组列表里的一行(ui/kit 的 GroupRow + .group-row):上下 11、左右 16、间距 12、竖直居中;左边名字 13px 正文色,
// 下面一行 11px 二级色的小字(上 1);右边是控件(control 那一格,不缩)。行高 = 内容 + 22;行与行之间那 1px 线由 Group 画。
//   · icon:最左一枚 28 的实心图标瓦片(.row-icon,着色底、白图标、8 圆角),右边空 2 + 间距 12;
//   · stacked:竖排(名字在上、控件在下占满一行),间距 6;控件那一格的子项自己写 width: parent.width;
//   · labelItem:名字那一格换成一个自己的组件(名字后面带胶囊、标签之类);richLabel:名字按 StyledText(带 <b>);subColor:小字的颜色
Item {
    id: root
    property string label: ""
    property string sub: ""
    property string icon: ""
    property string tint: "blue"
    property bool stacked: false
    property bool richLabel: false
    property Component labelItem: null
    property color subColor: Theme.labelSecondary
    default property alias control: box.data
    readonly property real lead: !stacked && icon !== "" ? 28 + 2 + 12 : 0
    implicitHeight: stacked ? 11 + texts.implicitHeight + (box.childrenRect.height > 0 ? 6 + box.childrenRect.height : 0) + 11
                            : 11 + Math.max(texts.implicitHeight, box.childrenRect.height, lead > 0 ? 28 : 0) + 11
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
        y: root.stacked ? 11 : 11 + (root.height - 22 - implicitHeight) / 2
        width: root.stacked ? root.width - 32 : root.width - 32 - root.lead - (box.width > 0 ? box.width + 12 : 0)
        Loader { active: !!root.labelItem; width: parent.width; sourceComponent: root.labelItem; visible: active }
        Label { visible: !root.labelItem && root.label !== ""; width: parent.width; wrap: true; text: root.label; size: 13; textFormat: root.richLabel ? Text.StyledText : Text.PlainText }
        Label {
            visible: root.sub !== ""
            width: parent.width; wrap: true; topPadding: 1
            text: root.sub
            size: 11; color: root.subColor
        }
    }
    Item {
        id: box
        x: root.stacked ? 16 : root.width - 16 - width
        y: root.stacked ? 11 + texts.implicitHeight + 6 : 11 + (root.height - 22 - height) / 2
        width: root.stacked ? root.width - 32 : childrenRect.width
        height: childrenRect.height
    }
}
