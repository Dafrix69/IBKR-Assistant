import QtQuick

// 内嵌分组列表(ui/kit 的 Group + .group.ant-list):卡片面 + 1px 发丝边 + 卡片影、20 圆角;下面空 14(由调用的地方的间距给)。
// 子项是一行一行的 GroupRow / SwitchRow / NumberRow,行与行之间一条 1px 发丝线(带说明时最后一行与说明之间也有一条);
// hint:说明脚注(.ant-list-footer:8 / 16 / 10、11px 二级色、行高 1.55)
Card {
    id: root
    padding: 0
    default property alias rows: col.data
    property string hint: ""
    implicitHeight: 1 + col.implicitHeight + (hint !== "" ? 1 + 8 + footer.implicitHeight : 0) + 1
    Column {
        id: col
        x: 1; y: 1
        width: root.width - 2
        spacing: 1
    }
    // 最后一个真正排出来的行(Repeater 本身、藏起来的、零高的都不算;Column 也不排它们)。读 implicitHeight 是为了行的显隐、高矮一变就重算
    readonly property int lastRow: {
        var h = col.implicitHeight, last = -1
        for (var i = 0; i < col.children.length; ++i) {
            var c = col.children[i]
            if (c.visible && c.height > 0 && c.width > 0) last = i
        }
        return last
    }
    // 行与行之间的发丝线:画在每一行的下沿(最后一行在没有说明时不画)
    Repeater {
        model: col.children.length
        Rectangle {
            required property int index
            readonly property Item row: col.children[index] || null
            visible: !!row && row.visible && row.height > 0 && row.width > 0 && (index < root.lastRow || root.hint !== "")
            x: 1; width: root.width - 2; height: 1
            y: row ? 1 + row.y + row.height : 0
            color: Theme.separator
        }
    }
    Label {
        id: footer
        visible: root.hint !== ""
        x: 17; y: 1 + col.implicitHeight + 1 + 8
        width: root.width - 34
        wrap: true
        text: root.hint
        size: 11; css: 1.55; color: Theme.labelSecondary
        // 上 8(在 y 里)、下 10
        bottomPadding: 10
    }
}
