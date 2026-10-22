import QtQuick
import Dafri.Kit

// 信息链路的时间线(lib/IntelTimeline.tsx,情报页与标的档案共用):按天分组(.intel-timeline 天与天之间 14),
// 天的标题 11px 600 二级色、字距 0.02em,后面跟三级色 500 的条数,下 6;一条一行(.intel-list 间距 6):
//   .intel-row:卡片面 + 卡片影、14 圆角、内边距 9 × 12;和持仓有关的左边一道 3px 的蓝(70%);左边 26 的淡底图标(种类的颜色),离正文 10;
//   正文(行间 3):① 种类(11px 600 正文色)、来源(11px 二级色,最宽 160,信任的人后面一颗 6px 绿点)、标的胶囊、时刻(靠右、三级色、等宽数字),间距 8;
//   ② 原文 13px、行高 1.45(状态是 warn 的橙字);③ 结果胶囊、提到时 → 此刻(等宽 11px 涨跌色)、说明(11.5px 二级色)、「写进指令框」(靠右的小按钮),间距 8。
// 模型是 shell/intel_page_rules 的 timelineModel:{ empty } 或 { groups }
Column {
    id: root
    property var tl: ({})
    signal openSymbol(string symbol)
    signal write(string text)
    spacing: 14

    EmptyState { visible: root.tl.empty !== undefined; width: root.width; text: root.tl.empty || "" }
    Repeater {
        model: root.tl.groups || []
        Column {
            id: day
            required property var modelData
            width: root.width
            spacing: 6
            Row {
                spacing: 6
                Label { text: day.modelData.label; size: 11; weight: Theme.weightSemibold; color: Theme.labelSecondary; letterSpacing: 0.22; css: 16.17 }
                Label { text: String(day.modelData.count); size: 11; weight: Theme.weightMedium; color: Theme.labelTertiary; css: 16.17 }
            }
            Repeater {
                model: day.modelData.rows
                IntelRow { required property var modelData; width: root.width; r: modelData }
            }
        }
    }

    // 没有发丝边(.intel-row 只有卡片影)
    component IntelRow: Glass {
        id: row
        property var r: ({})
        readonly property var foot: r.foot || null
        padding: 0
        radius: Theme.radiusTile
        fill: Theme.bgElevated
        edge: Theme.edgeCard
        border: "transparent"
        implicitHeight: 9 + main.implicitHeight + 9
        // 和持仓有关:左边一道 3px 的蓝(inset box-shadow,跟着圆角走)
        Item {
            visible: !!row.r.held
            width: 3; height: row.height
            clip: true
            Rectangle { width: 2 * Theme.radiusTile; height: parent.height; radius: Theme.radiusTile; color: Theme.tint(Theme.blue, 0.7) }
        }
        // .icon-tile.soft:填充底、着色的图标(26 的 62%)、圆角 26 × 0.29
        Rectangle {
            x: 12; y: 9 + 1
            width: 26; height: 26; radius: 8
            color: Theme.bgFill
            Icon { anchors.centerIn: parent; name: row.r.icon || ""; size: 16; color: Theme.tintOf(row.r.tint || "blue") }
        }
        Column {
            id: main
            x: 48; y: 9
            width: row.width - 48 - 12
            spacing: 3
            Item {
                width: parent.width
                height: 16.17
                Row {
                    spacing: 8
                    height: parent.height
                    Label { anchors.verticalCenter: parent.verticalCenter; text: row.r.kindLabel || ""; size: 11; weight: Theme.weightSemibold; css: 16.17 }
                    Row {
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 4
                        Label {
                            id: src
                            anchors.verticalCenter: parent.verticalCenter
                            width: Math.min(implicitWidth, 160 - (row.r.trusted ? 10 : 0)); elide: Text.ElideRight
                            text: row.r.source || ""; size: 11; color: Theme.labelSecondary; css: 16.17
                            Loader { anchors.fill: parent; active: !!row.r.trusted; sourceComponent: Tip { text: "信任名单里的发送者" } }
                        }
                        Rectangle { visible: !!row.r.trusted; anchors.verticalCenter: parent.verticalCenter; width: 6; height: 6; radius: 3; color: Theme.green }
                    }
                    Row {
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 4
                        Repeater {
                            model: row.r.syms || []
                            SymChip { required property var modelData; s: modelData; onPicked: function (sym) { root.openSymbol(sym) } }
                        }
                    }
                }
                Label {
                    id: time
                    anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                    text: row.r.time || ""; size: 11; color: Theme.labelTertiary; tnum: true; css: 16.17
                    Tip { text: row.r.timeTip || "" }
                }
            }
            Label {
                width: parent.width; wrap: true
                text: row.r.title || ""; size: 13; css: 1.45
                color: row.r.tone === "warn" ? Theme.orangeText : Theme.label
            }
            Item {
                visible: !!row.foot
                width: parent.width
                height: row.foot && row.foot.instruction ? 22 : 16.9
                Row {
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 8
                    Pill { visible: !!(row.foot && row.foot.outcome); anchors.verticalCenter: parent.verticalCenter; tint: row.foot && row.foot.outcome ? row.foot.outcome.tint : "gray"; text: row.foot && row.foot.outcome ? row.foot.outcome.label : "" }
                    Label {
                        visible: !!(row.foot && row.foot.move); anchors.verticalCenter: parent.verticalCenter
                        text: row.foot && row.foot.move ? row.foot.move.text : ""; size: 11; family: Theme.fontMono
                        color: row.foot && row.foot.move && row.foot.move.tone === "up" ? Theme.upText : row.foot && row.foot.move && row.foot.move.tone === "down" ? Theme.downText : Theme.labelSecondary
                    }
                    Label { visible: !!(row.foot && row.foot.body); anchors.verticalCenter: parent.verticalCenter; text: row.foot && row.foot.body ? row.foot.body : ""; size: 11.5; color: Theme.labelSecondary }
                }
                // .intel-write:22 高、左右 8、11px,靠右
                Button {
                    visible: !!(row.foot && row.foot.instruction)
                    anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                    small: true; padding: 8; height: 22; fontSize: 11
                    text: "写进指令框"
                    onClicked: root.write(row.foot.instruction)
                }
            }
        }
    }

    // .intel-sym:等宽 10.5px 600、行高 1.5、左右 6、6 圆角、填充底;持仓的蓝底蓝字;档案里的那只描一圈蓝;猜的透明底三级色、虚线边
    component SymChip: Rectangle {
        id: chip
        property var s: ({})
        signal picked(string symbol)
        width: chipText.implicitWidth + 12 + (s.guess ? 2 : 0); height: 15.75 + (s.guess ? 2 : 0)
        radius: 6
        color: s.guess ? "transparent" : s.held ? Theme.tint(Theme.blue, 0.16) : chipHover.hovered ? Theme.bgFillStrong : Theme.bgFill
        border.width: s.guess || s.current ? 1 : 0
        border.color: s.guess ? Theme.separator : Theme.tint(Theme.blue, 0.45)
        Label {
            id: chipText
            anchors.centerIn: parent
            text: chip.s.text || ""; size: 10.5; weight: Theme.weightSemibold; family: Theme.fontMono; css: 1.5
            color: chip.s.guess ? Theme.labelTertiary : chip.s.held ? Theme.blue : Theme.label
        }
        HoverHandler { id: chipHover; cursorShape: Qt.PointingHandCursor }
        TapHandler { onTapped: chip.picked(chip.s.text.replace(/\?$/, "")) }
        Tip { text: chip.s.tip || "" }
    }
}
