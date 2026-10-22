import QtQuick
import Dafri.Kit

// 订单看板(pages/Board.tsx):四个小组件、「排队等待触发」与「已提交 / 近期」两列、下方是通知流。
// 模型在 C++(shell/order_rules,经 shell/board_controller);进页即读,停留期间 15 秒一轮
ScrollPage {
    id: page
    property var controller: null
    readonly property var m: controller ? controller.model : ({})
    Component.onCompleted: if (controller) controller.setVisible(true)
    Component.onDestruction: if (controller) controller.setVisible(false)

    PageHead {
        width: parent.width
        title: "订单看板"
        Button { small: true; kind: "text"; text: "刷新"; onClicked: if (page.controller) page.controller.refresh() }
    }
    // .widget-row:auto-fit minmax(170px, 1fr)、间距 12、上 2 下 6(上 2 和页头的下 14 合并成 14,已在页头里)
    Grid {
        id: widgets
        width: parent.width
        topPadding: 0; bottomPadding: 6
        spacing: 12
        columns: Math.max(1, Math.min(4, Math.floor((width + 12) / (170 + 12))))
        readonly property real cell: (width - (columns - 1) * 12) / columns
        Repeater {
            model: page.m.widgets || []
            Widget { required property var modelData; width: widgets.cell; icon: modelData.icon; tint: modelData.tint; value: String(modelData.value); label: modelData.label }
        }
    }
    // .board-grid:两列、间距 20;窄于 980 叠成一列
    Grid {
        id: grid
        width: parent.width
        columns: page.width < 980 + 56 ? 1 : 2
        columnSpacing: 20
        rowSpacing: 20
        readonly property real colW: columns === 1 ? width : (width - 20) / 2
        Column {
            width: grid.colW
            SectionTitle { text: "排队等待触发"; count: page.m.pending ? page.m.pending.count : 0 }
            Column {
                width: parent.width
                spacing: 8
                EmptyState { visible: !!(page.m.pending && page.m.pending.empty); width: parent.width; topMargin: 0; text: page.m.pending ? (page.m.pending.empty || "") : "" }
                Repeater {
                    model: page.m.pending && page.m.pending.cards ? page.m.pending.cards : []
                    OrderCard {
                        required property var modelData
                        width: parent.width
                        badge: modelData.badge; badgeTint: "orange"; title: modelData.title; meta: modelData.meta
                        tailFirst: true
                        // 触发条件(.trigger-chip:26 高、左右 12、整圆、填充底;标的、比较符、数三样间距 6;数 14px 750;比较符摆给人看要用数学符号)
                        Rectangle {
                            height: 26; radius: 13
                            width: chipRow.implicitWidth + 24
                            color: Theme.bgFill
                            Row {
                                id: chipRow
                                x: 12; anchors.verticalCenter: parent.verticalCenter
                                spacing: 6
                                Label { visible: text !== ""; text: modelData.triggerSymbol; size: 13; weight: 700; family: Theme.fontDisplay; tnum: true; anchors.baseline: valueL.baseline }
                                Label { visible: text !== ""; text: modelData.triggerOp; size: 13; weight: 700; family: Theme.fontDisplay; tnum: true; anchors.baseline: valueL.baseline }
                                Label { id: valueL; text: modelData.triggerValue; size: 14; weight: Theme.weightHeavy; family: Theme.fontDisplay; tnum: true }
                            }
                        }
                        stages: ["排队", "触发", "提交", "成交"]; stageCurrent: 0; stageTone: Theme.orange
                    }
                }
            }
        }
        Column {
            width: grid.colW
            SectionTitle { text: "已提交 / 近期"; count: page.m.live ? page.m.live.count : 0 }
            Column {
                width: parent.width
                spacing: 8
                EmptyState { visible: !!(page.m.live && page.m.live.empty); width: parent.width; topMargin: 0; text: page.m.live ? (page.m.live.empty || "") : "" }
                Repeater {
                    model: page.m.live && page.m.live.cards ? page.m.live.cards : []
                    OrderCard {
                        required property var modelData
                        width: parent.width
                        badge: modelData.badge; badgeTint: modelData.badgeTint; title: modelData.title
                        meta: modelData.strong ? modelData.meta.concat([{ text: modelData.strong, cls: "strong" }]) : modelData.meta
                        side: modelData.side || null
                        stages: ["校验", "提交", "成交"]; stageCurrent: modelData.stageCurrent; stageTone: Theme.tintOf(modelData.tint)
                        Pill { dot: true; tint: modelData.tint; text: modelData.status }
                    }
                }
            }
        }
    }
    SectionTitle { text: "通知" }
    Feed { width: parent.width; model: page.m.feed ? page.m.feed.items : []; empty: "暂无通知" }

    // 订单卡(.order-card-head / -main / -title / -foot):徽章 + 标题 13.5px 650 一行省略 + 元数据,右边买卖;
    // 下面(上 12、0.5px 分隔线、再 10)左边阶段路径、右边一个尾巴(条件单是触发条件,记录是状态胶囊)
    component OrderCard: StatusCard {
        id: card
        property string badge: ""
        property string badgeTint: "blue"
        property string title: ""
        property var meta: []
        property var side: null
        property var stages: []
        property int stageCurrent: 0
        property color stageTone: Theme.blue
        /// 尾巴排在阶段路径前面(条件单:触发条件在左、路径在右;记录:路径在左、状态在右)
        property bool tailFirst: false
        default property alias tail: tailBox.data
        Item {
            width: parent.width
            height: Math.max(sym.height, mainCol.implicitHeight)
            SymBadge { id: sym; symbol: card.badge; anchors.verticalCenter: parent.verticalCenter }
            Column {
                id: mainCol
                x: sym.width + 12
                width: parent.width - x - (sidePill.visible ? sidePill.width + 12 : 0)
                anchors.verticalCenter: parent.verticalCenter
                Label { width: parent.width; text: card.title; size: 13.5; weight: Theme.weightBold; letterSpacing: -0.135; elide: Text.ElideRight }
                Meta { width: parent.width; items: card.meta }
            }
            Pill {
                id: sidePill
                visible: !!card.side
                anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                tint: card.side && card.side.buy ? "up" : "down"; tri: card.side && card.side.buy ? "up" : "down"
                text: card.side ? card.side.text : ""
            }
        }
        Item { width: 1; height: 12 }
        Rectangle { width: parent.width; height: 0.5; color: Theme.separator }
        Item {
            width: parent.width
            height: 10 + Math.max(path.implicitHeight, tailBox.height)
            StagePath {
                id: path
                x: card.tailFirst ? parent.width - implicitWidth : 0
                y: 10 + (parent.height - 10 - implicitHeight) / 2
                stages: card.stages; current: card.stageCurrent; tone: card.stageTone
            }
            Item {
                id: tailBox
                x: card.tailFirst ? 0 : parent.width - width
                y: 10 + (parent.height - 10 - height) / 2
                width: childrenRect.width; height: childrenRect.height
            }
        }
    }
}
