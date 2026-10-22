import QtQuick
import Dafri.Kit

// 回测页的「参数扫描 · 样本外」(lib/SweepPanel.tsx):网格、样本内占比、滚动前推、挑参数的口径;结果的总览、每组的表(10 行一页)、滚动前推的每一折。
// 数字全是引擎 backtest.sweep 算的;模型是 controller.page.sweep(shell/backtest_rules 的 sweepModel)
Column {
    id: root
    property var controller: null
    property var sw: ({})
    readonly property var res: sw.result || null

    // .hint 的上 7 与节标题的下 9 合并
    Hint { visible: !root.sw.sweepable; topPadding: 0; text: root.sw.hint || "" }

    Group {
        visible: !!root.sw.sweepable
        width: root.width
        hint: "参数只在样本内挑,成绩看样本外;滚动前推每一折只用之前的数据挑参数,连起来的收益才是不偷看未来的数。"
        GroupRow {
            width: parent.width
            label: "再加几只"; sub: "逗号分隔,最多共 8 只;得分取平均"
            Input {
                width: 240
                placeholder: "如 MSFT, AMZN"
                text: root.sw.extra || ""
                onEdited: function (t) { if (root.controller) root.controller.setSweepExtra(t) }
            }
        }
        // 模型只放键:敲字时行不重建(同 BacktestPage 的参数行)
        Repeater {
            model: (root.sw.gridRows || []).map(function (g) { return g.key })
            GroupRow {
                id: gridRow
                required property var modelData
                required property int index
                readonly property var g: (root.sw.gridRows || [])[index] || ({})
                width: parent.width
                label: g.label || ""; sub: g.sub || ""
                Input {
                    width: 240
                    text: gridRow.g.value || ""
                    onEdited: function (t) { if (root.controller) root.controller.setSweepGrid(gridRow.modelData, t) }
                }
            }
        }
        GroupRow {
            width: parent.width
            label: "样本内占比"; sub: "%,50–90"
            InputNumber {
                width: 90
                min: 50; max: 90; step: 5
                value: root.sw.split === undefined ? null : root.sw.split
                onValueEdited: function (v) { if (root.controller) root.controller.setSweepSplit(v) }
            }
        }
        GroupRow {
            width: parent.width
            label: "滚动前推"; sub: "折数,2–6;0 = 不做"
            InputNumber {
                width: 90
                min: 0; max: 6; step: 1
                value: root.sw.folds === undefined ? null : root.sw.folds
                onValueEdited: function (v) { if (root.controller) root.controller.setSweepFolds(v) }
            }
        }
        GroupRow {
            width: parent.width
            label: "挑参数按"
            Segmented {
                small: true
                options: [{ value: "return", label: "总收益" }, { value: "calmar", label: "收益回撤比(总收益 ÷ 最大回撤)" }]
                value: root.sw.objective
                onActivated: function (v) { if (root.controller) root.controller.setSweepObjective(v) }
            }
        }
    }
    Item { visible: !!root.sw.sweepable; width: 1; height: 14 }
    // .row.tight:按钮 + 一句说明;下 10
    Item {
        visible: !!root.sw.sweepable
        width: root.width
        height: 32 + 10
        Row {
            height: 32
            spacing: 8
            Button {
                text: "扫参数 · 看样本外"
                busy: !!root.sw.running
                enabled: !!root.sw.canRun
                onClicked: if (root.controller) root.controller.runSweep()
            }
            Label { anchors.verticalCenter: parent.verticalCenter; text: "用上面的标的、区间、品种与成交成本"; size: 11; color: Theme.labelSecondary }
        }
    }
    Working { visible: !!root.sw.running; text: "正在逐只拉日线、试每一组参数…" }
    StatusCard {
        visible: !!root.sw.failure
        width: root.width
        tone: "bad"; title: "扫描失败"
        Label { width: parent.width; wrap: true; text: root.sw.failure || ""; size: 13 }
    }
    StatusCard {
        visible: !!root.res
        width: root.width
        tone: root.res ? root.res.tone : "info"
        title: root.res ? root.res.title : ""
        Grid {
            id: tiles
            readonly property var list: root.res ? root.res.tiles : []
            width: parent.width
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
        Meta { width: parent.width; topPadding: 0; items: (root.res ? root.res.meta : []).map(function (t) { return { text: t } }) }
    }
    // .review-table:上 8
    Item { visible: !!root.res; width: 1; height: 8 }
    AutoTable {
        visible: !!root.res
        width: root.width
        columns: [{ key: "params", title: "参数" }, { key: "is", title: "样本内", align: "right" }, { key: "oos", title: "样本外", align: "right" },
                  { key: "bench", title: "样本外买入持有", align: "right" }, { key: "excess", title: "样本外超额", align: "right" },
                  { key: "dd", title: "样本外回撤", align: "right" }, { key: "rank", title: "样本外名次", align: "right", width: 90 }]
        rows: (root.res ? root.res.rows : []).map(function (x) {
            return { key: x.key, cells: {
                params: { text: x.params, suffix: x.untested ? " · 几乎没回撤过" : "", tip: x.untested ? "样本内的回撤还不到它在场时一天的典型波动:基本没经历过回撤(多半只进过一两次场),名次不可靠" : "" },
                is: { text: x.is, tone: x.isTone }, oos: { text: x.oos, tone: x.oosTone }, bench: x.bench,
                excess: { text: x.excess, tone: x.excessTone }, dd: x.dd, rank: x.rank } }
        })
    }
    // 分页:靠右,上下 16;只有一页时不出
    Item {
        visible: !!root.res && root.res.pages > 1
        width: root.width
        height: visible ? 16 + 24 + 16 : 0
        Pager {
            anchors.right: parent.right
            y: 16
            items: root.res ? root.res.pager : []
            current: root.res ? root.res.page : 1
            pages: root.res ? root.res.pages : 1
            showSize: !!(root.res && root.res.sizeChanger)
            onPicked: function (p) { if (root.controller) root.controller.setSweepPage(p) }
        }
    }
    Item { visible: !!(root.res && root.res.folds); width: 1; height: 8 }
    AutoTable {
        visible: !!(root.res && root.res.folds)
        width: root.width
        columns: [{ key: "trainEnd", title: "训练到" }, { key: "test", title: "测试段" }, { key: "params", title: "当时选的参数" },
                  { key: "ret", title: "测试段收益", align: "right" }, { key: "bench", title: "买入持有", align: "right" }]
        rows: (root.res && root.res.folds ? root.res.folds : []).map(function (f) {
            return { key: f.key, cells: { trainEnd: f.trainEnd, test: f.test,
                params: { text: f.params, suffix: f.untested ? " · 几乎没回撤过" : "" },
                ret: { text: f.ret, tone: f.retTone }, bench: f.bench } }
        })
    }
}
