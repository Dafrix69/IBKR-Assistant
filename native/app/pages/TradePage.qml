import QtQuick
import Dafri.Kit

// 交易指令(pages/Trade.tsx):输入框(⌘↩ 解析)与解析结果并排(可拖分栏);「解析并校验」/「发送到 IBKR / 富途」两个按钮。
// 这是整个软件唯一的主动作,进页就把光标放进输入框。右栏可以切到「蝴蝶测算」或「日内剧本」(两块还没搬过来)。
// 判定、文案、结果卡片都在 C++(shell/trade_rules,经 shell/trade_controller 的 model);这里只摆。
ScrollPage {
    id: page
    property var controller: null
    property var composer: null
    property var navigate: function (key) {}
    /// 右栏的蝴蝶测算与日内剧本(shell/fly_controller、shell/fly_store)
    property var fly: null
    property var flyStore: null
    readonly property var m: controller ? controller.model : ({})
    readonly property bool stacked: width < 980 + 56
    Component.onCompleted: editor.forceActiveFocus()

    PageHead {
        width: parent.width
        title: m.title || "交易指令"
        Label { text: page.m.limits || "—"; size: 11; color: Theme.labelSecondary }
    }

    // 就绪检查表:三个前置条件,缺哪个说哪个,并给出去哪修;必要条件都满足就收起来(.readiness 下 16)
    StatusCard {
        visible: !!page.m.readiness
        width: parent.width
        tone: "warn"
        title: page.m.readiness ? page.m.readiness.title : ""
        Label { width: parent.width; wrap: true; text: page.m.readiness ? page.m.readiness.sub : ""; size: 11.5; color: Theme.labelSecondary; bottomPadding: 6 }
        // 步骤列表(ui/kit 的 StepList + .steplist):18px 圆标、右边 16、竖线;标题 13px 510 行高 18;说明 11.5 行高 1.47 下 12(最后一条 0)
        Column {
            width: parent.width
            Repeater {
                model: page.controller ? page.controller.steps : []
                Item {
                    id: step
                    required property var modelData
                    required property int index
                    readonly property bool last: index === page.controller.steps.length - 1
                    width: parent.width
                    height: Math.max(48, body.implicitHeight)
                    Rectangle { visible: !step.last; x: 8.5; y: 24; width: 1; height: parent.height - 24 - 6; color: Theme.separator }
                    Rectangle {
                        x: 0; y: 1.5
                        width: 18; height: 18; radius: 9
                        color: step.modelData.done ? Theme.green : Theme.orange
                        Text { anchors.centerIn: parent; text: step.modelData.done ? "✓" : "!"; color: "#ffffff"; font.pixelSize: 12; font.weight: Theme.weightHeavy; font.family: Theme.fontFamily }
                    }
                    Column {
                        id: body
                        x: 34
                        width: parent.width - 34
                        Label { text: step.modelData.title; size: 13; weight: Theme.weightMedium; css: 18 }
                        Item {
                            width: parent.width
                            height: Math.max(detail.implicitHeight, go.visible ? go.height : 0) + (step.last ? 0 : 12)
                            Label { id: detail; width: parent.width - (go.visible ? go.width + 10 : 0); wrap: true; text: step.modelData.text; size: 11.5; color: step.modelData.done ? Theme.labelSecondary : Theme.label; anchors.verticalCenter: go.visible ? go.verticalCenter : undefined }
                            Button { id: go; visible: !step.modelData.done; small: true; text: step.modelData.action; anchors.right: parent.right; onClicked: page.navigate(step.modelData.tab) }
                        }
                    }
                }
            }
        }
    }
    Item { width: 1; height: page.m.readiness ? 16 : 0 }

    // 两栏(.trade-split):上 2;左栏右边空 16、右栏左边空 16、中间 1px 分隔线(可拖,36%–64%)
    Item {
        id: split
        width: parent.width
        property real ratio: 0.5
        /// 拖过分隔条之后两栏照拖的比例(AntD Splitter 拖完给两栏都写死宽);没拖过时按 CSS 的弹性收缩算(见 flexBar)
        property bool dragged: false
        property real dragStart: 0.5
        /// 右栏最窄能窄到多少(右栏换了内容、内容变了都重量)
        property real rightMin: 0
        function remeasure() { rightMin = Theme.minContentWidth(resultsCol) }
        // 没拖过时:两栏的基准都是 50%;右栏的内容最窄也放不下(日内剧本那张不折行的表),右栏撑宽、左栏让出来
        // (AntD Splitter 的两个面板是 flex 子项,min-width: auto = 内容的 min-content)——同 React 版
        // 左栏 min="36%"(原版 Splitter):右栏的最窄宽度再大,左栏也不让到 36% 以下
        function flexBar() { return Math.round(Math.max(width * 0.36, Math.min(width * ratio, width - (rightMin + 16)))) }
        readonly property real barX: page.stacked ? 0 : dragged ? Math.round(width * ratio) : flexBar()
        // 量的 React 版:输入框和右栏的页头都从分栏的顶上起(离页头 14),没有另外的边距
        height: page.stacked ? editorCol.implicitHeight + 20 + resultsCol.implicitHeight : Math.max(editorCol.implicitHeight, resultsCol.implicitHeight)
        Column {
            id: editorCol
            x: 0; y: 0
            width: page.stacked ? parent.width : split.barX - 16
            TextArea {
                id: editor
                width: parent.width
                text: page.composer ? page.composer.text : ""
                placeholder: page.m.placeholder || ""
                onEdited: function (t) { if (page.composer) page.composer.text = t }
                onSubmit: function (shift) { if (page.controller) page.controller.hotkey(shift) }
            }
            // .row:上 10、间距 8
            Row {
                topPadding: 10
                spacing: 8
                Button {
                    kind: "primary"; text: page.m.parseLabel || "解析并校验"
                    busy: page.m.busy === "parse"; enabled: page.m.busy !== "execute"
                    onClicked: page.controller.submit(false)
                }
                Button {
                    text: page.m.send ? page.m.send.label : ""
                    textColor: enabled && page.m.send && page.m.send.warn ? Theme.orangeText : (enabled ? Theme.label : Theme.labelTertiary)
                    busy: page.m.busy === "execute"
                    enabled: !!(page.m.send && page.m.send.canExecute) && page.m.busy !== "parse"
                    Tip { text: page.m.send ? page.m.send.tip : "" }
                    onClicked: page.controller.submit(true)
                }
                // 行框撑到按钮一样高(32)就是竖直居中
                Label { text: page.m.hotkeys || ""; size: 11; color: Theme.labelSecondary; css: 32 }
            }
            // 发单账户(.account-picker:上 8、间距 8、12px;只有一个账户时不出现)
            Flow {
                visible: !!page.m.picker
                width: parent.width
                topPadding: 8
                spacing: 8
                // Flow 里不能用 anchors:字的行框撑到胶囊一样高(24),就是竖直居中
                Label { text: "发单账户"; size: 11; color: Theme.labelSecondary; css: 26 }
                Flow {
                    spacing: 6
                    Repeater {
                        model: page.controller ? page.controller.accounts : []
                        // .account-chip:3 × 9 + AntD Tag 自带的 1px 边(透明)= 26 高、6 圆角、12px 行高 1.5;勾上蓝 16% 底正文色,实盘勾上橙 16% 底橙字
                        Rectangle {
                            required property var modelData
                            implicitWidth: chipL.implicitWidth + 20; implicitHeight: 26; radius: 6
                            color: modelData.on ? Theme.tint(modelData.live ? Theme.orange : Theme.blue, 0.16) : Theme.bgFill
                            Label { id: chipL; anchors.centerIn: parent; text: modelData.text; size: 12; css: 1.5; color: modelData.on ? (modelData.live ? Theme.orangeText : Theme.label) : Theme.labelSecondary }
                            Tip { text: modelData.tip }
                            TapHandler { onTapped: page.controller.togglePick(modelData.alias, !modelData.on) }
                        }
                    }
                }
                Label { visible: !!(page.m.picker && page.m.picker.hint); text: page.m.picker ? page.m.picker.hint : ""; size: 11; color: Theme.labelSecondary; css: 26 }
            }
            // 实盘闸门 / 保护规则的提醒(.live-gate:上 6、间距 8、11px 二级色)
            Flow {
                visible: !!page.m.liveGate
                width: parent.width
                topPadding: 6
                spacing: 8
                Label { width: Math.min(implicitWidth, parent.width - 70); wrap: true; text: page.m.liveGate || ""; size: 11; color: Theme.labelSecondary; css: lineCount > 1 ? 1.47 : 24 }
                Button { small: true; text: "去设置"; onClicked: page.navigate("settings") }
            }
            Label { visible: !!page.m.guard; width: parent.width; wrap: true; topPadding: 6; text: page.m.guard || ""; size: 11; color: Theme.labelSecondary }
            Label { visible: !!page.m.accountPauses; width: parent.width; wrap: true; topPadding: 6; text: page.m.accountPauses || ""; size: 11; color: Theme.labelSecondary }
            // 速记片段(.shorthand-chips 上 10、间距 6;.chip-tag:3 × 10、控件圆角、12px 行高 1.5、填充底正文色)
            Flow {
                width: parent.width
                topPadding: 10
                spacing: 6
                Repeater {
                    model: page.controller ? page.controller.chips : []
                    // 同样带 1px 透明边:26 高(量的 React 版:两行间距 8 = 6 的 gap + 2)
                    Rectangle {
                        required property var modelData
                        implicitWidth: tagL.implicitWidth + 22; implicitHeight: 26; radius: Theme.radiusControl
                        color: chipHover.hovered ? Theme.bgFillStrong : Theme.bgFill
                        Label { id: tagL; anchors.centerIn: parent; text: modelData[0]; size: 12; css: 1.5 }
                        HoverHandler { id: chipHover; cursorShape: Qt.PointingHandCursor }
                        TapHandler {
                            onTapped: {
                                var r = page.controller.insertSnippet(editor.selectionStart, editor.selectionEnd, modelData[1])
                                editor.focusAndPlace(r.caret)
                            }
                        }
                    }
                }
            }
            Primer {
                id_: "shorthand"
                width: parent.width
                summary: page.m.primer ? page.m.primer.summary : ""
                Column {
                    width: parent.width
                    topPadding: 4
                    Repeater {
                        model: page.controller ? page.controller.primerItems : []
                        Row {
                            required property var modelData
                            width: parent.width
                            leftPadding: 16
                            Label { text: "•  "; size: 11; color: Theme.labelSecondary; css: 1.6 }
                            Label { text: modelData; size: 11; color: Theme.labelSecondary; css: 1.6; width: parent.width - 30; wrap: true }
                        }
                    }
                }
            }
        }
        // 分隔条:1px 线,6px 的抓手
        Item {
            visible: !page.stacked
            x: split.barX - 3; y: 0
            width: 6; height: parent.height
            Rectangle { x: 2.5; width: 1; height: parent.height; color: dragHover.hovered || drag.active ? Theme.blue : Theme.separator }
            HoverHandler { id: dragHover; cursorShape: Qt.SplitHCursor }
            DragHandler {
                id: drag
                target: null
                xAxis.enabled: true; yAxis.enabled: false
                onActiveChanged: if (active) { split.dragStart = split.barX / split.width; split.dragged = true }
                onActiveTranslationChanged: {
                    // 从按下那一刻的位置算起(barX 跟着变,拿它累加会越拖越快)
                    var next = split.dragStart + activeTranslation.x / split.width
                    split.ratio = Math.max(0.36, Math.min(0.64, next))
                }
            }
        }
        Timer { id: remeasureSoon; interval: 0; onTriggered: split.remeasure() }
        Connections { target: page.controller; ignoreUnknownSignals: true; function onModelChanged() { remeasureSoon.restart() } }
        Connections { target: page.fly; ignoreUnknownSignals: true; function onPlannerChanged() { remeasureSoon.restart() } function onPlaybookChanged() { remeasureSoon.restart() } }
        Column {
            id: resultsCol
            onImplicitHeightChanged: remeasureSoon.restart()
            x: page.stacked ? 0 : split.barX + 16
            y: page.stacked ? editorCol.implicitHeight + 20 : 0
            width: page.stacked ? parent.width : parent.width - x
            // .pane-head:两端对齐,下 8
            Item {
                width: parent.width
                height: Math.max(seg.height, clearBtn.height) + 8
                Segmented {
                    id: seg
                    small: true
                    options: page.m.panes || []
                    value: page.m.pane || "result"
                    onActivated: function (v) { if (page.composer) page.composer.pane = v }
                }
                Button { id: clearBtn; visible: page.m.pane === "result"; kind: "text"; small: true; text: "清空"; anchors.right: parent.right; onClicked: if (page.composer) page.composer.clearResult() }
            }
            Column {
                visible: page.m.pane === "result"
                width: parent.width
                spacing: 8
                // 忙碌(.working:小转圈 + 12px 二级色)
                Row {
                    visible: page.m.result && page.m.result.kind === "working"
                    spacing: 7
                    Item {
                        width: 14; height: 14
                        anchors.verticalCenter: parent.verticalCenter
                        Rectangle { anchors.fill: parent; radius: 7; color: "transparent"; border.width: 1.5; border.color: Theme.tint(Theme.blue, 0.25) }
                        Rectangle { width: 3; height: 3; radius: 1.5; x: 5.5; y: 0; color: Theme.blue }
                        RotationAnimation on rotation { from: 0; to: 360; duration: 800; loops: Animation.Infinite; running: parent.visible }
                    }
                    Label { text: page.m.result ? (page.m.result.text || "") : ""; size: 12; color: Theme.labelSecondary; anchors.verticalCenter: parent.verticalCenter }
                }
                StatusCard {
                    visible: page.m.result && page.m.result.kind === "failure"
                    width: parent.width
                    tone: "bad"
                    title: "调用失败"
                    Label { width: parent.width; wrap: true; text: page.m.result ? (page.m.result.text || "") : "" }
                }
                // 空态的上边距 10 和上面 pane-head 的下边距 8 合并(CSS):只多出 2
                EmptyState { visible: page.m.result && page.m.result.kind === "empty"; width: parent.width; topMargin: 2; text: page.m.result ? (page.m.result.text || "") : "" }
                Repeater {
                    // 按键原地更新(controller.cards):同一张卡片只换数据,delegate 不重建
                    model: page.controller ? page.controller.cards : null
                    Loader {
                        id: cardLoader
                        required property var modelData
                        width: resultsCol.width
                        sourceComponent: modelData.kind === "empty" ? emptyCard : resultCard
                        onLoaded: item.c = Qt.binding(function () { return cardLoader.modelData })
                    }
                }
            }
            // 只在摆着的那一面挂上(挂上 / 卸下告诉 store 看不看得见:自动刷新、现价、剧本都只在看得见时轮询)
            Loader {
                active: page.m.pane === "fly" && !!page.fly
                visible: active
                width: parent.width
                sourceComponent: FlyPlanner { controller: page.fly; store: page.flyStore }
            }
            Loader {
                active: page.m.pane === "playbook" && !!page.fly
                visible: active
                width: parent.width
                sourceComponent: PlaybookPanel { controller: page.fly }
            }
        }
    }

    Component {
        id: emptyCard
        EmptyState { property var c: ({}); text: c.text || "" }
    }
    Component {
        id: resultCard
        StatusCard {
            id: card
            property var c: ({})
            tone: c.tone || "info"
            title: c.title || ""
            // 老引擎的摘要里没有 ticket:那就只剩标题那一句话
            Loader { width: parent.width; active: !!card.c.ticket; visible: active; sourceComponent: OrderTicket { t: card.c.ticket || ({}) } }
            Label { visible: !!card.c.body; width: parent.width; wrap: true; text: card.c.body || "" }
            Label { visible: !!card.c.reason; width: parent.width; wrap: true; topPadding: 4; text: card.c.reason || ""; size: 11.5; color: Theme.labelSecondary }
            Column {
                visible: !!(card.c.items && card.c.items.length)
                width: parent.width
                Repeater {
                    model: card.c.items || []
                    Row {
                        required property var modelData
                        width: parent.width
                        leftPadding: 16
                        Label { text: "•  " }
                        Label { text: modelData; width: parent.width - 30; wrap: true }
                    }
                }
            }
            // .ticket-card .card-meta:0.5px 分隔线、上 8(量的 React 版:没有另外的外边距);没有票据时同追踪卡片,离卡片身 2
            Rectangle { visible: !!card.c.ticket && !!(card.c.meta && card.c.meta.length); width: parent.width; height: 0.5; color: Theme.separator }
            Meta { items: card.c.meta || []; width: parent.width; topPadding: card.c.ticket ? 7.5 : 2 }
            // 历史里相似的交易:只读展示,不拦单
            Loader { width: parent.width; active: !!card.c.similar; visible: active; sourceComponent: SimilarTrades { s: card.c.similar || ({}) } }
        }
    }
}
