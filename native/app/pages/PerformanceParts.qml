import QtQuick
import Dafri.Kit

// 绩效体检的各段(lib/PerformanceParts.tsx、PerformanceExtras.tsx、PositionSizer.tsx、SignalScorecard.tsx)。模型是 controller.page 的各段(shell/performance_rules)。
// 量的(浏览器 1360 宽):卡片一张接一张、中间没有间距;结论 / 建议 / 信号各组是 .perf-findings(auto-fit、最窄 320、间距 10);
// 分组表是 .perf-groups(最窄 340、横 16 竖 4,品种那张占整行);卡片里的 .stat-grid 上下 10 与后面 .card-meta 的上 6 合并成 10
QtObject {
    // .stat-grid:每格最窄 150、等分、间距 8,上下 10;格子比列少时按格数分(auto-fit)
    component Tiles: Grid {
        id: tiles
        property var list: []
        topPadding: 10; bottomPadding: 10
        columnSpacing: 8; rowSpacing: 8
        columns: Math.max(1, Math.min(list.length, Math.floor((width + 8) / (150 + 8))))
        Repeater {
            model: tiles.list
            StatTile {
                required property var modelData
                width: (tiles.width - (tiles.columns - 1) * 8) / tiles.columns
                label: modelData.label; value: modelData.value; tone: modelData.tone || ""
            }
        }
    }

    // 卡片正文的一段字(13px)+「借鉴:…」(.perf-source:上 6)
    component Body: Column {
        property string text: ""
        property string source: ""
        Label { width: parent.width; wrap: true; text: parent.text; size: 13 }
        Meta { width: parent.width; items: parent.source ? [parent.source] : [] }
    }

    component Findings: CardGrid {
        id: fg
        property var findings: []
        minWidth: 320; columnGap: 10; rowGap: 10
        Repeater {
            model: fg.findings
            StatusCard {
                required property var modelData
                tone: modelData.tone; title: modelData.title
                Body { width: parent.width; text: modelData.text; source: modelData.source }
            }
        }
    }

    component Advice: CardGrid {
        id: ag
        property var advice: []
        property var controller: null
        minWidth: 320; columnGap: 10; rowGap: 10
        Repeater {
            model: ag.advice
            StatusCard {
                required property var modelData
                tone: "warn"; title: modelData.title
                extra: Button {
                    small: true; text: "按建议填入"
                    busy: !!modelData.busy
                    onClicked: if (ag.controller) ag.controller.applyAdvice(modelData.rule)
                }
                Body { width: parent.width; text: modelData.reason; source: modelData.source }
            }
        }
    }

    component Stats: StatusCard {
        id: sc
        property var s: ({})
        title: s.title || ""
        Tiles { width: parent.width; list: sc.s.tiles || [] }
        Meta { width: parent.width; topPadding: 0; items: sc.s.meta1 || [] }
        Meta { width: parent.width; items: sc.s.meta2 || [] }
    }

    // .chart-wrap.short:上 6、220 高
    component Equity: StatusCard {
        id: ec
        property string meta: ""
        property var controller: null
        title: "平仓权益曲线(按笔)"
        Item {
            width: parent.width; height: 6 + 220
            Chart { y: 6; width: parent.width; height: 220; source: ec.controller ? ec.controller.equityChart : null }
        }
        Meta { width: parent.width; items: ec.meta ? [ec.meta] : [] }
    }

    component Groups: StatusCard {
        id: grp
        property var g: ({})
        title: "分开看:优势在哪儿"
        CardGrid {
            width: parent.width
            minWidth: 340; columnGap: 16; rowGap: 4; stretch: false
            Repeater {
                model: grp.g.tables || []
                Column {
                    required property var modelData
                    readonly property bool spanAll: !!modelData.wide
                    // .perf-group h4:上 6、11px 500 二级色
                    Label { topPadding: 6; text: modelData.title; size: 11; weight: Theme.weightMedium; color: Theme.labelSecondary; css: 16.17 }
                    Item { width: 1; height: 8 }  // .review-table 的上 8
                    AutoTable {
                        width: parent.width
                        scrollX: !!parent.modelData.wide
                        columns: {
                            var c = [{ key: "label", title: "" }, { key: "trades", title: "笔数", align: "right" }, { key: "win_rate", title: "胜率", align: "right" },
                                     { key: "net_pnl", title: "净盈亏", align: "right" }, { key: "expectancy", title: "每笔期望", align: "right" },
                                     { key: "profit_factor", title: "利润因子", align: "right" }]
                            if (parent.modelData.wide)
                                c = c.concat([{ key: "payoff_ratio", title: "盈亏比", align: "right" }, { key: "kelly", title: "凯利", align: "right" },
                                              { key: "expectancy_r", title: "R 期望", align: "right" }, { key: "payoff_r", title: "R 盈亏比", align: "right" },
                                              { key: "kelly_r", title: "R 凯利", align: "right" }, { key: "sqn", title: "SQN", align: "right" }])
                            return c
                        }
                        rows: parent.modelData.rows
                    }
                }
            }
        }
        Meta { width: parent.width; items: grp.g.meta || [] }
    }

    // 表下的分页(AntD:靠右、上下 16;只有一页时不出)。它在 .ant-table-wrapper 里(自成一块),下 16 不和后面 .card-meta 的上 6 合并
    component TablePager: Item {
        id: tp
        property var t: ({})
        property int pageSize: 10
        signal picked(int page)
        visible: (t.pages || 1) > 1
        height: visible ? 16 + 24 + 16 : 0
        Pager {
            anchors.right: parent.right
            y: 16
            items: tp.t.pager || []
            current: tp.t.page || 1
            pages: tp.t.pages || 1
            pageSize: tp.pageSize
            showSize: !!tp.t.sizeChanger
            onPicked: function (p) { tp.picked(p) }
        }
    }

    component Execution: StatusCard {
        id: xc
        property var e: ({})
        property var controller: null
        tone: e.tone || "info"
        title: e.title || ""
        Tiles { width: parent.width; list: xc.e.tiles || [] }
        AutoTable {
            visible: !!xc.e.table
            width: parent.width
            columns: [{ key: "at", title: "触发", width: 110 }, { key: "symbol", title: "标的" }, { key: "path", title: "路径" },
                      { key: "px", title: "触发价 → 成交", align: "right" }, { key: "cost", title: "让出(不含佣金)", align: "right" },
                      { key: "commission", title: "佣金", align: "right" }]
            rows: xc.e.table ? xc.e.table.rows : []
        }
        TablePager {
            width: parent.width
            t: xc.e.table || ({})
            onPicked: function (p) { if (xc.controller) xc.controller.setExecPage(p) }
        }
        Meta {
            width: parent.width
            topPadding: !xc.e.table ? 0 : 6
            items: xc.e.meta || []
        }
    }

    component Sizer: StatusCard {
        id: zc
        property var sz: ({})
        property var controller: null
        readonly property bool hasTiles: !!sz.tiles
        tone: sz.tone || "info"
        title: "仓位计算器 · 固定风险比例"
        // .sizer-inputs:横 20(放不下折行)、下 4;每一项是竖排的 11px 二级色名 + 间距 4 + 160 宽的数字框
        Flow {
            width: parent.width
            spacing: 20
            bottomPadding: 4
            SizerInput {
                label: "账户权益(美元)"; min: 0; step: 1000; placeholder: "例如 50000"
                value: zc.sz.equity === undefined ? null : zc.sz.equity
                onEdited: function (v) { if (zc.controller) zc.controller.setSizerEquity(v) }
            }
            SizerInput {
                label: "单笔风险(%)"; min: 0.1; max: 10; step: 0.25
                value: zc.sz.pct === undefined ? null : zc.sz.pct
                onEdited: function (v) { if (zc.controller) zc.controller.setSizerPct(v) }
            }
            SizerInput {
                label: "每份最大亏损(美元)"; min: 0; step: 10; placeholder: "蝶 = 权利金 × 100"
                value: zc.sz.unit === undefined ? null : zc.sz.unit
                onEdited: function (v) { if (zc.controller) zc.controller.setSizerUnit(v) }
            }
        }
        Tiles { visible: zc.hasTiles; width: parent.width; topPadding: 6; list: zc.sz.tiles || [] }
        // p.hint 的上 7 与 .sizer-inputs 的下 4 合并
        Hint { visible: !zc.hasTiles; width: parent.width; topPadding: 3; text: "填上账户权益、单笔风险与每份最大亏损,就能算出做几份。"; textFormat: Text.PlainText }
        Meta { width: parent.width; topPadding: zc.hasTiles ? 0 : 6; items: zc.sz.meta || [] }
    }

    component SizerInput: Column {
        id: si
        property string label: ""
        property real min: -Infinity
        property real max: Infinity
        property real step: 1
        property string placeholder: ""
        property var value: null
        signal edited(var v)
        spacing: 4
        Label { text: si.label; size: 11; color: Theme.labelSecondary; css: 16.17 }
        InputNumber {
            width: 160
            min: si.min; max: si.max; step: si.step
            placeholder: si.placeholder
            value: si.value
            onValueEdited: function (v) { si.edited(v) }
        }
    }

    component Ledger: StatusCard {
        id: lc
        property var l: ({})
        property var controller: null
        title: l.title || ""
        // 「交易」一列 ellipsis:AntD 换成 table-layout: fixed。.review-table 上 8
        Item { width: 1; height: 8 }
        AutoTable {
            width: parent.width
            fixed: true
            columns: [{ key: "closed_at", title: "了结", width: 110 }, { key: "label", title: "交易", ellipsis: true }, { key: "pnl", title: "盈亏", align: "right" },
                      { key: "r", title: "R", align: "right", width: 70 }, { key: "hold", title: "持有", align: "right", width: 90 }]
            rows: lc.l.table ? lc.l.table.rows : []
        }
        TablePager {
            width: parent.width
            t: lc.l.table || ({})
            pageSize: 20
            onPicked: function (p) { if (lc.controller) lc.controller.setLedgerPage(p) }
        }
        Meta { width: parent.width; items: lc.l.meta || [] }
    }

    component Signals: Column {
        id: sg
        property var s: ({})
        property var controller: null
        readonly property var groups: s.groups || []
        // .row.tight:按钮 + .muted 的一句;下 10
        Item {
            width: parent.width
            height: 24 + 10
            Row {
                spacing: 8
                Button {
                    small: true
                    text: sg.s.button || "给信号打分"
                    busy: !!sg.s.loading
                    onClicked: if (sg.controller) sg.controller.scoreSignals()
                }
                Label {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "价位提醒、盯异动、强势股新入选、K线 PA 读出的方向,每一条之后押对了没有;要连 TWS 取日线"
                    size: 11; color: Theme.labelSecondary
                }
            }
        }
        Working { visible: !!sg.s.working; text: "正在逐只取日线…" }
        StatusCard {
            visible: !!sg.s.error
            width: parent.width
            tone: "bad"; title: "算不出来"
            Label { width: parent.width; wrap: true; text: sg.s.error || ""; size: 13 }
        }
        EmptyState { visible: !!sg.s.empty; compact: true; width: parent.width; text: sg.s.empty || "" }
        CardGrid {
            visible: sg.groups.length > 0
            width: parent.width
            minWidth: 320; columnGap: 10; rowGap: 10
            Repeater {
                model: sg.groups
                StatusCard {
                    required property var modelData
                    tone: modelData.tone; title: modelData.title
                    // 结论放正文:标题一行放不下会被截断,而这句话是整张卡最要紧的
                    Label { width: parent.width; wrap: true; text: modelData.verdict; size: 13 }
                    Item { width: 1; height: 8 }
                    AutoTable {
                        width: parent.width
                        columns: [{ key: "h", title: "持有" }, { key: "n", title: "走完(条)", align: "right" }, { key: "indep", title: "不重叠(段)", align: "right" },
                                  { key: "mean", title: "平均", align: "right" }, { key: "hit", title: "押对", align: "right" }, { key: "base", title: "随手一天", align: "right" },
                                  { key: "edge", title: "多出", align: "right" }, { key: "t", title: "t", align: "right" }]
                        rows: modelData.rows
                    }
                }
            }
        }
        Meta { visible: sg.groups.length > 0; width: parent.width; items: sg.s.meta || [] }
        Primer {
            visible: sg.groups.length > 0
            width: parent.width
            id_: "signal-scorecard"
            intro: false
            defaultOpen: true
            // 量的:上 16(.card-meta 之后);说明是几段 <p>:12px 正文色、行高 1.47,段间 12,第一段离说明区的上边 12
            topPadding: 16
            summary: "这些数是怎么算的、能信到什么程度"
            Column {
                width: parent.width
                topPadding: 12
                spacing: 12
                Repeater {
                    model: sg.s.notes || []
                    Label { required property var modelData; width: parent.width; wrap: true; text: modelData; size: 12 }
                }
            }
        }
    }
}
