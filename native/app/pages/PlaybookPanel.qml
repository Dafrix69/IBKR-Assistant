import QtQuick
import Dafri.Kit

// SPX 日内剧本(lib/PlaybookPanel.tsx):预期波动区间、此刻的剧本状态、两条触发线离现价多远、期权墙上的加速档、今天报过的事件。
// 只看不下单;区间与状态是引擎里的循环算的,这里只显示(m = shell/fly_rules 的 playbookModel)。
Column {
    id: root
    property var controller: null
    readonly property var m: controller ? controller.playbook : ({})
    width: parent ? parent.width : 400
    Component.onCompleted: if (controller) controller.setPlaybookVisible(true)
    Component.onDestruction: if (controller) controller.setPlaybookVisible(false)

    EmptyState { visible: root.m.empty !== undefined; width: parent.width; topMargin: 0; text: root.m.empty || "" }
    Column {
        visible: root.m.empty === undefined
        width: parent.width
        // 头一行(同 .fly-spot)
        Item {
            width: parent.width
            height: headFlow.implicitHeight + 8
            Flow {
                id: headFlow
                x: 2
                width: parent.width - 4 - alertRow.implicitWidth - 14
                spacing: 6
                Label { text: root.m.symbol || ""; size: 11; weight: Theme.weightSemibold; color: Theme.labelSecondary; css: 26 }
                Row {
                    spacing: 5
                    Label { text: root.m.price || ""; size: 17; weight: 700; family: Theme.fontDisplay; tnum: true; css: 26; color: root.m.live ? Theme.label : Theme.labelSecondary }
                    Rectangle { visible: !!root.m.live; width: 5; height: 5; radius: 2.5; color: Theme.green; anchors.verticalCenter: parent.verticalCenter }
                }
                Tag {
                    y: 3
                    text: root.m.stateLabel || ""
                    tone: root.m.state === "B2" ? Theme.green : root.m.state === "B3" ? Theme.red : Theme.gray
                    Tip { text: root.m.stateHint || "" }
                }
                Label { visible: !!root.m.since; text: root.m.since || ""; size: 11; color: Theme.labelSecondary; css: 26 }
                Label { visible: !!root.m.why; text: root.m.why || ""; size: 11; color: Theme.labelSecondary; css: 26 }
            }
            Item {
                id: alertRow
                anchors.right: parent.right; anchors.rightMargin: 2
                implicitWidth: alertInner.implicitWidth; implicitHeight: alertInner.implicitHeight
                Row {
                    id: alertInner
                    spacing: 6
                    Switch { small: true; checked: !!root.m.alertOn; anchors.verticalCenter: parent.verticalCenter; onToggled: function (on) { root.controller.setPlaybookAlert(on) } }
                    Label { text: "过线时提醒"; size: 11; color: Theme.labelSecondary; css: 26 }
                }
                Tip { text: "进入 / 失效 B2、B3,或穿过加速档时弹窗并响一声,不在这一页也提醒。弹窗与提示音的开关在板块页的「提醒方式」" }
            }
        }
        // 触发线(.pb-lines:折行、间距 6 × 18、下 10、左右 2;一条线:基线对齐、间距 6、12px;名 11px 二级色、数 14px 590、离现价 12px 二级色)
        Flow {
            x: 2
            width: parent.width - 4
            spacing: 18
            bottomPadding: 10
            Repeater {
                model: root.m.lines || []
                Item {
                    required property var modelData
                    implicitWidth: lineRow.implicitWidth; implicitHeight: lineRow.implicitHeight
                    Row {
                        id: lineRow
                        spacing: 6
                        Label { text: modelData.label; size: 11; color: Theme.labelSecondary; css: 20.6 }
                        Label { text: modelData.level; size: 14; weight: Theme.weightSemibold; tnum: true; css: 20.6 }
                        // .fly-spot-gap 没有等宽数字(只有 .pb-num 有)
                        Label { visible: modelData.gap !== undefined; text: modelData.gap || ""; size: 12; color: Theme.labelSecondary; css: 20.6 }
                    }
                    Tip { text: modelData.hint }
                }
            }
            Label { visible: !!root.m.rearm; text: root.m.rearm || ""; size: 11; color: Theme.labelSecondary; css: 20.6 }
        }
        // 区间表(.pb-table:浏览器的自动表格布局——格不折行、表头可以折行;每列最少是最宽的那格,最多是表头整行也放得下;
        // 放得下全部「最多」就按「最多」的比例分多出来的宽,放不下就在「最少」上按(最多 − 最少)的比例分剩下的。全部左对齐;
        // 表头 11px 500 二级色、上下 4(折了行的那格撑高整行,别的竖直居中);格 12px、上下 5;每行下 1px 分隔线;dim 行二级色;下 10)
        Item {
            id: bands
            // 表最窄能窄到多少:格不折行,每列都按「最少」(撑宽右栏的就是它)
            readonly property real minContentWidth: mins.reduce(function (a, b) { return a + b }, 0)
            width: parent.width
            readonly property var heads: ["口径", "取价", "锚", "跨式(涨 + 跌)", "预期波动", "区间"]
            readonly property var rows: (root.m.bands || []).map(function (b) {
                return { dim: b.dim, cells: [b.label, b.when + (b.backfill ? " 补" : ""), b.anchor, b.straddle, b.em, b.range] }
            })
            readonly property real rowH: 5 + 12 * 1.47 + 5 + 1
            // 每列的「最少 / 最多」:直接绑在各列量出来的自然宽上(不经 Qt.callLater:列拆掉时排进去的函数会落在正在销毁的上下文里)
            readonly property var naturals: {
                var out = []
                for (var c = 0; c < 6; ++c) { var col = c < cols.count ? cols.itemAt(c) : null; out.push(col ? [col.cellNatural, col.headNatural] : [0, 0]) }
                return out
            }
            readonly property var mins: naturals.map(function (n) { return Math.max(n[0], 11 + 16) })
            readonly property var maxs: naturals.map(function (n) { return Math.max(n[0], n[1]) })
            readonly property var widths: {
                var sumMin = 0, sumMax = 0
                for (var i = 0; i < 6; ++i) { sumMin += mins[i]; sumMax += maxs[i] }
                var out = []
                for (var k = 0; k < 6; ++k) {
                    if (sumMax <= width) out.push(sumMax > 0 ? maxs[k] * width / sumMax : 0)
                    else if (sumMin >= width) out.push(mins[k])
                    else out.push(mins[k] + (width - sumMin) * (maxs[k] - mins[k]) / (sumMax - sumMin))
                }
                return out
            }
            readonly property real headH: {
                var h = 0
                for (var c = 0; c < cols.count; ++c) { var col = cols.itemAt(c); if (col) h = Math.max(h, col.headTextH) }
                return 4 + h + 4 + 1
            }
            height: headH + rowH * rows.length + 10
            clip: true
            Row {
                Repeater {
                    id: cols
                    model: 6
                    Column {
                        id: col
                        required property int index
                        property var cellLabels: []
                        readonly property real cellNatural: cellLabels.length ? Math.max.apply(null, cellLabels.map(function (l) { return l.implicitWidth })) + 16 : 0
                        readonly property real headNatural: headMeasure.implicitWidth + 16
                        readonly property real headTextH: headL.implicitHeight
                        width: bands.widths[index] || 0
                        Label { id: headMeasure; visible: false; text: bands.heads[col.index]; size: 11; weight: 500 }
                        Item {
                            width: parent.width; height: bands.headH
                            Label {
                                id: headL
                                x: 8; width: parent.width - 16; wrap: true
                                anchors.verticalCenter: parent.verticalCenter; anchors.verticalCenterOffset: -0.5
                                text: bands.heads[col.index]; size: 11; weight: 500; color: Theme.labelSecondary
                            }
                            Rectangle { y: parent.height - 1; width: parent.width; height: 1; color: Theme.separator }
                        }
                        Repeater {
                            model: bands.rows
                            Item {
                                required property var modelData
                                width: col.width; height: bands.rowH
                                Label {
                                    id: cellL
                                    x: 8; y: 5
                                    // 取价那一列是 .muted(11px 二级色)
                                    text: modelData.cells[col.index]; size: col.index === 1 ? 11 : 12; tnum: true
                                    color: modelData.dim || col.index === 1 ? Theme.labelSecondary : Theme.label
                                    Component.onCompleted: { col.cellLabels = col.cellLabels.concat([cellL]) }
                                    Component.onDestruction: { col.cellLabels = col.cellLabels.filter(function (l) { return l !== cellL }) }
                                }
                                Rectangle { y: parent.height - 1; width: parent.width; height: 1; color: Theme.separator }
                            }
                        }
                    }
                }
            }
        }
        // 期权墙(.pb-wall:折行、间距 4 × 16、下 10、左右 2、12px 数字等宽)
        // 行距 4、列距 16 不一样:Flow 只有一个间距,用 WrapRow
        WrapRow {
            visible: !!root.m.wall
            x: 2
            width: parent.width - 4
            columnSpacing: 16
            rowSpacing: 4
            bottomPadding: 10
            Repeater {
                model: root.m.wall || []
                Label {
                    required property var modelData
                    // 最后那一句是 .muted:11px 二级色
                    text: modelData.text; size: modelData.muted ? 11 : 12; tnum: true; css: 12 * 1.47
                    color: modelData.muted ? Theme.labelSecondary : Theme.label
                    Tip { text: modelData.tip || "" }
                }
            }
        }
        // 备注(.hint-list.pb-notes:下 10)
        Column {
            visible: !!(root.m.notes && root.m.notes.length)
            width: parent.width
            topPadding: 4
            bottomPadding: 10
            Repeater {
                model: root.m.notes || []
                Row {
                    required property var modelData
                    width: parent.width
                    leftPadding: 16
                    Label { text: "•  "; size: 11; color: Theme.labelSecondary; css: 1.6 }
                    Label { text: modelData; size: 11; color: Theme.labelSecondary; css: 1.6; width: parent.width - 30; wrap: true }
                }
            }
        }
        // 今天报过的事件(.pb-events:竖排间距 4、下 12、左右 2、12px;一条:间距 10,时刻与价 11px 二级色)
        Column {
            x: 2
            width: parent.width - 4
            spacing: 4
            bottomPadding: 12
            Label { visible: !(root.m.events && root.m.events.length); text: "今天还没有报过事件。"; size: 11; color: Theme.labelSecondary; css: 12 * 1.47 }
            Repeater {
                model: root.m.events || []
                Row {
                    required property var modelData
                    spacing: 10
                    Label { text: modelData.at; size: 11; tnum: true; color: Theme.labelSecondary; css: 12 * 1.47 }
                    Label { text: modelData.title; size: 12 }
                    Label { text: modelData.price; size: 11; tnum: true; color: Theme.labelSecondary; css: 12 * 1.47 }
                }
            }
        }
        Primer {
            id_: "playbook"
            intro: false
            width: parent.width
            topPadding: 0
            summary: "区间怎么算、状态怎么判、哪些还没做"
            Column {
                width: parent.width
                Repeater {
                    model: ["预期波动 = 平值跨式(看涨 + 看跌的中间价)× √(π/2);区间 = 锚 ± 预期波动。",
                            "昨日定价在上一个收盘后 10 分钟取,盘初定价在 09:35 取,当前剩余每 5 分钟重取。软件当时没开着的那一条,拿那一分钟的历史中间价补,标「补」。",
                            "今日区间 = 09:35 的指数价 ± 当前剩余的预期波动:锚整天不动,半宽是期权市场此刻给剩下这段时间定的价,所以越到尾盘越窄。",
                            "站上今日区间上沿 = B2(现价高出 09:35 那个价的幅度超过了剩余的预期波动),每 5 分钟取到新一格时判一次,格子中间刺上去、刺下来又回来的不算。跌破昨日区间下沿 = B3,每一笔现价都判,而且压过 B2。",
                            "进去之后记住的是当时那条线,回到线的另一侧才失效。尾盘区间很窄,那时的 B2 只说明收盘多半在 09:35 那个价上方。",
                            "止损位与概率分流还没有:没有能反推出算法的样本,不编数。",
                            "只读行情、只提醒,不下单。"]
                    Row {
                        required property var modelData
                        width: parent.width
                        leftPadding: 16
                        Label { text: "•  "; size: 11; color: Theme.labelSecondary; css: 1.6 }
                        Label { text: modelData; size: 11; color: Theme.labelSecondary; css: 1.6; width: parent.width - 30; wrap: true }
                    }
                }
                Row {
                    topPadding: 6
                    spacing: 6
                    Switch { small: true; checked: !!root.m.enabled; anchors.verticalCenter: parent.verticalCenter; onToggled: function (on) { root.controller.setPlaybookEnabled(on) } }
                    Label { text: "后台计算日内剧本(关掉之后不取期权行情,也不提醒)"; size: 11; color: Theme.labelSecondary }
                }
            }
        }
    }
}
