import QtQuick
import Dafri.Kit

// 回测结果(lib/BacktestResult.tsx):总览、交易统计、本次的条件、净值曲线、成交明细、注意——一张张状态卡片直接叠着(原版没有间距)。
// 数字全是引擎算的;模型是 controller.page.result(shell/backtest_rules 的 resultModel),图是 controller.chart
Column {
    id: root
    property var r: ({})
    property var chartSource: null

    StatusCard {
        width: root.width
        tone: root.r.tone || "info"
        title: root.r.title || ""
        TileGrid { tiles: root.r.tiles || [] }
        Meta { width: parent.width; topPadding: 0; items: [{ text: root.r.riskMeta || "" }] }
    }
    StatusCard {
        width: root.width
        title: root.r.statsTitle || ""
        TileGrid { visible: !!root.r.statTiles; tiles: root.r.statTiles || [] }
        Label { visible: !root.r.statTiles; width: parent.width; wrap: true; text: root.r.statsEmpty || ""; size: 11; color: Theme.labelSecondary }
    }
    StatusCard {
        visible: !!root.r.rules
        width: root.width
        title: "本次使用的条件"
        Label { width: parent.width; wrap: true; text: root.r.rules ? root.r.rules.entry : ""; size: 13 }
        Label { width: parent.width; wrap: true; text: root.r.rules ? root.r.rules.exit : ""; size: 13 }
    }
    StatusCard {
        width: root.width
        title: root.r.curveTitle || ""
        // .chart-wrap.short:上 6、220 高
        Item {
            visible: !!root.r.hasChart
            width: parent.width; height: visible ? 6 + 220 : 0
            Chart { y: 6; width: parent.width; height: 220; source: root.chartSource }
        }
        Meta { visible: !!root.r.hasChart; width: parent.width; items: (root.r.curveMeta || []).map(function (t) { return { text: t } }) }
    }
    StatusCard {
        visible: !!root.r.trades
        width: root.width
        title: root.r.trades ? root.r.trades.title : ""
        // .trade-list(AntD 小号 List,11.5px):每笔一行(上下 5、间距 8,行间 1px 发丝线,最后一行不画):起止(11px 二级色,占满、一行省略)、
        // 进出价(等宽数字)、收益(.status:11px 510,赚绿亏红)
        Column {
            width: parent.width
            Repeater {
                model: root.r.trades ? root.r.trades.rows : []
                Item {
                    required property var modelData
                    required property int index
                    readonly property bool last: index === (root.r.trades ? root.r.trades.rows.length : 0) - 1
                    width: parent.width
                    height: 5 + 16.905 + 5 + (last ? 0 : 1)
                    Label {
                        y: 5 + (16.905 - implicitHeight) / 2
                        width: parent.width - 8 - priceL.implicitWidth - 8 - retL.implicitWidth
                        text: modelData.when; size: 11; color: Theme.labelSecondary; elide: Text.ElideRight
                    }
                    Label {
                        id: priceL
                        anchors.right: retL.left; anchors.rightMargin: 8
                        y: 5
                        text: modelData.price; size: 11.5; tnum: true
                    }
                    Label {
                        id: retL
                        anchors.right: parent.right
                        y: 5 + (16.905 - implicitHeight) / 2
                        text: modelData.ret; size: 11; weight: Theme.weightMedium
                        color: modelData.ok ? Theme.greenText : Theme.redText
                    }
                    Rectangle { visible: !parent.last; y: parent.height - 1; width: parent.width; height: 1; color: Theme.separator }
                }
            }
        }
    }
    StatusCard {
        width: root.width
        tone: "warn"
        title: "注意"
        Label { width: parent.width; wrap: true; text: root.r.notice ? root.r.notice.text : ""; size: 13 }
        Repeater {
            model: root.r.notice ? root.r.notice.notes : []
            Label { required property var modelData; width: parent.width; wrap: true; text: modelData; size: 13 }
        }
    }

    // .stat-grid:每格最窄 150、等分、间距 8,上下 10
    component TileGrid: Grid {
        id: grid
        property var tiles: []
        width: parent ? parent.width : 0
        topPadding: 10; bottomPadding: 10
        columnSpacing: 8; rowSpacing: 8
        columns: Math.max(1, Math.min(tiles.length, Math.floor((width + 8) / (150 + 8))))
        Repeater {
            model: grid.tiles
            StatTile {
                required property var modelData
                width: (grid.width - (grid.columns - 1) * 8) / grid.columns
                label: modelData.label; value: modelData.value; tone: modelData.tone
            }
        }
    }
}
