import QtQuick
import Dafri.Kit

// 顶栏下面那条常驻的「今日事件」(React 版 shell/EventStrip.tsx + styles.css 的 .event-strip / .event-item):
// 今天(或 18 小时内)要公布的数、正在集体走的板块,一直挂着,直到过期自己消失;没有事的时候整条收起。
// 每条是一枚小玻璃瓦片:状态圆点、星级、标题、何时与倒计时、预期与前值、「应对」;跨市场那条底色带红、挂 P0。
// 放不下就换行(上 4 下 6、左右 12、间距 8);「全部」靠右(margin-left: auto)。每条写什么在 C++ 算好(shell/events_store)。
Item {
    id: root
    property var store: null
    readonly property var strip: store ? store.strip : ({ hidden: true, moves: [], items: [], more: 0 })
    signal act(string id)
    signal openAll()
    signal openSectors()
    visible: !!store && !strip.hidden
    implicitHeight: visible ? flow.y + layoutHeight + 6 : 0
    property real layoutHeight: 30
    property real allX: 0
    property real allY: 0

    // 「全部」放在最后一行的右端;那一行放不下就自己起一行
    function placeAll() {
        var lastY = 0, right = 0
        for (var i = 0; i < flow.children.length; ++i) {
            var c = flow.children[i]
            if (!c.visible || c.width === 0) continue
            if (c.y > lastY) { lastY = c.y; right = 0 }
            if (c.y === lastY) right = Math.max(right, c.x + c.width)
        }
        var fits = right + 8 + allButton.width <= flow.width
        allY = fits ? lastY : lastY + 30 + 8
        allX = flow.width - allButton.width
        layoutHeight = allY + 30
    }

    Flow {
        id: flow
        x: 12; y: 4
        width: root.width - 24
        spacing: 8
        onPositioningComplete: root.placeAll()
        onWidthChanged: root.placeAll()

        Item {
            width: head.implicitWidth; height: 30
            Label { css: 0;
                id: head
                anchors.verticalCenter: parent.verticalCenter
                text: "今日事件"
                color: Theme.labelSecondary
                size: 10.5; weight: Theme.weightMedium; family: Theme.fontFamily
            }
            Tip { text: "今天要公布的重要数据,以及正在集体涨跌的板块。公布过了一阵自己消失;清单与口径在「全部」里" }
        }
        // 板块联动:点了去板块页
        Repeater {
            model: root.strip.moves
            delegate: Tile {
                id: moveTile
                readonly property var m: modelData
                dotColor: m.direction === "down" ? Theme.red : Theme.green
                Label { css: 0; text: moveTile.m.title; color: Theme.label; size: 11.5; weight: Theme.weightSemibold; family: Theme.fontFamily; anchors.verticalCenter: parent.verticalCenter }
                Label { css: 0; text: moveTile.m.meta; color: Theme.labelSecondary; size: 11.5; family: Theme.fontFamily; tnum: true; anchors.verticalCenter: parent.verticalCenter }
                tip: m.tip
                clickable: true
                onTapped: root.openSectors()
            }
        }
        Repeater {
            model: root.strip.items
            delegate: Tile {
                id: eventTile
                readonly property var e: modelData
                readonly property bool hot: e.phase === "live" || e.phase === "soon"
                cross: e.cross
                pulse: e.phase === "live" || e.cross
                dotColor: e.cross || hot ? Theme.red : e.phase === "after" || e.impact === "medium" ? Theme.labelTertiary : Theme.orange
                Rectangle {
                    visible: eventTile.e.cross
                    anchors.verticalCenter: parent.verticalCenter
                    width: p0.implicitWidth + 8; height: 16; radius: 4
                    color: Theme.red
                    Label { css: 0; id: p0; anchors.centerIn: parent; text: "P0"; color: "#ffffff"; size: 9.5; weight: Font.Bold; letterSpacing: 0.38; family: Theme.fontFamily }
                    Tip { text: "跨市场跟跌套利:美股大动而韩股 / A 股的美股 ETF 没同步,开盘会补" }
                }
                Label { css: 0;
                    visible: !eventTile.e.cross && eventTile.e.stars !== ""
                    anchors.verticalCenter: parent.verticalCenter
                    text: eventTile.e.stars
                    color: Theme.orangeText
                    size: 9.5; letterSpacing: -0.57; family: Theme.fontFamily
                    Tip { text: eventTile.e.starsTip }
                }
                Label { css: 0;
                    anchors.verticalCenter: parent.verticalCenter
                    width: Math.min(implicitWidth, 220)
                    elide: Text.ElideRight
                    text: eventTile.e.title
                    color: eventTile.hot ? Theme.orangeText : Theme.label
                    size: 11.5; weight: Theme.weightSemibold; family: Theme.fontFamily
                    Tip { text: eventTile.e.titleTip }
                }
                Label { css: 0; anchors.verticalCenter: parent.verticalCenter; text: eventTile.e.meta; color: Theme.labelSecondary; size: 11.5; family: Theme.fontFamily; tnum: true }
                Label { css: 0;
                    visible: eventTile.e.fact !== ""
                    anchors.verticalCenter: parent.verticalCenter
                    text: eventTile.e.fact
                    color: Theme.labelTertiary
                    size: 10.5; family: Theme.fontMono
                }
                // 「应对」:primary ghost(强调色的字与边、透明底),22 高
                Rectangle {
                    visible: eventTile.e.canAct
                    anchors.verticalCenter: parent.verticalCenter
                    width: actText.implicitWidth + 16; height: 22; radius: 11
                    color: actHover.hovered ? Theme.tint(Theme.blue, 0.08) : "transparent"
                    border.width: 1; border.color: Theme.blue
                    Text { id: actText; anchors.centerIn: parent; text: "应对"; color: Theme.blue; font.pixelSize: Theme.fontSmall; font.weight: Theme.weightSemibold; font.family: Theme.fontFamily }
                    HoverHandler { id: actHover }
                    TapHandler { onTapped: root.act(eventTile.e.id) }
                }
            }
        }
        Item {
            visible: root.strip.more > 0
            width: visible ? moreText.implicitWidth : 0; height: 30
            Label { css: 0; id: moreText; anchors.verticalCenter: parent.verticalCenter; text: "+" + root.strip.more; color: Theme.labelSecondary; size: 11.5; family: Theme.fontFamily }
        }
    }
    // 「全部」:默认按钮的样子,22 高 11px
    Glass {
        id: allButton
        x: flow.x + root.allX
        y: flow.y + root.allY + 4
        width: allText.implicitWidth + 16; height: 22
        radius: 11
        fill: allHover.hovered ? Theme.bgFillStrong : Theme.bgControl
        edge: Theme.edgeControl
        border: Theme.separator
        Text { id: allText; anchors.centerIn: parent; text: "全部"; color: Theme.label; font.pixelSize: Theme.fontSmall; font.weight: Theme.weightMedium; font.family: Theme.fontFamily }
        HoverHandler { id: allHover }
        TapHandler { onTapped: root.openAll() }
    }

    // 一枚瓦片:30 高、内边距 4 10 4 8、间距 7;圆点 7px
    component Tile: Glass {
        id: tile
        default property alias cells: cellRow.data
        property color dotColor: Theme.orange
        property bool cross: false
        property bool pulse: false
        property string tip: ""
        property bool clickable: false
        signal tapped()
        width: cellRow.implicitWidth + 18
        height: 30
        radius: Theme.radiusTile
        edge: Theme.edgeSmall
        fill: cross ? Theme.mix(Theme.red, Theme.glassBg, 0.10) : Theme.glassBg
        Row {
            id: cellRow
            x: 8
            height: parent.height
            spacing: 7
            Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: 7; height: 7; radius: 3.5
                color: tile.dotColor
                SequentialAnimation on opacity {
                    running: tile.pulse
                    loops: Animation.Infinite
                    NumberAnimation { from: 1; to: 0.35; duration: 600; easing.type: Easing.InOutQuad }
                    NumberAnimation { from: 0.35; to: 1; duration: 600; easing.type: Easing.InOutQuad }
                }
            }
        }
        Tip { text: tile.tip; z: -1 }
        TapHandler { enabled: tile.clickable; onTapped: tile.tapped() }
    }
}
