import QtQuick
import Dafri.Kit

// 蝴蝶测算的结果(lib/FlyPlanResult.tsx):主结果瓦片、这一段走势急不急与 IV 怎么变、各档 IV 下的结果、盈亏曲线、早到晚到各值多少、三条腿。
// 只摆引擎给的数(r = shell/fly_rules 的 resultModel)。每张卡片下空 10(.fly-result .ant-card)
Column {
    id: root
    property var r: ({})
    width: parent ? parent.width : 400

    StatusCard {
        width: parent.width
        tone: root.r.tone || "info"
        title: root.r.title || ""
        // .stat-grid:auto-fit minmax(150px, 1fr)、间距 8、上下 10
        Grid {
            id: grid
            width: parent.width
            topPadding: 10; bottomPadding: 10
            spacing: 8
            columns: Math.max(1, Math.floor((width + 8) / (150 + 8)))
            readonly property real cell: (width - (columns - 1) * 8) / columns
            Repeater {
                model: root.r.tiles || []
                StatTile { required property var modelData; width: grid.cell; label: modelData.label; value: modelData.value; tone: modelData.tone || ""; tip: modelData.tip || "" }
            }
        }
        Meta { width: parent.width; items: root.r.meta1 || []; topPadding: 0 }
        Meta { width: parent.width; items: root.r.meta2 || [] }
        Hint { visible: !!root.r.spotNote; width: parent.width; text: root.r.spotNote || ""; textFormat: Text.PlainText }
    }
    Gap {}
    StatusCard {
        visible: !!(root.r.warnings && root.r.warnings.length)
        width: parent.width
        tone: "warn"; title: "要留意的"
        Bullets { width: parent.width; items: root.r.warnings || [] }
    }
    Gap { visible: !!(root.r.warnings && root.r.warnings.length) }
    StatusCard {
        width: parent.width
        title: "盈亏曲线"
        FlyChart { width: parent.width; m: root.r.chart && root.r.chart.points ? root.r.chart : null }
        Meta { width: parent.width; items: root.r.chartMeta || []; topPadding: 0 }
    }
    Gap {}
    StatusCard {
        width: parent.width
        title: "IV 变了会怎样"
        Hint { width: parent.width; topPadding: 0; text: "同一个目标点位与时刻,到时的 IV 不同,这只蝶值的也不同。标出来的那一行是上面用的。"; textFormat: Text.PlainText }
        Item { width: 1; height: 7 }
        FlyTable { width: parent.width; head: ["IV 变化", "到时 IV", "蝶价", "盈亏"]; rows: root.r.scenarios || [] }
    }
    Gap {}
    StatusCard {
        visible: !!(root.r.timeline && root.r.timeline.length)
        width: parent.width
        title: root.r.timelineTitle || ""
        FlyTable { width: parent.width; head: ["到达(美东)", "那时的 IV", "蝶价", "盈亏"]; rows: root.r.timeline || [] }
    }
    Gap { visible: !!(root.r.timeline && root.r.timeline.length) }
    SectionTitle { text: "三条腿" }
    FlyTable { width: parent.width; head: ["腿", "买价 / 卖价", "IV"]; rows: (root.r.legs || []).map(function (l) { return { cells: l } }); bottomPadding: 8 }
    Meta { width: parent.width; items: root.r.footMeta || []; topPadding: 0 }
    Hint { visible: !!root.r.model; width: parent.width; text: root.r.model || ""; textFormat: Text.PlainText }

    component Gap: Item { width: 1; height: 10 }
    component Bullets: Column {
        property var items: []
        topPadding: 4
        Repeater {
            model: parent.items
            Row {
                required property var modelData
                width: parent.width
                leftPadding: 16
                Label { text: "•  "; size: 11; color: Theme.labelSecondary; css: 1.6 }
                Label { text: modelData; size: 11; color: Theme.labelSecondary; css: 1.6; width: parent.width - 30; wrap: true }
            }
        }
    }
    // .fly-table:12px 数字等宽;表头 11px 500 二级色、3 × 8;格 4 × 8;行间 0.5px 分隔线(最后一行没有);第一列左对齐,其余右对齐;
    // 用到的那一行(on)蓝 12% 底、590
    component FlyTable: Column {
        id: table
        property var head: []
        property var rows: []
        readonly property real colW: width / head.length
        Row {
            Repeater {
                model: table.head
                Item {
                    required property var modelData
                    required property int index
                    width: table.colW; height: headL.implicitHeight + 6
                    Label { id: headL; y: 3; x: index === 0 ? 8 : parent.width - 8 - contentWidth; text: modelData; size: 11; weight: 500; color: Theme.labelSecondary }
                }
            }
        }
        Rectangle { width: table.width; height: 0.5; color: Theme.separator }
        Repeater {
            model: table.rows
            Column {
                id: rowItem
                required property var modelData
                required property int index
                width: table.width
                Rectangle {
                    width: table.width
                    height: 4 + cellRow.height + 4
                    color: rowItem.modelData.on ? Theme.tint(Theme.blue, 0.12) : "transparent"
                    Row {
                        id: cellRow
                        y: 4
                        Repeater {
                            model: rowItem.modelData.cells.concat(rowItem.modelData.pnl !== undefined ? [rowItem.modelData.pnl] : [])
                            Item {
                                required property var modelData
                                required property int index
                                width: table.colW; height: cellL.implicitHeight
                                readonly property bool isPnl: rowItem.modelData.pnl !== undefined && index === table.head.length - 1
                                Label {
                                    id: cellL
                                    x: index === 0 ? 8 : parent.width - 8 - contentWidth
                                    text: modelData; size: 12; tnum: true
                                    weight: rowItem.modelData.on ? Theme.weightSemibold : Font.Normal
                                    color: parent.isPnl && rowItem.modelData.tone === "pos" ? Theme.upText : parent.isPnl && rowItem.modelData.tone === "neg" ? Theme.downText : Theme.label
                                }
                            }
                        }
                    }
                }
                Rectangle { visible: rowItem.index < table.rows.length - 1; width: table.width; height: 0.5; color: Theme.separator }
            }
        }
    }
}
