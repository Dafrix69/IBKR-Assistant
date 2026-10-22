import QtQuick

// 折行的一排(CSS 的 display: flex; flex-wrap: wrap; gap: 行距 列距):横着排、放不下换行;行与行之间、项与项之间的间距可以不一样
// (Qt 的 Flow 只有一个间距)。alignBottom = align-items: flex-end:每一行里的项按底对齐。不显示的项不占位
Item {
    id: root
    default property alias content: holder.data
    property real columnSpacing: 0
    property real rowSpacing: 0
    property bool alignBottom: false
    property real bottomPadding: 0
    implicitHeight: contentHeight + bottomPadding
    property real contentHeight: 0
    readonly property real naturalWidth: {
        var w = 0, n = 0
        for (var i = 0; i < holder.children.length; ++i) { var c = holder.children[i]; if (root.placed(c)) { w += c.implicitWidth > 0 ? c.implicitWidth : c.width; n += 1 } }
        return n ? w + (n - 1) * columnSpacing : 0
    }
    /// 占位的孩子:看得见的,不算 Repeater 自己(它是孩子里一个 0 宽的项,算进去会多出一个间距)
    function placed(c) { return c.visible && String(c).indexOf("QQuickRepeater") !== 0 }
    function relayout() {
        var kids = []
        for (var i = 0; i < holder.children.length; ++i) if (placed(holder.children[i])) kids.push(holder.children[i])
        var lines = [], line = [], x = 0
        for (var k = 0; k < kids.length; ++k) {
            var w = kids[k].width
            if (line.length && x + w > width) { lines.push(line); line = []; x = 0 }
            line.push(kids[k]); x += w + columnSpacing
        }
        if (line.length) lines.push(line)
        var y = 0
        for (var l = 0; l < lines.length; ++l) {
            var h = 0
            for (var a = 0; a < lines[l].length; ++a) h = Math.max(h, lines[l][a].height)
            var cx = 0
            for (var b = 0; b < lines[l].length; ++b) {
                var it = lines[l][b]
                it.x = cx
                it.y = y + (root.alignBottom ? h - it.height : 0)
                cx += it.width + columnSpacing
            }
            y += h + (l < lines.length - 1 ? rowSpacing : 0)
        }
        contentHeight = y
    }
    // 什么时候重排:宽、孩子的多少、每个孩子显不显示与宽高——都写进一个绑定(同 CardGrid)。
    // 不用 connect + Qt.callLater:孩子拆掉时还会发 widthChanged / visibleChanged,排进去的 relayout 落在正在销毁的上下文里,
    // AOT 编译的应用里会 abort(CardGrid 出过一次);绑定随对象一起断,拆页时什么都不会排
    readonly property var layoutKey: {
        var k = [width, columnSpacing, rowSpacing, alignBottom, holder.children.length]
        for (var i = 0; i < holder.children.length; ++i) { var c = holder.children[i]; k.push(c.visible, c.width, c.height) }
        return k
    }
    onLayoutKeyChanged: relayout()
    Item {
        id: holder
        anchors.fill: parent
    }
}
