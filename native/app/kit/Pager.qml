import QtQuick

// 表下面的分页(AntD Pagination size="small",表里的那种靠右、上下 16):上一页 ‹、页码、下一页 ›,各 24 见方、间距 4(量的:li 的右边距 4),页码 11.5px;
// 当前页强调色的字与 1px 强调色边、字重 590;中间省掉的是「•••」(悬停变成 « / »,点了跳五页);showSize 时最后带一个「10 条/页」的下拉(只摆着)。
// items:页码与 "prev" / "next"(两段省略),由模型算好(shell/backtest_rules 的 pagerItems,同 AntD)
Item {
    id: root
    property var items: []
    property int current: 1
    property int pages: 1
    property bool showSize: false
    /// 每页几条(大小下拉里摆着的那一项)
    property int pageSize: 10
    signal picked(int page)
    implicitWidth: row.implicitWidth
    implicitHeight: 24
    Row {
        id: row
        spacing: 4
        PagerButton { icon: "ad-left"; enabled: root.current > 1; onTapped: root.picked(root.current - 1) }
        Repeater {
            model: root.items
            Item {
                required property var modelData
                readonly property bool jump: typeof modelData === "string"
                readonly property bool active: modelData === root.current
                width: Math.max(24, pageText.implicitWidth + 12); height: 24
                Rectangle {
                    anchors.fill: parent
                    radius: 6
                    color: !parent.jump && !parent.active && pageHover.hovered ? Theme.bgFill : "transparent"
                    border.width: parent.active ? 1 : 0
                    border.color: Theme.blue
                }
                Label {
                    id: pageText
                    anchors.centerIn: parent
                    text: parent.jump ? (pageHover.hovered ? (parent.modelData === "prev" ? "«" : "»") : "•••") : String(parent.modelData)
                    size: 11.5; tnum: true
                    weight: parent.active ? Theme.weightSemibold : Font.Normal
                    color: parent.active || (parent.jump && pageHover.hovered) ? Theme.blue : parent.jump ? Theme.labelTertiary : Theme.label
                }
                HoverHandler { id: pageHover; cursorShape: Qt.PointingHandCursor }
                TapHandler {
                    onTapped: {
                        if (!parent.jump) root.picked(parent.modelData)
                        else root.picked(parent.modelData === "prev" ? Math.max(1, root.current - 5) : Math.min(root.pages, root.current + 5))
                    }
                }
            }
        }
        PagerButton { icon: "ad-right"; enabled: root.current < root.pages; onTapped: root.picked(root.current + 1) }
        Select {
            visible: root.showSize
            anchors.verticalCenter: parent.verticalCenter
            height: 24
            width: 90
            options: [{ value: 10, label: "10 条/页" }, { value: 20, label: "20 条/页" }, { value: 50, label: "50 条/页" }, { value: 100, label: "100 条/页" }]
            value: root.pageSize
        }
    }

    component PagerButton: Item {
        id: pb
        property string icon: ""
        signal tapped()
        width: 24; height: 24
        Rectangle { anchors.fill: parent; radius: 6; color: pb.enabled && pbHover.hovered ? Theme.bgFill : "transparent" }
        Icon { anchors.centerIn: parent; name: pb.icon; size: 12; color: pb.enabled ? Theme.label : Theme.labelTertiary }
        HoverHandler { id: pbHover; cursorShape: pb.enabled ? Qt.PointingHandCursor : Qt.ForbiddenCursor }
        TapHandler { enabled: pb.enabled; onTapped: pb.tapped() }
    }
}
