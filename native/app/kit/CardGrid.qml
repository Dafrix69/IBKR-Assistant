import QtQuick

// CSS 的 grid-template-columns: repeat(auto-fit, minmax(minWidth, 1fr))(绩效体检的结论卡片、分组表):
//   · 列数 = ⌊(宽 + 列间距) ÷ (minWidth + 列间距)⌋,至少 1;auto-fit 把空着的列收掉——项比列少(又没有跨整行的项)时按项数分;
//   · 同一行的项一样高(grid 默认 align-items: stretch),行高是这一行里最高的那一项;
//   · 子项写 property bool spanAll: true 就占整行(grid-column: 1 / -1)。只排看得见的子项
Item {
    id: root
    property real minWidth: 320
    property real columnGap: 10
    property real rowGap: 10
    property bool stretch: true
    property real contentHeight: 0
    implicitHeight: contentHeight

    function shown() {
        var out = []
        for (var i = 0; i < children.length; ++i)
            if (children[i].visible && typeof children[i].itemAt !== "function") out.push(children[i])  // Repeater 本身不算一格
        return out
    }
    function relayout() {
        var items = shown()
        var span = false
        for (var s = 0; s < items.length; ++s) if (items[s].spanAll) span = true
        var cols = Math.max(1, Math.floor((width + columnGap) / (minWidth + columnGap)))
        if (!span) cols = Math.max(1, Math.min(cols, items.length))
        var colW = (width - (cols - 1) * columnGap) / cols
        var y = 0, i = 0
        while (i < items.length) {
            var row = []
            if (items[i].spanAll) row.push(items[i++])
            else while (i < items.length && !items[i].spanAll && row.length < cols) row.push(items[i++])
            var h = 0
            for (var r = 0; r < row.length; ++r) h = Math.max(h, row[r].implicitHeight)
            for (var c = 0; c < row.length; ++c) {
                var it = row[c]
                it.x = it.spanAll ? 0 : c * (colW + columnGap)
                it.y = y
                it.width = it.spanAll ? width : colW
                if (root.stretch) it.height = h
            }
            y += h + (i < items.length ? rowGap : 0)
        }
        contentHeight = y
    }
    // 宽、每个子项看不看得见与它的自然高度一变就重排。用绑定,不用 connect + Qt.callLater:
    // 那样排进去的回调会在这一格被销毁之后才跑(切页时),上下文已经没了,进程当场 abort
    readonly property var layoutKey: {
        var k = [width, children.length]
        for (var i = 0; i < children.length; ++i) k.push(children[i].visible, children[i].implicitHeight)
        return k
    }
    onLayoutKeyChanged: relayout()
}
