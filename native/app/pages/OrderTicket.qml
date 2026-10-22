import QtQuick
import Dafri.Kit

// 订单票据(lib/OrderTicket.tsx + graphics.css 的 .ticket):方向徽章、标的、数量 × 价、合约要素;期权再画一张到期损益图,各腿排成一行小胶囊。
// t = shell/trade_rules 的 ticketModel。间距照 CSS:.ticket 上 4 下 8;头 gap 12;trigger 上 10;legs 上 12 gap 6;payoff-wrap 上 18 下 2;hero-sub 11.5
Column {
    id: root
    property var t: ({})
    /// 数量 / 价格两块瓦片的底:平时填充色;记录详情的票据本身铺在填充底上,瓦片换卡片面(.detail-ticket .ticket-nums > span)
    property color numsFill: Theme.bgFill
    width: parent ? parent.width : 400
    topPadding: 4
    bottomPadding: 8
    Item {
        width: parent.width
        height: Math.max(badge.height, titleCol.implicitHeight, nums.implicitHeight)
        SymBadge { id: badge; symbol: root.t.badge || ""; anchors.verticalCenter: parent.verticalCenter }
        Column {
            id: titleCol
            x: badge.width + 12
            width: nums.x - x - 12
            anchors.verticalCenter: parent.verticalCenter
            Row {
                spacing: 8
                Label { text: root.t.symbol || ""; size: 20; weight: Theme.weightHeavy; family: Theme.fontDisplay; letterSpacing: -0.4; css: 1.15; anchors.verticalCenter: parent.verticalCenter }
                Pill { tint: root.t.buy ? "up" : "down"; text: root.t.sideText || ""; anchors.verticalCenter: parent.verticalCenter }
            }
            Label { text: root.t.sub || ""; size: 11.5; color: Theme.labelSecondary; tnum: true }
        }
        Row {
            id: nums
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: 8
            NumTile { big: root.t.quantity || ""; small: root.t.unit || "" }
            Label { text: "×"; size: 14; color: Theme.labelTertiary; anchors.verticalCenter: parent.verticalCenter }
            NumTile { big: root.t.price || ""; small: root.t.typeText || "" }
        }
    }
    Row {
        visible: !!root.t.trigger
        topPadding: 10
        spacing: 8
        Pill { tint: "orange"; dot: true; text: "条件单"; anchors.verticalCenter: parent.verticalCenter }
        Label { text: root.t.trigger || ""; size: 12; tnum: true; anchors.verticalCenter: parent.verticalCenter }
    }
    Flow {
        visible: !!(root.t.legPills && root.t.legPills.length)
        width: parent.width
        topPadding: 12
        spacing: 6
        Repeater {
            model: root.t.legPills || []
            Pill { required property var modelData; tint: modelData.up ? "up" : "down"; text: modelData.text }
        }
    }
    Item {
        visible: !!root.t.payoff
        width: parent.width
        // .payoff-wrap:上 18、下 2(padding 2 已含在图的高里)
        height: visible ? 18 + chart.implicitHeight + 2 : 0
        PayoffChart { id: chart; y: 18; width: parent.width; height: implicitHeight; m: root.t.payoff || null }
    }
    Label { visible: !!root.t.payoff; width: parent.width; wrap: true; text: root.t.footnote || ""; size: 11.5; color: Theme.labelSecondary; tnum: true }

    // .ticket-nums > span:竖排、内边距 6 × 12、最窄 70、瓦片圆角、填充底;大数 17px 750 正文色,小字 10.5px 二级色
    component NumTile: Rectangle {
        property string big: ""
        property string small: ""
        implicitWidth: Math.max(70, 24 + Math.max(bigL.implicitWidth, smallL.implicitWidth))
        implicitHeight: 12 + bigL.implicitHeight + smallL.implicitHeight
        radius: Theme.radiusTile
        color: root.numsFill
        Column {
            x: 12; y: 6
            Label { id: bigL; text: parent.parent.big; size: 17; weight: Theme.weightHeavy; family: Theme.fontDisplay; tnum: true; letterSpacing: -0.26 }
            Label { id: smallL; text: parent.parent.small; size: 10.5; color: Theme.labelSecondary }
        }
    }
}
