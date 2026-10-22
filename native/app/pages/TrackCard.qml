import QtQuick
import Dafri.Kit

// 正在追踪的一条(lib/TrackCard.tsx):摘要、托管、盈亏、价位轨、离触发还有多远、关键价位、追价进度、按钮。
// c = shell/track_card 的模型;字都在模型里算好,这里只摆。间距照 React 版的 DOM 一层一层量的(margin / padding / gap / line-height)
StatusCard {
    id: root
    property var c: ({})
    property var controller: null
    property string busy: ""
    width: parent ? parent.width : 400
    tone: c.tone || "info"
    title: c.title || ""
    extra: Pill { dot: true; tint: root.c.pill ? root.c.pill.tint : "gray"; text: root.c.pill ? root.c.pill.text : "" }

    Meta { items: root.c.meta || []; width: parent.width; topPadding: 2 }
    Meta { items: (root.c.tiers || []).map(function (t) { return { text: t } }); width: parent.width }
    Label { visible: !!root.c.stopBasis; width: parent.width; wrap: true; text: root.c.stopBasis || ""; size: 11; color: Theme.labelSecondary }
    Meta { items: root.c.hosted || []; width: parent.width }

    // 盈亏:pos-hero compact(上 2;20px 字重 750、行高 1.1;百分比那一截是正常字重)
    Item {
        visible: !!root.c.pnl
        width: parent.width
        height: visible ? 2 + pnlNum.implicitHeight + pnlSub.implicitHeight : 0
        readonly property color tone: !root.c.pnl ? Theme.label : root.c.pnl.cls === "up" ? Theme.upText : root.c.pnl.cls === "down" ? Theme.downText : Theme.labelSecondary
        Row {
            y: 2
            Label { id: pnlNum; text: root.c.pnl ? root.c.pnl.text : ""; size: 20; weight: Theme.weightHeavy; family: Theme.fontDisplay; css: 1.1; tnum: true; letterSpacing: -0.4; color: parent.parent.tone }
            Label { visible: !!(root.c.pnl && root.c.pnl.pct); text: root.c.pnl && root.c.pnl.pct ? " " + root.c.pnl.pct : ""; size: 20; family: Theme.fontDisplay; css: 1.1; tnum: true; letterSpacing: -0.4; color: parent.parent.tone }
        }
        Label { id: pnlSub; y: 2 + pnlNum.implicitHeight; text: "未实现盈亏"; size: 11.5; color: Theme.labelSecondary }
    }
    // 价位轨(上 6 下 2)
    Item { width: 1; height: rail.visible ? 6 : 0 }
    PriceRail { id: rail; marks: root.c.rail || []; width: parent.width }
    // 下边距 2 和后面盯盘量表的上边距 8 合并(CSS margin collapsing):量表在的时候只剩它的 8
    Item { width: 1; height: rail.visible && !gauge.visible ? 2 : 0 }

    // 盯盘量表(.track-gauge):上 8、0.5px 分隔线、再 8;里面竖排、间距 4;环那一排上边再 4
    Item {
        id: gauge
        visible: !!root.c.gauge
        width: parent.width
        height: visible ? 8 + 0.5 + 8 + gaugeCol.implicitHeight : 0
        Rectangle { y: 8; width: parent.width; height: 0.5; color: Theme.separator }
        Column {
            id: gaugeCol
            y: 16.5
            width: parent.width
            spacing: 4
            Repeater {
                model: root.c.gauge ? [root.c.gauge.noPrice, root.c.gauge.empty].concat(root.c.gauge.lines || []).concat([root.c.gauge.spotStop]).filter(function (s) { return !!s }) : []
                Label { required property var modelData; width: gaugeCol.width; wrap: true; text: modelData; size: 11; color: Theme.labelSecondary }
            }
            Flow {
                visible: !!(root.c.gauge && (root.c.gauge.rings || []).length)
                width: parent.width
                spacing: 10
                topPadding: 4
                Repeater {
                    model: root.c.gauge ? (root.c.gauge.rings || []) : []
                    // 一枚环(.gauge-ring:内边距 8 14 8 10、圆角 14、填充色底,环与字之间 10)
                    Rectangle {
                        required property var modelData
                        width: 10 + ring.width + 10 + ringText.implicitWidth + 14
                        height: 8 + Math.max(ring.height, ringText.implicitHeight) + 8
                        radius: Theme.radiusTile
                        color: Theme.bgFill
                        Ring { id: ring; x: 10; anchors.verticalCenter: parent.verticalCenter; size: 58; value: modelData.closeness; tint: modelData.tint; text: modelData.pct; unit: "%"; Tip { text: "环越满 = 离触发越近" } }
                        Column {
                            id: ringText
                            x: 10 + ring.width + 10
                            anchors.verticalCenter: parent.verticalCenter
                            Label { text: modelData.label; size: 11; css: 1.35; color: Theme.labelSecondary }
                            Label { text: modelData.value; size: 15; weight: 700; family: Theme.fontDisplay; css: 1.35; tnum: true }
                            Label { text: modelData.gap; size: 11; css: 1.35; color: Theme.labelSecondary }
                        }
                    }
                }
            }
        }
    }

    // 关键价位(.track-levels:上 8 下 2;内边距 6 8 5;圆角 6;填充色底)。还没算出来时是一行小字(内边距 4 8)
    Item { width: 1; height: levels.visible ? 8 : 0 }
    Rectangle {
        id: levels
        readonly property var lv: root.c.levels
        readonly property bool pending: !!(lv && lv.pending)
        visible: !!lv
        width: parent.width
        height: visible ? levelCol.implicitHeight + (pending ? 8 : 11) : 0
        radius: 6
        color: Theme.bgFill
        Column {
            id: levelCol
            x: 8; y: levels.pending ? 4 : 6
            width: parent.width - 16
            // 还没有盯单 / 还没算出价位:一行 11px 的字 + 文字按钮(间距 6)
            Row {
                visible: levels.pending
                spacing: 6
                Label { text: levels.pending ? levels.lv.pending.text : ""; size: 11; color: Theme.labelSecondary; anchors.verticalCenter: parent.verticalCenter }
                Button {
                    kind: "text"; small: true; inline: true
                    text: levels.pending ? levels.lv.pending.button : ""
                    busy: !!(levels.pending && levels.lv.pending.computing)
                    onClicked: levels.lv.pending.create ? root.controller.createWatch(root.c.symbol) : root.controller.refreshWatch(levels.lv.pending.watchId)
                    anchors.verticalCenter: parent.verticalCenter
                }
            }
            // 头:「关键价位」12px 600 + 摘要 11px,基线对齐、间距 8
            Item {
                visible: !levels.pending
                width: parent.width
                height: visible ? headTitle.implicitHeight : 0
                Label { id: headTitle; text: "关键价位"; size: 12; weight: 600 }
                Label {
                    x: headTitle.implicitWidth + 8
                    y: headTitle.y + headTitle.halfLeading + headMetrics.ascent - (halfLeading + summaryMetrics.ascent)
                    width: parent.width - x
                    wrap: true
                    text: levels.lv && levels.lv.summary ? levels.lv.summary : ""
                    size: 11; color: Theme.labelSecondary
                    FontMetrics { id: summaryMetrics; font.pointSize: Theme.px(11); font.family: Theme.fontFamily }
                }
                FontMetrics { id: headMetrics; font.pointSize: Theme.px(12); font.weight: 600; font.family: Theme.fontFamily }
            }
            Item { width: 1; height: strip.visible ? 2 : 0 }
            LevelStrip {
                id: strip
                visible: !levels.pending && !!(levels.lv && levels.lv.strip)
                width: parent.width
                layout: visible && root.controller ? function (w) { return root.controller.levelStrip(levels.lv.strip.levels, levels.lv.strip.spot, w) } : null
            }
            Repeater {
                model: !levels.pending && levels.lv && levels.lv.notes ? levels.lv.notes : []
                Hint { required property var modelData; text: modelData; topPadding: 3; textFormat: Text.PlainText }
            }
            // .card-meta.pool-wall(上 4):各项 + 文字按钮
            Item {
                visible: !levels.pending
                width: parent.width
                height: visible ? 4 + wallMeta.contentHeight : 0
                Meta {
                    id: wallMeta
                    width: parent.width
                    topPadding: 4
                    items: levels.lv && levels.lv.meta ? levels.lv.meta : []
                    trailing: Button {
                        kind: "text"; small: true; inline: true
                        text: levels.lv && levels.lv.button ? levels.lv.button : ""
                        busy: !!(levels.lv && levels.lv.computing)
                        onClicked: root.controller.refreshWatch(levels.lv.watchId)
                    }
                }
            }
        }
    }
    Item { width: 1; height: levels.visible ? 2 : 0 }
    // .reason:11.5px 二级色,上 4
    Item {
        visible: !!root.c.reason
        width: parent.width; height: visible ? 4 + reasonText.implicitHeight : 0
        Label { id: reasonText; y: 4; width: parent.width; wrap: true; text: root.c.reason || ""; size: 11.5; color: Theme.labelSecondary }
    }
    Item {
        visible: !!root.c.chase
        width: parent.width; height: visible ? 4 + chaseText.implicitHeight : 0
        Label { id: chaseText; y: 4; width: parent.width; wrap: true; text: root.c.chase || ""; size: 11.5; color: Theme.labelSecondary }
    }
    Item {
        visible: (root.c.blocked || []).length > 0
        width: parent.width
        height: visible ? blockedAlert.height + 8 : 0
        Alert { id: blockedAlert; y: 8; width: parent.width; tone: "warn"; title: "到价了但没有平仓"; text: (root.c.blocked || []).join("、") }
    }
    // 按钮(.card-actions:上 8,间距 6)
    Item {
        width: parent.width; height: 8 + actions.height
        Row {
            id: actions
            y: 8
            spacing: 6
            Button { small: true; text: root.c.toggle || "暂停"; busy: root.busy === "toggle"; onClicked: root.controller.toggle(root.c.id) }
            Button { small: true; text: "立即平仓"; textColor: Theme.orangeText; busy: root.busy === "close"; onClicked: root.controller.closeNow(root.c.id) }
            Button { small: true; kind: "text"; text: "删除"; busy: root.busy === "delete"; onClicked: root.controller.remove(root.c.id) }
        }
    }
}
