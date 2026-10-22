import QtQuick
import Dafri.Kit

// 复盘的结论(lib/ReviewResult.tsx + reviewCharts.tsx):蝶 / 正股两种结果。都在 .cards 里(竖排、间距 8):
// 蝶:本地记录的提醒、六格读数、标的走势、(有止盈策略时)蝶价走势与止盈策略那一段、结论卡片、明细、备注;
// 股票:六格读数、股价走势、结论卡片、明细、备注。模型是 controller.page.result(shell/review_rules),三张图在 controller 上
Column {
    id: root
    property var r: ({})
    property var controller: null
    readonly property bool stock: r.kind === "stock"
    spacing: 8

    StatusCard {
        visible: !!root.r.local
        width: root.width
        tone: "warn"; title: "这是本地记录,不是券商成交"
        Label { width: parent.width; wrap: true; text: "这张蝴蝶没有在 IBKR 成交过,下面的权利金按限价、开仓时刻按提交时间估算。"; size: 13 }
    }
    // .stat-grid:每格最窄 150、等分、间距 8,上下 10
    Grid {
        id: tiles
        readonly property var list: root.r.tiles || []
        width: root.width
        topPadding: 10; bottomPadding: 10
        columnSpacing: 8; rowSpacing: 8
        columns: Math.max(1, Math.min(list.length, Math.floor((width + 8) / (150 + 8))))
        Repeater {
            model: tiles.list
            StatTile {
                required property var modelData
                width: (tiles.width - (tiles.columns - 1) * 8) / tiles.columns
                label: modelData.label; value: modelData.value; tone: modelData.tone
            }
        }
    }
    // 图(.chart-wrap.mid:上 6、320 高)
    StatusCard {
        width: root.width
        title: root.stock ? root.r.chartTitle || "" : root.r.underlyingTitle || ""
        Item {
            visible: root.stock ? !!root.r.hasChart : !!root.r.hasUnderlying
            width: parent.width; height: visible ? 6 + 320 : 0
            Chart { y: 6; width: parent.width; height: 320; source: root.controller ? (root.stock ? root.controller.stockChart : root.controller.underlyingChart) : null }
        }
    }
    StatusCard {
        visible: !root.stock && !!root.r.exitPlan
        width: root.width
        title: root.r.flyTitle || ""
        Item {
            visible: !!root.r.hasFly
            width: parent.width; height: visible ? 6 + 320 : 0
            Chart { y: 6; width: parent.width; height: 320; source: root.controller ? root.controller.flyChart : null }
        }
        EmptyState { visible: !root.r.hasFly; compact: true; width: parent.width; text: "没有蝶价数据:引擎未连 TWS,或 IBKR 没有这张组合的历史分钟线。" }
    }
    ExitPlan { visible: !root.stock && !!root.r.exitPlan; width: root.width; ep: root.r.exitPlan || ({}) }
    Repeater {
        model: root.r.findings || []
        StatusCard {
            required property var modelData
            width: root.width
            tone: modelData.tone; title: modelData.title
            Label { width: parent.width; wrap: true; text: modelData.text; size: 13 }
        }
    }
    // .detail-section(上 12,加在间距 8 之外:flex 的间距不和外边距合并):小标题 11px 590 三级色、字距 0.02em、下 6;
    // AntD 小号 Descriptions(一列、不带冒号):每行上 1 下 4、名 12px 二级色(后面是 ::after 的左 2 右 8)、值 12px 正文色等宽数字,最后一行没有下 4
    Column {
        visible: (root.r.details || []).length > 0
        width: root.width
        topPadding: 12
        Label { text: "明细"; size: 11; weight: Theme.weightSemibold; color: Theme.labelTertiary; letterSpacing: 0.22; css: 16.17 }
        Item { width: 1; height: 6 }
        Repeater {
            model: root.r.details || []
            Item {
                required property var modelData
                required property int index
                readonly property bool last: index === (root.r.details || []).length - 1
                width: root.width
                height: 1 + Math.max(17.64, valueL.implicitHeight) + (last ? 0 : 4)
                Label { id: labelL; x: 1; y: 1; text: parent.modelData.label; size: 12; color: Theme.labelSecondary }
                Label { id: valueL; x: 1 + labelL.implicitWidth + 10; y: 1; width: parent.width - x; wrap: true; text: parent.modelData.value; size: 12; tnum: true }
            }
        }
    }
    // .review-notes:上 6(在间距 8 之外)、左 16、11.5px 橙字
    NoteList {
        visible: (root.r.notes || []).length > 0
        width: root.width
        topPadding: 6
        notes: root.r.notes || []
        ink: Theme.orangeText
    }

    // 止盈点位与预计盈利 + 策略回放事件 + 三种结局对比(一张卡片)
    component ExitPlan: StatusCard {
        id: card
        property var ep: ({})
        title: "止盈策略(SPX 0DTE 蝶式 v2.1 · 浮盈回撤追踪)"
        // 引擎给的字(带「σ_剩余 12.4 < W/1.6」这种):纯文本,不当标签解析(Hint 默认是 StyledText)
        Hint { text: card.ep.hint || ""; textFormat: Text.PlainText }
        Item { width: 1; height: 8 }
        AutoTable {
            width: parent.width
            columns: [{ key: "label", title: "点位" }, { key: "price", title: "蝶价", align: "right" }, { key: "mult", title: "倍数", align: "right" },
                      { key: "qty", title: "张数", align: "right" }, { key: "perContract", title: "每张盈亏", align: "right" }, { key: "expected", title: "预计盈亏", align: "right" }]
            rows: (card.ep.levels || []).map(function (l, i) { return { key: String(i), cells: l } })
        }
        Item { width: 1; height: 8 }
        StatusCard {
            visible: card.ep.notApplicable !== undefined
            width: parent.width
            tone: "warn"; title: "不能回放"
            Label { width: parent.width; wrap: true; text: card.ep.notApplicable || ""; size: 13 }
        }
        AutoTable {
            visible: card.ep.notApplicable === undefined
            width: parent.width
            columns: [{ key: "k", title: "结局对比" }, { key: "v", title: "盈亏", align: "right" }, { key: "note", title: "说明" }]
            rows: (card.ep.outcomes || []).map(function (o) { return { key: o.k, cells: o } })
        }
        Item { visible: card.ep.notApplicable === undefined; width: 1; height: 8 }
        AutoTable {
            visible: card.ep.notApplicable === undefined
            width: parent.width
            empty: "策略在这段数据里没有出手"
            columns: [{ key: "time", title: "时间" }, { key: "phase", title: "阶段" }, { key: "qty", title: "张数", align: "right" },
                      { key: "price", title: "蝶价", align: "right" }, { key: "pnl", title: "盈亏", align: "right" }, { key: "rule", title: "规则" }]
            rows: (card.ep.events || []).map(function (e, i) {
                return { key: String(i), cells: { time: e.time, phase: { text: e.phase, tag: true }, qty: e.qty, price: e.price, pnl: e.pnl, rule: e.rule } }
            })
        }
        // 卡片里的列表(.status-card ul 压过 .review-notes):上 6、左 16、11.5px;info 卡片里是正文色
        NoteList { visible: (card.ep.notes || []).length > 0; width: parent.width; topPadding: 6; notes: card.ep.notes || []; ink: Theme.label }
    }

    component NoteList: Column {
        property var notes: []
        property color ink: Theme.label
        Repeater {
            model: parent.notes
            Item {
                required property var modelData
                width: parent ? parent.width : 0
                height: li.implicitHeight
                Label { x: 5; text: "•"; size: 11.5; color: parent.parent ? parent.parent.ink : Theme.label }
                Label { id: li; x: 16; width: parent.width - 16; wrap: true; text: modelData; size: 11.5; color: parent.parent ? parent.parent.ink : Theme.label }
            }
        }
    }
}
