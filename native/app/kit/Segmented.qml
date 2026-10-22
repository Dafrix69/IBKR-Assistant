import QtQuick

// 分段选择(AntD Segmented + theme/antd.ts):填充色的轨道、2px 内边距、整圆;选中的那一格是控件面 + 控件投影,字重 510。
// 默认 30 高 12px 字、左右 11(AntD 的 controlPaddingHorizontal − 1;量的接入页:项宽 = 字宽 + 22);small 26 高、同样 12px 字、左右 7(量的 React 版:项宽 = 字宽 + 14);选中的 510,没选中的正常字重。
// 字色:选中没选中都是正文色(theme/antd.ts 的 itemColor / itemSelectedColor 都是 label);悬停填充底;拦住的(disabled)三级色、点不动。
// 一项可以带 count:字后面空 5 的一个数,70% 不透明、等宽数字(交易记录筛选条每档的条数,.ant-segmented .n)
Rectangle {
    id: root
    property var options: []          // [{ value, label, disabled?, count? }] 或字符串
    property var value
    property bool small: false
    /// 字号:默认 12;放在 11px 的 label 里时跟着它(蝴蝶测算的字段)
    property real fontSize: Theme.fontCaption
    /// 没选中的项的字色:默认正文色;放在二级色的 label 里时跟着它(蝴蝶测算的字段,.fly-row label)
    property color itemColor: Theme.label
    signal activated(var value)
    implicitHeight: small ? 26 : 30
    implicitWidth: row.implicitWidth + 4
    radius: height / 2
    color: Theme.bgFill
    Row {
        id: row
        x: 2; y: 2
        height: parent.height - 4
        Repeater {
            model: root.options
            delegate: Item {
                readonly property var optValue: typeof modelData === "object" ? modelData.value : modelData
                readonly property string optLabel: typeof modelData === "object" ? modelData.label : String(modelData)
                readonly property bool selected: optValue === root.value
                readonly property bool disabled: typeof modelData === "object" && !!modelData.disabled
                readonly property bool counted: typeof modelData === "object" && modelData.count !== undefined && modelData.count !== null
                height: row.height
                width: labelRow.implicitWidth + (root.small ? 14 : 22)
                Rectangle {
                    anchors.fill: parent
                    radius: height / 2
                    visible: !parent.selected && !parent.disabled && hover.hovered
                    color: Theme.bgFill
                }
                Glass {
                    anchors.fill: parent
                    visible: parent.selected
                    radius: height / 2
                    fill: Theme.bgControl
                    edge: Theme.edgeControl
                }
                Row {
                    id: labelRow
                    anchors.centerIn: parent
                    spacing: 5
                    // AntD 的项字是一个 22(small)/ 26 高的行框,字在行框里竖直居中
                    Label {
                        id: text
                        css: root.small ? 22 : 26
                        text: labelRow.parent.optLabel
                        size: root.fontSize
                        weight: labelRow.parent.selected ? Theme.weightMedium : Font.Normal
                        color: labelRow.parent.disabled ? Theme.labelTertiary : labelRow.parent.selected ? Theme.label : root.itemColor
                    }
                    Label {
                        visible: labelRow.parent.counted
                        css: text.css
                        text: labelRow.parent.counted ? String(modelData.count) : ""
                        opacity: 0.7
                        size: root.fontSize
                        weight: text.weight
                        tnum: true
                        color: text.color
                    }
                }
                HoverHandler { id: hover; cursorShape: parent.disabled ? Qt.ForbiddenCursor : Qt.ArrowCursor }
                TapHandler {
                    enabled: !parent.disabled
                    onPressedChanged: if (pressed) root.forceActiveFocus()
                    onTapped: root.activated(parent.optValue)
                }
            }
        }
    }
}
