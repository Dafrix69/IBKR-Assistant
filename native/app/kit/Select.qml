import QtQuick
import QtQuick.Templates as T

// 下拉选择(AntD Select,默认大小):控件面、发丝边、12 圆角,右边一个小 V;点开在下面列出选项,选中的那一项浅蓝底。
// options:[{ value, label }]。受控:value 只由外面给,选了只发 activated(自己赋值会冲掉外面的绑定)。
// 列表放在窗口的浮层里(T.Popup):画在所有兄弟项之上,点击也先到它——放在自己子项里的话,后面排的控件会盖住它、抢走点击
Item {
    id: root
    property var options: []
    property var value
    /// variant="borderless" + size="small"(盯单行上的步长):没有底和边,11.5px 二级色,16 高,宽跟着字(右边留给小 V)
    property bool borderless: false
    /// size="small"(绩效体检的页头):24 高、9 圆角、字前 8(内边距 7 + 1 的边)
    property bool small: false
    /// 没选中任何一项时的占位字(三级色,同 AntD 的 placeholder)
    property string placeholder: ""
    signal activated(var value)
    implicitHeight: borderless ? 16 : small ? 24 : Theme.controlHeight
    // borderless 量的:字前 8(小号的内边距 7 + 1 的透明边)、字后 28.4(内边距 + 小 V)
    implicitWidth: borderless ? 8 + valueText.implicitWidth + 28.4 : 160
    readonly property var current: (options || []).filter(function (o) { return o.value === root.value })[0]
    Rectangle {
        visible: !root.borderless
        anchors.fill: parent
        radius: root.small ? 9 : Theme.radiusControl
        color: root.enabled ? Theme.bgControl : Theme.bgFill
        border.width: 1
        border.color: popup.visible ? Theme.blue : Theme.separator
    }
    Text {
        id: valueText
        x: root.borderless || root.small ? 8 : 12  // 1 的边 + 11 的内边距(小号是 7)
        width: root.borderless ? implicitWidth : parent.width - x - 22
        anchors.verticalCenter: parent.verticalCenter
        // 值不在选项里:AntD 原样显示这个值;没有值才是占位字
        readonly property bool hasValue: root.value !== undefined && root.value !== null && root.value !== ""
        text: root.current ? root.current.label : hasValue ? String(root.value) : root.placeholder
        elide: Text.ElideRight
        textFormat: Text.PlainText  // 选项字可能来自引擎或用户起的名字(「IRA<旧>」):不当标签解析
        color: !root.enabled || !hasValue ? Theme.labelTertiary : root.borderless ? Theme.labelSecondary : Theme.label
        font.pixelSize: root.borderless ? 11.5 : Theme.fontBody; font.family: Theme.fontFamily
    }
    Text {
        anchors.right: parent.right; anchors.rightMargin: root.borderless ? 8 : 11
        anchors.verticalCenter: parent.verticalCenter
        text: "⌄"; color: Theme.labelTertiary; font.pixelSize: 12
    }
    // 按下就把焦点拿过来:输入框先失焦、先跑完它的 editingFinished(打完的数夹好、发出去),点击才执行——同浏览器里按下按钮先让输入框失焦
    TapHandler { enabled: root.enabled; onPressedChanged: if (pressed) root.forceActiveFocus(); onTapped: popup.visible ? popup.close() : popup.open() }
    T.Popup {
        id: popup
        y: root.height + 4
        width: Math.max(root.width, root.borderless ? 80 : 0)
        padding: 4
        // AntD 的列表最高 256、超出滚动(候选能有 200 笔);打开时把选中的那一项滚进来
        implicitHeight: Math.min(list.contentHeight, 256) + 8
        onOpened: {
            const i = (root.options || []).findIndex(function (o) { return o.value === root.value })
            if (i >= 0) list.positionViewAtIndex(i, ListView.Contain)
        }
        closePolicy: T.Popup.CloseOnEscape | T.Popup.CloseOnPressOutsideParent
        background: Rectangle {
            radius: Theme.radiusControl
            color: Theme.bgPopup
            border.width: 1
            border.color: Theme.separator
        }
        contentItem: ListView {
            id: list
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            implicitHeight: contentHeight
            model: root.options
            delegate: Rectangle {
                    required property var modelData
                    width: list.width; height: 30; radius: 8
                    color: modelData.value === root.value ? Theme.tint(Theme.blue, 0.12) : hover.hovered ? Theme.bgFill : "transparent"
                    Text {
                        x: 8; width: parent.width - 16; anchors.verticalCenter: parent.verticalCenter
                        elide: Text.ElideRight; textFormat: Text.PlainText
                        text: modelData.label; color: Theme.label
                        font.pixelSize: Theme.fontBody; font.family: Theme.fontFamily
                        font.weight: modelData.value === root.value ? Theme.weightSemibold : Font.Normal
                    }
                    HoverHandler { id: hover }
                    TapHandler { onTapped: { popup.close(); root.activated(modelData.value) } }
            }
        }
    }
}
