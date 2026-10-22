import QtQuick
import Dafri.Kit

// K 线读盘的结果(lib/PaPanel.tsx 的 #pa-result + lib/PaVerdict.tsx):一列卡片,间距 8(.cards)。
// 判断全在引擎,这里只摆(模型在 shell/market_rules 的 pageModel().pa)
Column {
    id: root
    property var pa: ({})
    property var controller: null
    spacing: 8

    readonly property var v: pa.verdict || ({})

    // ---- 结论:分数 + 三个子分与高周期 + 正在形成的那一根 + readout
    StatusCard {
        width: root.width
        tone: root.v.tone || "info"
        title: root.v.title || ""
        // .row.tight:分数(等宽 16px 700,按正负着色)与一行 11px 二级色,竖直居中、间距 8、下 10
        Item {
            width: parent.width
            height: score.implicitHeight + 10
            Label {
                id: score
                text: root.v.score || ""
                size: 16; weight: 700; family: Theme.fontMono; letterSpacing: -0.32; tnum: true
                color: root.v.side === "up" ? Theme.upText : root.v.side === "down" ? Theme.downText : Theme.labelSecondary
            }
            Label { x: score.implicitWidth + 8; y: (score.implicitHeight - implicitHeight) / 2; text: root.v.meta || ""; size: 11; color: Theme.labelSecondary }
        }
        // .stat-grid.pa-subs:四格并排(每格最窄 150、等分)、间距 8,上 10 下 4(上 10 与上一行的下 10 合并)
        Grid {
            id: subs
            visible: (root.v.subs || []).length > 0
            width: parent.width
            bottomPadding: 4
            columnSpacing: 8; rowSpacing: 8
            columns: Math.max(1, Math.min((root.v.subs || []).length, Math.floor((width + 8) / (150 + 8))))
            Repeater {
                model: root.v.subs || []
                StatTile {
                    required property var modelData
                    width: (subs.width - (subs.columns - 1) * 8) / subs.columns
                    mono: true
                    label: modelData.label; value: modelData.value; tone: modelData.tone
                }
            }
        }
        Meta { visible: !!root.v.subsMeta; width: parent.width; items: root.v.subsMeta ? [root.v.subsMeta] : [] }
        // 正在形成 / 数据未到齐(.pa-forming:上 10)
        Item {
            visible: !!root.v.forming
            width: parent.width
            height: visible ? 10 + forming.height : 0
            Alert {
                id: forming
                y: 10
                width: parent.width
                tone: "warn"
                title: root.v.forming ? root.v.forming.title : ""
                text: root.v.forming ? root.v.forming.body : ""
                // 未确认的那几条:说明下面一条一行(同样 11.5px 二级色)
                Column {
                    width: parent.width
                    Repeater {
                        model: root.v.forming ? root.v.forming.hints : []
                        Label { required property var modelData; width: parent.width; wrap: true; text: modelData; size: 11.5; css: 1.55; color: Theme.labelSecondary }
                    }
                }
            }
        }
        // readout:首句与拆不开的行(.reason,上 6),「字段:结论」两列(Descriptions:名 12px 二级色不折行,值 12px;行下 3,上 8)
        Repeater {
            model: root.v.prose || []
            Label { required property var modelData; width: parent.width; wrap: true; topPadding: 6; text: modelData; size: 11.5; color: Theme.labelSecondary }
        }
        Column {
            visible: (root.v.pairs || []).length > 0
            width: parent.width
            topPadding: 8
            Repeater {
                model: root.v.pairs || []
                // 名从 1 起(单元格里多 1),离值 10(AntD 无冒号时 ::after 的左 2 右 8);两边都是表格里的等宽数字;行高 1.55、行下 3
                Item {
                    required property var modelData
                    required property int index
                    width: parent.width
                    // 最后一行下面不留(AntD:最后一行的单元格下边距是 0)
                    height: Math.max(k.implicitHeight, val.implicitHeight) + (index === root.v.pairs.length - 1 ? 0 : 3)
                    Label { id: k; x: 1; text: modelData[0]; size: 12; css: 1.55; tnum: true; color: Theme.labelSecondary }
                    Label { id: val; x: k.x + k.implicitWidth + 10; width: parent.width - x; wrap: true; text: modelData[1]; size: 12; css: 1.55; tnum: true }
                }
            }
        }
    }

    // ---- K 线
    StatusCard {
        width: root.width
        title: root.pa.chart ? root.pa.chart.title : ""
        Item {
            visible: !!(root.pa.chart && root.pa.chart.show)
            width: parent.width
            // .pa-chart-wrap 上 6(量的:图顶离卡片顶 47、卡片高 504)
            height: visible ? 6 + 440 : 0
            Chart {
                y: 6
                width: parent.width; height: 440
                source: root.controller ? root.controller.chart : null
                wheel: true
            }
        }
    }

    // ---- 同一只的盘口
    StatusCard {
        id: bookCard
        width: root.width
        readonly property var b: root.pa.book || ({})
        title: b.title || ""
        extra: Row {
            spacing: 4
            Button { small: true; text: "刷新"; busy: !!bookCard.b.loading; onClicked: if (root.controller) root.controller.loadBook(root.pa.book.symbol) }
            Label { visible: !!root.pa.book && root.pa.book.followed; anchors.verticalCenter: parent.verticalCenter; text: "已关注"; size: 11; color: Theme.labelSecondary }
            Button { visible: !(root.pa.book && root.pa.book.followed); small: true; kind: "text"; text: "加入关注"; onClicked: if (root.controller) root.controller.addBook(root.pa.book.symbol) }
        }
        BookBody { width: parent.width; maxGrid: 720; inStatusCard: true; body: root.pa.book ? root.pa.book.body : ({}) }
    }

    // ---- 判断依据:按子分分组,每组一个小计(.pa-ev-group 之间 8)
    StatusCard {
        width: root.width
        id: evCard
        title: "判断依据(正 = 看涨)"
        readonly property var ev: root.pa.evidence || ({})
        Column {
            width: parent.width
            spacing: 8
            Repeater {
                model: evCard.ev.groups || []
                Column {
                    id: grp
                    required property var modelData
                    width: parent.width
                    // 组头(.pa-ev-head):上下 2、11.5px 590;名字、「这一组里多空都有」(11px 400 二级色)、小计靠右(最宽 84)
                    // 一行里混着等宽字(小计),按基线对齐后行盒比 11.5px 的一行多 0.5(量的:组头 21.4)
                    Item {
                        width: parent.width
                        height: 2 + headL.implicitHeight + 0.5 + 2
                        Row {
                            id: headRow
                            y: 2
                            spacing: 8
                            baselineOffset: headL.baselineOffset
                            Label { id: headL; text: modelData.label; size: 11.5; weight: Theme.weightSemibold }
                            Label { visible: modelData.mixed; anchors.baseline: headL.baseline; text: "这一组里多空都有"; size: 11; color: Theme.labelSecondary }
                        }
                        Weight { anchors.baseline: headRow.baseline; anchors.right: parent.right; minW: 84; text: modelData.score; side: modelData.side; bold: true }
                    }
                    Repeater {
                        model: modelData.rows
                        EvRow { required property var modelData; required property int index; width: parent.width; item: modelData; last: index === grp.modelData.rows.length - 1 }
                    }
                }
            }
            Repeater {
                model: evCard.ev.rows || []
                EvRow { required property var modelData; width: parent.width; item: modelData; last: false }
            }
        }
        Reason { text: "权重是手定的、固定在引擎里,没有按历史表现校过;不认同某条,可以从它那一组里减去再看。" }
    }

    // ---- 结构:摆动序列、最近三次结构事件、关键位
    StatusCard {
        width: root.width
        id: stCard
        readonly property var st: root.pa.structure || ({})
        title: st.title || ""
        Reason { visible: !!stCard.st.swings; text: stCard.st.swings || "" }
        Repeater { model: stCard.st.events || []; Reason { required property var modelData; text: modelData } }
        Repeater {
            model: stCard.st.levels || []
            // .pa-lv:上下 3、11.5px,间距 8、基线对齐:支撑 / 阻力(.status 11px 510)、价(等宽 590,最窄 66)、说明(11px 二级色)
            Row {
                required property var modelData
                topPadding: 3; bottomPadding: 3
                spacing: 8
                Label { id: lvTag; text: modelData.label; size: 11; weight: Theme.weightMedium; color: modelData.tint === "rejected" ? Theme.redText : Theme.greenText }
                Label { anchors.baseline: lvTag.baseline; width: Math.max(66, implicitWidth); text: modelData.price; size: 11.5; weight: Theme.weightSemibold; family: Theme.fontMono; tnum: true }
                Label { anchors.baseline: lvTag.baseline; text: modelData.meta; size: 11; color: Theme.labelSecondary }
            }
        }
    }

    StatusCard {
        width: root.width
        title: "流动性与形态"
        Repeater { model: root.pa.flow || []; Reason { required property var modelData; text: modelData } }
    }

    StatusCard {
        width: root.width
        tone: "warn"
        title: "关键价位"
        Repeater { model: root.pa.plan || []; Reason { required property var modelData; text: modelData } }
        Meta { width: parent.width; items: ["以上只是价位与条件,不是建议;本页不接下单链路,仅供研究参考。"] }
    }

    StatusCard {
        visible: !!root.pa.htf
        width: root.width
        tone: root.pa.htf ? root.pa.htf.tone : "warn"
        title: root.pa.htf ? root.pa.htf.title : ""
        Repeater { model: root.pa.htf ? root.pa.htf.rows : []; Reason { required property var modelData; text: modelData } }
    }

    StatusCard {
        visible: (root.pa.warnings || []).length > 0
        width: root.width
        tone: "bad"
        title: "这次分析的局限"
        // .status-card ul:上 6、左 16、11.5px 橙字(info / ok 的卡片是正文色)
        Bullets { items: root.pa.warnings || []; color: Theme.orangeText }
    }

    // ---- AI 解读(可选)
    StatusCard {
        id: aiCard
        width: root.width
        readonly property var ai: root.pa.ai || ({})
        readonly property var c: ai.comment || null
        title: "AI 解读(可选)"
        extra: Button { small: true; text: aiCard.ai.button || "AI 解读"; busy: !!aiCard.ai.loading; onClicked: if (root.controller) root.controller.comment() }
        Reason { text: "模型只拿到上面算好的事实,看不到原始 K 线;它只负责把事实串成叙述。" }
        // .card-title:13px 590,上 6 下 4
        Label { visible: !!aiCard.c; width: parent.width; wrap: true; topPadding: 6; bottomPadding: 4; text: aiCard.c ? aiCard.c.summary : ""; size: 13; weight: Theme.weightSemibold }
        Label { visible: !!(aiCard.c && aiCard.c.reading); width: parent.width; wrap: true; text: aiCard.c ? aiCard.c.reading : ""; size: 13 }
        Reason { visible: !!(aiCard.c && aiCard.c.watch.length); text: "盯:" }
        Bullets { visible: !!(aiCard.c && aiCard.c.watch.length); items: aiCard.c ? aiCard.c.watch : []; color: Theme.label }
        Reason { visible: !!(aiCard.c && aiCard.c.risks.length); text: "可能错在:" }
        Bullets { visible: !!(aiCard.c && aiCard.c.risks.length); items: aiCard.c ? aiCard.c.risks : []; color: Theme.label }
        Meta { visible: !!aiCard.c; width: parent.width; items: aiCard.c ? [aiCard.c.meta] : [] }
    }

    // .reason:11.5px 二级色、上 4
    component Reason: Label {
        width: parent ? parent.width : 0
        wrap: true
        topPadding: 4
        size: 11.5
        color: Theme.labelSecondary
    }
    component Bullets: Column {
        id: bl
        property var items: []
        property color color: Theme.label
        width: parent ? parent.width : 0
        topPadding: 6
        Repeater {
            model: bl.items
            // 列表项:字从 16 起,项目符号挂在左边
            Item {
                required property var modelData
                width: bl.width
                height: li.implicitHeight
                Label { x: 5; text: "•"; size: 11.5; color: bl.color }
                Label { id: li; x: 16; width: bl.width - 16; wrap: true; text: modelData; size: 11.5; color: bl.color }
            }
        }
    }
    // 权重 / 小计:等宽数字、靠右,按正负着色(0 是三级色)
    component Weight: Label {
        property real minW: 46
        property string side: "flat"
        property bool bold: false
        width: Math.max(minW, implicitWidth)
        horizontalAlignment: Text.AlignRight
        size: 11.5
        weight: bold ? Theme.weightSemibold : Font.Normal
        family: Theme.fontMono
        tnum: true
        color: side === "up" ? Theme.upText : side === "down" ? Theme.downText : Theme.labelTertiary
    }
    // 一条依据(.pa-ev):上下 4、11.5px、基线对齐;名(二级色,最窄 92)、说明(占满)、权重(最窄 46,靠右);下面一条 0.5 的发丝线(组里最后一条没有)
    component EvRow: Item {
        id: ev
        property var item: ({})
        property bool last: false
        // 量的:一行 25.9(上下 4 + 17.4 + 0.5 的下边线),最后一条没有线 25.4;多出来的 0.5 同组头,是等宽的权重按基线对齐撑出来的
        implicitHeight: 4 + Math.max(evLabel.implicitHeight, detail.implicitHeight) + 0.5 + 4 + (last ? 0 : 0.5)
        Label { id: evLabel; y: 4; width: Math.max(92, implicitWidth); text: ev.item.label || ""; size: 11.5; color: Theme.labelSecondary }
        Label { id: detail; y: 4; x: evLabel.width + 8; width: ev.width - x - 8 - w.width; wrap: true; text: ev.item.detail || ""; size: 11.5 }
        Weight { id: w; anchors.baseline: evLabel.baseline; anchors.right: parent.right; text: ev.item.weight || ""; side: ev.item.side || "flat" }
        Rectangle { visible: !ev.last; anchors.bottom: parent.bottom; width: parent.width; height: 0.5; color: Theme.separator }
    }
}
