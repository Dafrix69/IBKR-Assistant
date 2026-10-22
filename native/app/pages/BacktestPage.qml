import QtQuick
import Dafri.Kit

// 回测(pages/Backtest.tsx):纯计算展示,历史数据来自 TWS。上面一组表单(标的、区间、策略与参数 / 自定义条件、交易品种、成本),
// 随表单生成的策略流程,「运行回测」与结果;下面一节参数扫描。模型与取数都在 C++(shell/backtest_controller、shell/backtest_rules);
// 切走这一页状态清空,同原版组件卸载。不下单
ScrollPage {
    id: page
    property var controller: null
    readonly property var m: controller ? controller.page : ({})
    Component.onCompleted: if (controller) controller.setVisible(true)
    Component.onDestruction: if (controller) controller.setVisible(false)

    PageHead {
        width: parent.width
        title: "回测"
        Label { text: page.m.headExtra || ""; size: 11; color: Theme.labelSecondary }
    }

    Group {
        width: parent.width
        hint: page.m.hint || ""
        GroupRow {
            width: parent.width
            label: "标的"
            Input {
                width: 190
                maximumLength: 12
                placeholder: "如 NVDA、SPX"
                text: page.m.symbol || ""
                onEdited: function (t) { if (page.controller) page.controller.setSymbol(t.slice(0, 12)) }
            }
        }
        GroupRow {
            width: parent.width
            label: "区间"; sub: "日线,含首尾"
            DateRangePicker {
                width: 300
                start: page.m.start || ""
                end: page.m.end || ""
                onActivated: function (s, e) { if (page.controller) page.controller.setRange(s, e) }
            }
        }
        GroupRow {
            width: parent.width
            label: "策略"
            Select {
                width: Math.min(320, page.width)
                options: page.m.strategyOptions || []
                value: page.m.strategy || undefined
                onActivated: function (v) { if (page.controller) page.controller.setStrategy(v) }
            }
        }
        // stacked:控件占满一行(上下 11、左右 16)
        Item {
            visible: !!page.m.builder
            width: parent.width
            height: visible ? 11 + builder.implicitHeight + 11 : 0
            RuleBuilder {
                id: builder
                x: 16; y: 11
                width: parent.width - 32
                controller: page.controller
                b: page.m.builder || ({})
            }
        }
        // 行的模型只放键:敲一个字页面模型就重算一遍,键没变 Repeater 就不重建(重建了正在打字的框会丢焦点,后面的字落空)
        Repeater {
            model: (page.m.params || []).map(function (p) { return p.key })
            NumberRow {
                required property var modelData
                required property int index
                readonly property var p: (page.m.params || [])[index] || ({})
                width: parent.width
                label: p.label || ""; sub: p.sub || ""
                value: p.value === undefined ? null : p.value
                onValueEdited: function (v) { if (page.controller) page.controller.setParam(modelData, v) }
            }
        }
        GroupRow {
            width: parent.width
            label: "交易品种"
            Select {
                width: Math.min(320, page.width)
                options: page.m.instOptions || []
                value: page.m.instType
                onActivated: function (v) { if (page.controller) page.controller.setInstType(v) }
            }
        }
        Repeater {
            model: (page.m.instRows || []).map(function (r) { return r.key })
            NumberRow {
                required property var modelData
                required property int index
                readonly property var r: (page.m.instRows || [])[index] || ({})
                width: parent.width
                label: r.label || ""; sub: r.sub || ""
                min: r.min === undefined ? -Infinity : r.min; max: r.max === undefined ? Infinity : r.max; step: r.step || 1
                value: r.value === undefined ? null : r.value
                onValueEdited: function (v) { if (page.controller) page.controller.setInst(modelData, v) }
            }
        }
        NumberRow {
            width: parent.width
            label: "每边成交成本"; sub: page.m.cost ? page.m.cost.sub : ""
            min: 0; max: 10; step: 0.05
            value: page.m.cost && page.m.cost.value !== undefined ? page.m.cost.value : null
            onValueEdited: function (v) { if (page.controller) page.controller.setCost(v) }
        }
    }
    // .hint 的上 7 与分组的下 14 合并
    // 字由模型给(同 SSR 比的那一份:原版 JSX 跨行处并成一个空格)
    Hint {
        visible: !!page.m.optionHint
        topPadding: 14
        text: page.m.optionHint || ""
    }

    SectionTitle { width: parent.width; text: "策略流程" }
    // .flow:填充底、20 圆角、内边距 12、两行间距 10、下 12;放不下横着滚
    Item {
        visible: !!page.m.flow
        width: parent.width
        height: visible ? flowBox.height + 12 : 0
        Rectangle {
            id: flowBox
            width: parent.width
            height: 12 + flowCol.implicitHeight + 12
            radius: Theme.radiusCard
            color: Theme.bgFill
            clip: true
            Flickable {
                x: 12; y: 12
                width: parent.width - 24
                height: flowCol.implicitHeight
                contentWidth: flowCol.implicitWidth
                flickableDirection: Flickable.HorizontalFlick
                boundsBehavior: Flickable.StopAtBounds
                interactive: contentWidth > width
                Column {
                    id: flowCol
                    spacing: 10
                    readonly property var f: page.m.flow || ({})
                    Row {
                        spacing: 6
                        FlowCard { kind: "start"; title: "开始"; body: "每根日线收盘评估" }
                        FlowArrow { text: "→" }
                        FlowCard { kind: "cond"; title: "持仓是否为空?"; body: "持有数量 = 0?" }
                        FlowArrow { text: "—是→" }
                        FlowCard { kind: "cond"; title: "入场条件是否满足?"; body: flowCol.f.entry || "" }
                        FlowArrow { text: "—是→" }
                        FlowCard { kind: "action"; title: "开仓"; body: flowCol.f.buy || "" }
                    }
                    Row {
                        spacing: 6
                        FlowArrow { text: "　　　　└—否→" }
                        FlowCard { visible: typeof flowCol.f.exit === "string"; kind: "cond"; title: "出场条件是否满足?"; body: flowCol.f.exit || "" }
                        FlowArrow { visible: typeof flowCol.f.exit === "string"; text: "—是→" }
                        FlowCard { visible: typeof flowCol.f.exit === "string"; kind: "action"; title: "平仓"; body: flowCol.f.sell || "" }
                        FlowCard { visible: typeof flowCol.f.exit !== "string"; kind: "action"; title: "继续持有"; body: flowCol.f.hold || "" }
                    }
                }
            }
        }
    }
    // .row.tight:运行回测 + 一句说明;下 10(下面什么都没有时并进节标题的上 24)
    Item {
        width: parent.width
        height: 32 + (page.m.running || page.m.failure || page.m.result ? 10 : 0)
        Row {
            height: 32
            spacing: 8
            Button {
                kind: "primary"
                text: "运行回测"
                busy: !!page.m.running
                onClicked: if (page.controller) page.controller.run()
            }
            Label { anchors.verticalCenter: parent.verticalCenter; text: "数据来自 TWS,需先连接引擎 · 仅供研究参考"; size: 11; color: Theme.labelSecondary }
        }
    }
    Column {
        width: parent.width
        Working { visible: !!page.m.running; text: "正在拉取历史数据并回测…" }
        StatusCard {
            visible: !!page.m.failure
            width: parent.width
            tone: "bad"; title: "回测失败"
            Label { width: parent.width; wrap: true; text: page.m.failure || ""; size: 13 }
        }
        BacktestResult {
            visible: !!page.m.result
            width: parent.width
            r: page.m.result || ({})
            chartSource: page.controller ? page.controller.chart : null
        }
    }

    SectionTitle { width: parent.width; text: "参数扫描 · 样本外" }
    SweepPanel {
        width: parent.width
        controller: page.controller
        sw: page.m.sweep || ({})
    }

    // 流程图的一张卡片(.flow-card:内边距 6 × 10、卡片面、0.5px 发丝边、6 圆角、12px、最宽 260):标题前一颗 7px 的圆点(开始蓝、判断橙、动作绿),
    // 标题 600、下 2;正文 11px 二级色
    component FlowCard: Rectangle {
        id: fc
        property string kind: "start"
        property string title: ""
        property string body: ""
        // 最宽 260(含内边距 10 × 2 与 0.5 × 2 的边):字最多排 239
        readonly property real innerW: Math.min(239, Math.max(dot.width + 6 + titleL.implicitWidth, bodyL.implicitWidth))
        anchors.verticalCenter: parent ? parent.verticalCenter : undefined
        width: innerW + 20 + 1
        height: 0.5 + 6 + titleL.implicitHeight + 2 + (body !== "" ? bodyL.implicitHeight : 0) + 6 + 0.5
        radius: 6
        color: Theme.bgElevated
        border.width: 0.5; border.color: Theme.separator
        Rectangle {
            id: dot
            x: 10.5; y: 0.5 + 6 + (titleL.implicitHeight - 7) / 2
            width: 7; height: 7; radius: 3.5
            color: fc.kind === "cond" ? Theme.orange : fc.kind === "action" ? Theme.green : Theme.blue
        }
        Label { id: titleL; x: 10.5 + 7 + 6; y: 6.5; text: fc.title; size: 12; weight: 600 }
        Label {
            id: bodyL
            visible: fc.body !== ""
            x: 10.5; y: 6.5 + titleL.implicitHeight + 2
            width: fc.innerW; wrap: true
            text: fc.body; size: 11; color: Theme.labelSecondary
        }
    }
    // 箭头(.flow-arrow:11px 二级色,不折行)
    component FlowArrow: Label {
        anchors.verticalCenter: parent ? parent.verticalCenter : undefined
        size: 11; color: Theme.labelSecondary
    }
}
