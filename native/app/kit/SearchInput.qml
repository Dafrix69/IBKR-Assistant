import QtQuick

// 搜索框(AntD 6 的 Input.Search allowClear + shell.css 的补丁):输入框和右边一颗 32 方的搜索钮挨着(Space.Compact,没有 addon 那层壳)。
// 输入框:控件面、1px 发丝边、左边 12 圆角右边直角、内边距 11;有字时右边一枚清空(实心圆叉,三级色,点了清空)。
// 搜索钮:控件面、1px 边、右边整圆、控件投影、放大镜二级色。受控:text 由外面给,打字只发 edited
Item {
    id: root
    property string text: ""
    property string placeholder: ""
    /// AntD 的 small:24 高(搜索钮也是 24 方)、内边距 7
    property bool small: false
    readonly property bool focused: field.activeFocus
    readonly property real h: small ? Theme.controlHeightSmall : Theme.controlHeight
    signal edited(string text)
    /// 回车、点搜索钮、点清空(清空时是空串):同 Input.Search 的 onSearch
    signal searched(string text)
    implicitHeight: h
    implicitWidth: 200
    onTextChanged: if (field.text !== text) field.text = text
    // 焦点环(只围输入框那一截)
    Rectangle {
        x: -3.5; y: -3.5
        width: face.width + 7; height: face.height + 7
        topLeftRadius: face.topLeftRadius + 3.5; bottomLeftRadius: face.bottomLeftRadius + 3.5
        color: "transparent"
        border.width: 3.5
        border.color: Theme.tint(Theme.blue, 0.3)
        visible: field.activeFocus
    }
    Rectangle {
        id: face
        width: parent.width - button.width + 1
        height: parent.height
        topLeftRadius: Theme.radiusControl; bottomLeftRadius: Theme.radiusControl
        color: Theme.bgControl
        border.width: 1
        border.color: field.activeFocus ? Theme.blue : Theme.separator
        z: field.activeFocus ? 1 : 0
        Text {
            anchors.verticalCenter: parent.verticalCenter
            x: field.x
            visible: field.text === ""
            width: field.width
            elide: Text.ElideRight
            text: root.placeholder
            color: Theme.labelTertiary
            font: field.font
        }
        TextInput {
            id: field
            anchors.fill: parent
            anchors.leftMargin: root.small ? 7 : 11; anchors.rightMargin: (root.small ? 7 : 11) + (clear.visible ? clear.width + 4 : 0)
            verticalAlignment: TextInput.AlignVCenter
            clip: true
            selectByMouse: true
            color: Theme.label
            selectionColor: Theme.tint(Theme.blue, 0.3)
            selectedTextColor: Theme.label
            font.pixelSize: Theme.fontBody
            font.family: Theme.fontFamily
            onTextEdited: root.edited(text)
            onAccepted: root.searched(text)
        }
        Icon {
            id: clear
            visible: field.text !== ""
            anchors.right: parent.right; anchors.rightMargin: 11
            anchors.verticalCenter: parent.verticalCenter
            name: "ad-close-circle"; size: 12
            color: clearHover.hovered ? Theme.labelSecondary : Theme.labelTertiary
            HoverHandler { id: clearHover; cursorShape: Qt.PointingHandCursor }
            TapHandler { onTapped: { field.text = ""; root.edited(""); root.searched("") } }
        }
    }
    // 搜索钮的控件投影(0.5px 1px + 1px 3px,很淡)这里不画:圆角只在右边的一块,Glass 的投影是整圆角的
    Rectangle {
        id: button
        x: parent.width - width
        width: root.h; height: root.h
        topRightRadius: height / 2; bottomRightRadius: height / 2
        color: Theme.bgControl
        border.width: 1
        border.color: Theme.separator
        Icon { anchors.centerIn: parent; name: "ad-search"; size: 14; color: Theme.labelSecondary }
        TapHandler { onTapped: { field.forceActiveFocus(); root.searched(field.text) } }
    }
}
