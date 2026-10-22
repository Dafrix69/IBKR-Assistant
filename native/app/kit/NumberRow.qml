import QtQuick

// 一行数字(ui/kit 的 NumberRow):GroupRow + 右边一个 190 宽的数字框
GroupRow {
    id: root
    property var value: null
    property real min: -Infinity
    property real max: Infinity
    property real step: 1
    property string placeholder: ""
    property real fieldWidth: 190
    signal valueEdited(var value)
    InputNumber {
        width: root.fieldWidth
        min: root.min; max: root.max; step: root.step
        enabled: root.enabled
        placeholder: root.placeholder
        value: root.value
        onValueEdited: function (x) { root.valueEdited(x) }
    }
}
