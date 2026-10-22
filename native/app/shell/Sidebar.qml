import QtQuick
import Dafri.Kit

// 源列表侧栏(React 版 shell/Sidebar.tsx + styles.css 的 .sidebar + shell.css 的 .sidebar-menu):
// 一块浮着的玻璃面板,22 圆角;三组按"多久用一次"分层,组标题可点击折叠,「应用」组沉底。
// 项 38 高、左右各让 10、组内上下各 2;图标是 24 的瓦片里一枚 18 的强调色线稿;选中项是一枚浮起来的玻璃面、字重 650。
// 徽标是灰色胶囊(排队数不是"未读",不该喊)。窄窗口(≤1000)收成 60 宽的图标栏:组摊平,徽标换成蓝点。
Glass {
    id: root
    property var counts: ({ pending: 0, anomaly: 0, intel: 0 })
    property bool narrow: false
    radius: Theme.radiusPanel
    edge: Theme.edgePanel

    // ↑ ↓:焦点在侧栏时(点过侧栏里的一项、或 Tab 进来)按侧栏顺序上下切页,同 AntD Menu 的方向键;折叠着的组里的跳过,
    // 窄窗口组是摊平的、都算。「关于」页的快捷键表列着这一条
    activeFocusOnTab: true
    Keys.onUpPressed: step(-1)
    Keys.onDownPressed: step(1)
    function step(d) {
        var keys = Nav.groups.filter(function (g) { return root.narrow || !Nav.collapsed[g.key] })
                             .reduce(function (all, g) { return all.concat(g.items.map(function (i) { return i.key })) }, [])
        var at = keys.indexOf(Nav.current)
        if (at >= 0 && at + d >= 0 && at + d < keys.length) Nav.navigate(keys[at + d])
    }

    readonly property var topGroups: Nav.groups.filter(function (g) { return !g.bottom })
    readonly property var bottomGroups: Nav.groups.filter(function (g) { return g.bottom })

    Flickable {
        id: flick
        anchors.fill: parent
        anchors.topMargin: 8
        anchors.bottomMargin: 8
        clip: true
        contentHeight: column.implicitHeight
        boundsBehavior: Flickable.StopAtBounds
        Column {
            id: column
            width: flick.width
            Column {
                id: top
                width: parent.width
                Repeater { model: root.topGroups; delegate: Group { group: modelData; first: index === 0 } }
            }
            // 「应用」组沉底(margin-top: auto):放得下就把它推到面板底部
            Item { width: 1; height: Math.max(0, flick.height - top.implicitHeight - bottom.implicitHeight) }
            Column {
                id: bottom
                width: parent.width
                Repeater { model: root.bottomGroups; delegate: Group { group: modelData; first: false } }
            }
        }
    }

    component Group: Column {
        id: grp
        property var group
        property bool first: false
        readonly property bool open: !Nav.collapsed[group.key]
        width: parent ? parent.width : 0

        // 组标题:11px、字重 650、二级色;悬停变一级色,右侧一个会转的小箭头(悬停或收起时才出现)
        Item {
            visible: !root.narrow
            width: parent.width
            height: visible ? 22 + (grp.first ? 4 : 14) + 4 : 0
            Item {
                id: title
                x: 12; y: grp.first ? 4 : 14
                width: parent.width - 24; height: 22
                Text {
                    x: 8
                    anchors.verticalCenter: parent.verticalCenter
                    text: grp.group.title
                    color: titleHover.hovered ? Theme.label : Theme.labelSecondary
                    font.pixelSize: Theme.fontSmall; font.weight: Theme.weightBold; font.letterSpacing: 0.22
                    font.family: Theme.fontFamily
                }
                Rectangle {
                    // 只画右边与下边的 1.5px 线,转 -45°(收起,朝右)或 45°(展开,朝下)
                    width: 5; height: 5
                    anchors.right: parent.right; anchors.rightMargin: 8
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.verticalCenterOffset: grp.open ? -1 : 0
                    color: "transparent"
                    opacity: titleHover.hovered || !grp.open ? 1 : 0
                    rotation: grp.open ? 45 : -45
                    Behavior on rotation { NumberAnimation { duration: Theme.durationMid } }
                    Rectangle { anchors.right: parent.right; width: 1.5; height: parent.height; color: titleText.color }
                    Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1.5; color: titleText.color }
                }
                Text { id: titleText; visible: false; color: titleHover.hovered ? Theme.label : Theme.labelSecondary }
                HoverHandler { id: titleHover }
                TapHandler { onTapped: Nav.setGroupOpen(grp.group.key, !grp.open) }
            }
        }
        Column {
            visible: root.narrow || grp.open
            width: parent.width
            topPadding: 2
            bottomPadding: 2
            spacing: 2
            Repeater { model: grp.group.items; delegate: NavItem { item: modelData } }
        }
    }

    component NavItem: Item {
        id: it
        property var item
        readonly property bool active: Nav.current === item.key
        readonly property int count: item.badge !== "" ? (root.counts[item.badge] || 0) : 0
        x: root.narrow ? 8 : 10
        width: parent.width - 2 * x
        height: 38

        Glass {
            anchors.fill: parent
            radius: Theme.radiusControl
            edge: it.active ? Theme.edgeSmall : Theme.edgeNone
            fill: it.active ? Theme.bgControl : tap.pressed ? Theme.bgFillStrong : hover.hovered ? Theme.bgFill : "transparent"
        }
        Item {
            id: tile
            x: root.narrow ? (it.width - 24) / 2 : 7
            anchors.verticalCenter: parent.verticalCenter
            width: 24; height: 24
            Icon {
                anchors.centerIn: parent
                name: it.item.icon
                size: 18
                color: it.Window.active === false ? Theme.labelSecondary : Theme.blue
            }
        }
        Text {
            visible: !root.narrow
            x: tile.x + 24 + 10
            anchors.verticalCenter: parent.verticalCenter
            width: (badge.visible ? badge.x - 8 : it.width - 7) - x
            elide: Text.ElideRight
            text: it.item.label
            color: Theme.label
            font.pixelSize: Theme.fontBody; font.family: Theme.fontFamily
            font.weight: it.active ? Theme.weightBold : Font.Normal
        }
        // 徽标:灰色胶囊 18 高、10.5px、字重 650
        Rectangle {
            id: badge
            visible: !root.narrow && it.count > 0
            anchors.right: parent.right; anchors.rightMargin: 7
            anchors.verticalCenter: parent.verticalCenter
            height: 18; radius: 9
            width: Math.max(18, badgeText.implicitWidth + 10)
            color: Theme.bgFillStrong
            Label { css: 0;
                id: badgeText
                anchors.centerIn: parent
                text: it.count > 99 ? "99+" : String(it.count)
                color: Theme.labelSecondary
                size: 10.5; weight: Theme.weightBold; family: Theme.fontFamily
                tnum: true
            }
        }
        // 图标栏里徽标换成右上角的蓝点
        Rectangle {
            visible: root.narrow && it.count > 0
            x: parent.width - 4 - width; y: 4
            width: 6; height: 6; radius: 3
            color: Theme.blue
        }
        HoverHandler { id: hover }
        TapHandler { id: tap; onTapped: { root.forceActiveFocus(); Nav.navigate(it.item.key) } }
        Tip { text: root.narrow ? it.item.label : "" }
    }
}
