import QtQuick
import Dafri.Kit

// 自定义策略的条件搭建器(lib/RuleBuilder.tsx):一行「一句话 + AI 生成条件」(.row.tight,下 6);
// 两组条件(.rule-group:上 8、内边距 8 × 10、填充底、8 圆角):一行三级色的标题,每条条件一行(上下 6、间距 6、放不下就折行:
// 左算子 [周期 / 数值]、运算、右算子 [周期 / 数值]、✕),最后「+ 添加条件」(上 4)。
// 模型:controller.page.builder(shell/backtest_rules);改动全交给 controller(shell/backtest_controller)
Column {
    id: root
    property var controller: null
    property var b: ({})
    readonly property var indicatorOptions: [
        { value: "close", label: "收盘价" }, { value: "open", label: "开盘价" }, { value: "high", label: "最高价" }, { value: "low", label: "最低价" },
        { value: "sma", label: "SMA均线" }, { value: "ema", label: "EMA均线" }, { value: "rsi", label: "RSI" },
        { value: "highest", label: "前N日最高" }, { value: "lowest", label: "前N日最低" }, { value: "change_pct", label: "N日涨跌幅%" },
        { value: "const", label: "常数" }
    ]
    readonly property var opOptions: [{ value: ">", label: ">" }, { value: "<", label: "<" }, { value: ">=", label: "≥" }, { value: "<=", label: "≤" },
                                      { value: "cross_up", label: "上穿" }, { value: "cross_down", label: "下穿" }]

    // .row.tight(下 6,与下面那组的上 8 合并成 8)
    Item {
        width: root.width
        height: 31.9
        Input {
            id: textInput
            width: parent.width - 8 - genBtn.width
            maximumLength: 1000
            placeholder: "用文字描述,如:RSI跌破30且收盘价高于200日均线时买入,RSI回到70卖出"
            text: root.b.text || ""
            onEdited: function (t) { if (root.controller) root.controller.setRuleText(t.slice(0, 1000)) }
            onAccepted: if (root.controller) root.controller.generateRules()
        }
        Button {
            id: genBtn
            anchors.right: parent.right
            y: (31.9 - height) / 2
            small: true
            kind: "primary"
            text: root.b.button || "AI 生成条件"
            busy: !!root.b.generating
            onClicked: if (root.controller) root.controller.generateRules()
        }
    }
    // 两组的模型只放键、每组的条件只放条数:改一个数时不重建(重建了正在打字的框会丢焦点)
    Repeater {
        model: (root.b.sections || []).map(function (x) { return x.key })
        Item {
            id: sec
            required property int index
            readonly property var modelData: (root.b.sections || [])[index] || ({ key: "", title: "", conds: [] })
            width: root.width
            height: 8 + box.height
            Rectangle {
                id: box
                y: 8
                width: parent.width
                height: 8 + 16.2 + flow.implicitHeight + 8
                radius: 8
                color: Theme.bgFill
                Label { x: 10; y: 8; text: sec.modelData.title; size: 11; color: Theme.labelSecondary }
                // 每条条件是一个行内的 Space(上下 6),「+ 添加条件」也是行内的(按基线对齐,比条件那一行低 4.7);放得下就排在同一行
                Flow {
                    id: flow
                    x: 10; y: 8 + 16.2
                    width: parent.width - 20
                    Repeater {
                        model: sec.modelData.conds.length
                        Item {
                            id: condRow
                            required property int index
                            readonly property var modelData: sec.modelData.conds[index] || ({ left: {}, op: "", right: {} })
                            width: condInner.implicitWidth
                            height: 6 + 32.1 + 6
                            Row {
                                id: condInner
                                y: 6
                                spacing: 6
                                OperandEditor { side: "left"; o: condRow.modelData.left; section: sec.modelData.key; index: condRow.index }
                                Select {
                                    width: 90
                                    options: root.opOptions
                                    value: condRow.modelData.op
                                    onActivated: function (v) { if (root.controller) root.controller.setOp(sec.modelData.key, condRow.index, v) }
                                }
                                OperandEditor { side: "right"; o: condRow.modelData.right; section: sec.modelData.key; index: condRow.index }
                                Button {
                                    anchors.verticalCenter: parent.verticalCenter
                                    small: true; kind: "text"; text: "✕"
                                    onClicked: if (root.controller) root.controller.removeCondition(sec.modelData.key, condRow.index)
                                }
                            }
                        }
                    }
                    Item {
                        width: addBtn.width
                        height: sec.modelData.conds.length ? 6 + 32.1 + 6 : 4 + 24
                        Button {
                            id: addBtn
                            y: sec.modelData.conds.length ? 10.7 : 4
                            small: true
                            text: "+ 添加条件"
                            onClicked: if (root.controller) root.controller.addCondition(sec.modelData.key)
                        }
                    }
                }
            }
        }
    }

    // 一个算子:下拉(130)+ 要周期 / 是常数时一个数字框(76),间距 6
    component OperandEditor: Row {
        id: op
        property string side: ""
        property var o: ({})
        property string section: ""
        property int index: 0
        spacing: 6
        Select {
            width: 130
            options: root.indicatorOptions
            value: op.o.choice
            onActivated: function (v) { if (root.controller) root.controller.pickOperand(op.section, op.index, op.side, v) }
        }
        InputNumber {
            visible: !!op.o.needsNum
            width: 76
            placeholder: op.o.placeholder || ""
            value: op.o.num === undefined ? null : op.o.num
            onValueEdited: function (v) { if (root.controller) root.controller.setOperandNumber(op.section, op.index, op.side, v) }
        }
    }
}
