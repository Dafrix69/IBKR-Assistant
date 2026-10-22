import QtQuick
import Dafri.Kit

// 一只的盘口(lib/marketBits 的 BookBody / BookSide):上面那张「盘口 · 标的」与盘口墙的卡片共用。
//   · 没读过 / 读着:一句 11px 二级色(.muted);读不到:紧凑的空态;
//   · 读到了:一行元数据(.card-meta)、买一卖一(.status 11px 510,买绿卖红;上 8)、买卖各五档(.book-grid 两栏、间距 14、上 6;
//     每档 .book-row 上下 3 左右 6、12px 等宽数字,背后一根按挂单量占比的色条,透明 18%、圆角 3、上下各缩 1)、备注(.stock-sub 11px 二级色)。
// maxGrid:梯子最宽多少(K 线下面那张整页宽,梯子收在 720 以内,不然价格与数量隔太远)
Column {
    id: root
    property var body: ({})
    property real maxGrid: 0
    /// 放在状态卡片里(上面那张「盘口 · 标的」):打头的元数据行上 2(.status-card .ant-card-body > .card-meta:first-child),别处是 6
    property bool inStatusCard: false
    readonly property bool ok: body.kind === "ok"

    // <p class="muted">:段落的上下外边距 1em(11)
    Label {
        visible: root.body.kind === "none"
        topPadding: 11; bottomPadding: 11
        width: parent.width; wrap: true
        text: root.body.text || ""
        size: 11; color: Theme.labelSecondary
    }
    EmptyState {
        visible: root.body.kind === "error"
        width: parent.width
        compact: true
        text: root.body.text || ""
    }
    Meta {
        visible: root.ok
        topPadding: root.inStatusCard ? 2 : 6
        width: parent.width
        items: root.ok ? root.body.meta : []
    }
    Row {
        visible: root.ok
        topPadding: 8
        spacing: 8
        Label { text: root.body.bid || ""; size: 11; weight: Theme.weightMedium; color: Theme.greenText }
        Label { text: root.body.ask || ""; size: 11; weight: Theme.weightMedium; color: Theme.redText }
    }
    Row {
        id: grid
        visible: root.ok && !!root.body.depth
        topPadding: 6
        spacing: 14
        readonly property real colW: (Math.min(root.width, root.maxGrid > 0 ? root.maxGrid : root.width) - 14) / 2
        Side { width: grid.colW; title: "买盘"; rows: root.body.depth ? root.body.depth.bids : []; tint: Theme.up }
        Side { width: grid.colW; title: "卖盘"; rows: root.body.depth ? root.body.depth.asks : []; tint: Theme.down }
    }
    Label {
        visible: root.ok && (root.body.note || "") !== ""
        width: parent.width
        elide: Text.ElideRight
        text: root.body.note || ""
        size: 11; color: Theme.labelSecondary
    }

    component Side: Column {
        id: side
        property string title: ""
        property var rows: []
        property color tint
        Label { text: side.title; size: 11; color: Theme.labelSecondary }
        Repeater {
            model: side.rows
            Item {
                required property var modelData
                width: side.width
                height: 3 + price.implicitHeight + 3
                Rectangle {
                    y: 1; height: parent.height - 2
                    width: parent.width * modelData.pct / 100
                    radius: 3
                    color: side.tint
                    opacity: 0.18
                }
                Label { id: price; x: 6; y: 3; text: modelData.price; size: 12; tnum: true }
                Label { anchors.right: parent.right; anchors.rightMargin: 6; y: 3; text: modelData.size; size: 12; tnum: true }
            }
        }
    }
}
