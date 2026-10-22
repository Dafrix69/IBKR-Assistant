import QtQuick

// 一组按数据摆的行(设置页的执行闸门、风控限额、保护规则、风险预算、重要事件):每一行 { kind: switch | number | segment, key, icon, tint,
// label, sub, checked | value | (options, selected), min, max, step, placeholder, disabled },放进 Group 里。
// 模型只放键:每改一格页面模型都会整份重建,对象数组当 Repeater 的模型会把所有行连同正在打字的框一起换掉
// (敲「1500」只剩「1」);键不变行就不动,行里的值按 index 现读
Repeater {
    id: list
    property var rows: []
    /// 某一行改了:开关是 bool、数字框是数或 null、分段是选中的值
    signal edited(string key, string kind, var value)
    model: (list.rows || []).map(function (r) { return r.key })
    delegate: Loader {
        id: cell
        required property int index
        readonly property var row: (list.rows || [])[index] || ({})
        width: parent ? parent.width : 0
        sourceComponent: cell.row.kind === "switch" ? switchRow : cell.row.kind === "segment" ? segmentRow : numberRow
        Component {
            id: switchRow
            SwitchRow {
                icon: cell.row.icon || ""; tint: cell.row.tint || "blue"
                label: cell.row.label || ""; sub: cell.row.sub || ""
                checked: !!cell.row.checked
                enabled: !cell.row.disabled
                onToggled: function (on) { list.edited(cell.row.key, "switch", on) }
            }
        }
        Component {
            id: numberRow
            NumberRow {
                icon: cell.row.icon || ""; tint: cell.row.tint || "blue"
                label: cell.row.label || ""; sub: cell.row.sub || ""
                min: cell.row.min === undefined ? -Infinity : cell.row.min
                max: cell.row.max === undefined ? Infinity : cell.row.max
                step: cell.row.step === undefined ? 1 : cell.row.step
                placeholder: cell.row.placeholder || ""
                value: cell.row.value === undefined ? null : cell.row.value
                enabled: !cell.row.disabled
                onValueEdited: function (v) { list.edited(cell.row.key, "number", v) }
            }
        }
        Component {
            id: segmentRow
            GroupRow {
                icon: cell.row.icon || ""; tint: cell.row.tint || "blue"
                label: cell.row.label || ""; sub: cell.row.sub || ""
                Segmented {
                    small: true
                    options: cell.row.options || []
                    value: cell.row.selected
                    onActivated: function (v) { list.edited(cell.row.key, "segment", v) }
                }
            }
        }
    }
}
