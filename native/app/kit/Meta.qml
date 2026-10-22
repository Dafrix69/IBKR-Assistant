import QtQuick

// 卡片里的元数据(ui/kit 的 Meta + .card-meta):一行二级色 11.5px 的字(数字等宽),项之间横 14、竖 3,放不下就折行。
// items:[{ text, cls, title }];title 是悬停提示;cls = "tag live"(橙字 590)/ "tag paper"(二级色)/ "muted"(11px)/ "strong"(正文色 510)
// Flow 只有一个间距,这里自己排:横竖间距不一样。trailing:排在各项后面的一个控件(例如文字按钮),和各项一起折行
Item {
    id: root
    property var items: []
    property Item trailing: null
    onTrailingChanged: if (trailing) trailing.parent = root
    property real topPadding: 6
    readonly property var live: (items || []).filter(function (m) { return m !== null && m !== undefined && m !== "" && (m.text === undefined || m.text !== "") })
    visible: live.length > 0 || !!(trailing && trailing.visible)
    implicitHeight: visible ? topPadding + contentHeight : 0
    height: implicitHeight
    property real contentHeight: 0
    function relayout() {
        var x = 0, y = 0, rowH = 0
        var all = []
        for (var i = 0; i < rep.count; ++i) all.push(rep.itemAt(i))
        if (trailing && trailing.visible) all.push(trailing)
        for (var j = 0; j < all.length; ++j) {
            var it = all[j]
            if (!it) continue
            var w = Math.min(it.implicitWidth, width)
            if (x > 0 && x + w > width) { x = 0; y += rowH + 3; rowH = 0 }
            it.x = x; it.y = topPadding + y
            x += w + 14
            rowH = Math.max(rowH, it.implicitHeight)
        }
        contentHeight = y + rowH
    }
    // 什么时候重排:宽、各项与尾巴控件的自然宽高——都写进一个绑定(同 CardGrid / WrapRow)。
    // 不用 Qt.callLater:项拆掉时还会发 implicitHeightChanged,排进去的 relayout 落在正在销毁的上下文里(AOT 编译的应用会 abort)
    readonly property var layoutKey: {
        var k = [width, topPadding, rep.count]
        for (var i = 0; i < rep.count; ++i) { var it = rep.itemAt(i); if (it) k.push(it.implicitWidth, it.implicitHeight) }
        if (trailing) k.push(trailing.visible, trailing.implicitWidth, trailing.implicitHeight)
        return k
    }
    onLayoutKeyChanged: relayout()
    Repeater {
        id: rep
        model: root.live
        Label {
            required property var modelData
            readonly property string cls: modelData.cls || ""
            // 比一行还长的那一项:同 flex 项缩到一行宽、字在里面折行
            width: Math.min(implicitWidth, root.width)
            wrap: implicitWidth > root.width
            text: modelData.text !== undefined ? modelData.text : modelData
            color: cls === "tag live" ? Theme.orangeText : cls === "strong" ? Theme.label : Theme.labelSecondary
            size: cls === "muted" ? 11 : 11.5
            weight: cls === "tag live" ? Theme.weightSemibold : cls === "strong" ? Theme.weightMedium : Font.Normal
            tnum: true
            // { title }:悬停提示(时间的全写之类)。只给有提示的那几项建(Tip 里有计时器和挂在窗口根上的气泡)
            Loader {
                anchors.fill: parent
                active: !!parent.modelData.title
                sourceComponent: Tip { text: parent.parent.modelData.title }
            }
        }
    }
}
