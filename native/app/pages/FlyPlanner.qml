import QtQuick
import Dafri.Kit

// 蝴蝶测算(lib/FlyPlanner.tsx + FlySpot.tsx + EventWarning.tsx + FlyPlanResult.tsx):开仓之前问一句「按现在的现价开这只蝶,
// 标的在某个时刻走到某个点位,它值多少、赚多少」。只算不下单;「写进指令」只是把这只蝶写成一句话放进左边的输入框。
// 模型在 C++(shell/fly_rules,经 shell/fly_controller);表单与结果在 shell/fly_store(切页回来还在)。
Column {
    id: root
    signal openEntry()
    property var controller: null
    property var store: null
    readonly property var m: controller ? controller.planner : ({})
    readonly property var form: m.form || ({})
    width: parent ? parent.width : 400
    Component.onCompleted: if (controller) controller.setPlannerVisible(true)
    Component.onDestruction: if (controller) controller.setPlannerVisible(false)

    // ---- 现价那一行(.fly-spot:折行、间距 6 × 14、下 8、左右 2)
    Item {
        width: parent.width
        height: spotFlow.implicitHeight + 8
        Flow {
            id: spotFlow
            x: 2
            width: parent.width - 4 - alertRow.implicitWidth - 14
            spacing: 14
            Row {
                spacing: 6
                Label { text: root.m.spot ? root.m.spot.symbol : ""; size: 11; weight: Theme.weightSemibold; color: Theme.labelSecondary; css: 26 }
                Row {
                    spacing: 5
                    Label { text: root.m.spot ? root.m.spot.price : "—"; size: 17; weight: 700; family: Theme.fontDisplay; tnum: true; css: 26; letterSpacing: -0.17
                            color: root.m.spot && root.m.spot.live ? Theme.label : Theme.labelSecondary }
                    Rectangle { visible: !!(root.m.spot && root.m.spot.live); width: 5; height: 5; radius: 2.5; color: Theme.green; anchors.verticalCenter: parent.verticalCenter }
                }
                Label { visible: !!(root.m.spot && root.m.spot.note); text: root.m.spot && root.m.spot.note ? root.m.spot.note : ""; size: 11; css: 26
                        color: root.m.spot && root.m.spot.noteWarn ? Theme.orangeText : Theme.labelSecondary }
                Label { visible: !!(root.m.spot && root.m.spot.why); text: root.m.spot ? (root.m.spot.why || "") : ""; size: 11; color: Theme.labelSecondary; css: 26 }
            }
            Row {
                visible: !!(root.m.spot && root.m.spot.levels)
                spacing: 6
                Repeater {
                    model: root.m.spot && root.m.spot.levels ? root.m.spot.levels : []
                    Chip {
                        required property var modelData
                        text: modelData.text; extra: modelData.gap; tip: "点一下填进中心行权价"
                        onClicked: root.controller.pickLevel(modelData.level)
                    }
                }
            }
        }
        Row {
            id: alertRow
            anchors.right: parent.right; anchors.rightMargin: 2
            spacing: 6
            Switch { small: true; checked: !!(root.m.spot && root.m.spot.alertOn); anchors.verticalCenter: parent.verticalCenter
                     onToggled: function (on) { root.controller.setSpotAlert(on) } }
            Label { text: root.m.spot ? root.m.spot.alertLabel : ""; size: 11; color: Theme.labelSecondary; css: 26 }
            Label { visible: !!(root.m.spot && root.m.spot.lastHit); text: root.m.spot && root.m.spot.lastHit ? root.m.spot.lastHit : ""; size: 11; color: Theme.labelSecondary; css: 26 }
        }
    }
    Alert {
        visible: !!root.m.warning
        width: parent.width
        tone: "warn"
        title: root.m.warning ? root.m.warning.title : ""
        text: root.m.warning ? root.m.warning.text : ""
    }
    // .event-warning 写的是下 8,但 kit 的 Notice 那条下 14 排在后面、优先级一样,量出来是 14
    Item { width: 1; height: root.m.warning ? 14 : 0 }

    // ---- 表单(.fly-form:内边距 10 12 12、卡片圆角、填充底、下 12)
    Rectangle {
        width: parent.width
        height: formCol.implicitHeight + 22
        radius: Theme.radiusCard
        color: Theme.bgFill
        Column {
            id: formCol
            x: 12; y: 10
            width: parent.width - 24
            FlyRow {
                Field { label: "中心行权价"; FlyInput { key: "center"; placeholder: "7750" } }
                Field { label: "翼宽(点)"; FlyInput { key: "width"; placeholder: "25"; width: 72 } }
                Field {
                    label: "方向"; tip: "自动 = 中心在现价上方看涨、下方看跌"
                    Segmented { small: true; fontSize: 11; itemColor: Theme.labelSecondary; value: root.form.right || ""; options: [{ label: "自动", value: "" }, { label: "看涨", value: "C" }, { label: "看跌", value: "P" }]
                                onActivated: function (v) { root.controller.patch({ right: v }) } }
                }
                Field { label: "张数"; FlyInput { key: "quantity"; placeholder: "1"; width: 60 } }
                Field { label: "成本(权利金)"; tip: "你打算付的净权利金;留空 = 此刻的盘口中间价"; FlyInput { key: "cost"; placeholder: "留空 = 中间价"; width: 112 } }
            }
            FlyRow {
                Field { label: "预计走到(点位)"; FlyInput { key: "targetSpot"; placeholder: "7745" } }
                Field { label: "预计几点到(美东)"; tip: "美东时间,24 小时制"; FlyInput { key: "targetTime"; placeholder: "14:30"; width: 84 } }
                // 时刻快捷钮(antd Space size=4 wrap):放得下就和字段在同一行、底对齐
                Row {
                    spacing: 4
                    bottomPadding: 1
                    Repeater {
                        model: root.m.chips || []
                        // 点下那一刻按此刻的美东时间现算(同原版 pick(Date.now()))
                        Chip { required property var modelData; required property int index; text: modelData[0]; onClicked: root.controller.pickChip(index) }
                    }
                }
            }
            Primer {
                id_: "fly-more"
                intro: false
                width: parent.width
                // 量的 React 版:最后一行字段的底到这颗按钮 20(列间距 14 + 这里 6)
                topPadding: 6
                bottomPadding: 10
                summary: "更多:日期与到期日、手动现价与 IV、到时的 IV 怎么算"
                Column {
                    width: parent.width
                    FlyRow {
                        Field { label: "哪一天到"; tip: "留空 = 今天;今天已收盘就是下一个交易日"; FlyInput { key: "targetDate"; placeholder: "YYYY-MM-DD"; width: 120; runOnEnter: false } }
                        Field { label: "到期日"; tip: "留空 = 目标那一天(当日到期)"; FlyInput { key: "expiry"; placeholder: "YYYY-MM-DD"; width: 120; runOnEnter: false } }
                        Field { label: "现价"; tip: "留空 = 从券商取。没连券商、或想按另一个现价推演时填"; FlyInput { key: "spot"; placeholder: "留空 = 实时"; width: 104 } }
                        Field { label: "IV(%)"; tip: "留空 = 用 IBKR 的模型 IV(每条腿各用各的)。填了就三条腿共用这一个"; FlyInput { key: "iv"; placeholder: "留空 = 实时"; width: 104 } }
                    }
                    FlyRow {
                        Field {
                            label: "到时的 IV"; tip: "自动 = 按历史数据校准的模型:跌则 IV 升、涨则 IV 降,再加上日内时段的影响"
                            Segmented { small: true; fontSize: 11; itemColor: Theme.labelSecondary; value: root.form.ivMode || "auto"; options: [{ label: "自动", value: "auto" }, { label: "不变", value: "flat" }, { label: "自己填", value: "shift" }]
                                        onActivated: function (v) { root.controller.patch({ ivMode: v }) } }
                        }
                        Field { visible: !!root.m.shift; label: "IV 变化(%)"; FlyInput { key: "ivShiftPct"; placeholder: "+30"; width: 84 } }
                    }
                    Bullets {
                        width: parent.width
                        items: ["IV 会变:标的跌,IV 升;标的涨,IV 降。「自动」用的是拿两年多历史数据校准的模型,它解释得了 IV 变化的三成左右,所以结果里除了一个数,还有「半数情况下」的区间和各档 IV 下的数。",
                                "现价与 IV 都手动填了,就不取任何行情:没连券商、休市时也能算。"]
                    }
                    // 记录器(.fly-recorder:上 8、0.5px 分隔线、再 8;竖排间距 4;12px)
                    Column {
                        visible: !!root.m.recorder
                        width: parent.width
                        topPadding: 8
                        spacing: 4
                        Rectangle { width: parent.width; height: 0.5; color: Theme.separator }
                        Item { width: 1; height: 4 }
                        Row {
                            spacing: 6
                            Switch { small: true; checked: !!(root.m.recorder && root.m.recorder.enabled); anchors.verticalCenter: parent.verticalCenter
                                     onToggled: function (on) { root.controller.toggleRecorder(on) } }
                            Label { text: root.m.recorder ? root.m.recorder.label : ""; size: 12 }
                        }
                        Label { width: parent.width; wrap: true; text: root.m.recorder ? root.m.recorder.status : ""; size: 11; color: Theme.labelSecondary }
                        Hint { width: parent.width; topPadding: 0; text: root.m.recorder ? root.m.recorder.hint : ""; textFormat: Text.PlainText }
                    }
                }
            }
            // .fly-form .row:间距 8 × 10
            Flow {
                width: parent.width
                spacing: 10
                Button { small: true; kind: "primary"; text: "测算"; busy: !!root.m.running; enabled: !!root.m.canRun; onClicked: root.store.run(false) }
                Button {
                    small: true; text: "写进指令"; enabled: !!root.m.canWrite
                    onClicked: root.controller.writeInstruction()
                    Tip { text: root.m.writeTip || "" }
                }
                // 提示要铺在这一行上:Row 里放 Tip 会被当成又一格,所以外面包一层
                Item {
                    implicitWidth: autoRow.implicitWidth; implicitHeight: 24
                    Row {
                        id: autoRow
                        spacing: 6
                        height: 24
                        Switch { small: true; checked: !!root.m.auto; enabled: !!root.m.canAuto; anchors.verticalCenter: parent.verticalCenter
                                 onToggled: function (on) { root.store.setAuto(on) } }
                        Label { text: "跟着行情刷新"; size: 11; color: Theme.labelSecondary; css: 24 }
                    }
                    Tip { text: "每 10 秒按最新的现价与 IV 重算一次;离开这一页就停" }
                }
                Button { small: true; kind: "text"; text: "清空"; onClicked: root.store.reset() }
                Label { visible: !!root.m.at; text: root.m.at || ""; size: 11; color: Theme.labelSecondary; css: 24 }
            }
            Label { visible: !!root.m.problems; width: parent.width; wrap: true; topPadding: 8; text: root.m.problems || ""; size: 11.5; color: Theme.orangeText }
        }
    }
    Item { width: 1; height: 12 }

    // ---- 输出
    readonly property var out: m.output || ({})
    Row {
        visible: root.out.kind === "working"
        spacing: 7
        Item {
            width: 14; height: 14
            anchors.verticalCenter: parent.verticalCenter
            Rectangle { anchors.fill: parent; radius: 7; color: "transparent"; border.width: 1.5; border.color: Theme.tint(Theme.blue, 0.25) }
            Rectangle { width: 3; height: 3; radius: 1.5; x: 5.5; y: 0; color: Theme.blue }
            RotationAnimation on rotation { from: 0; to: 360; duration: 800; loops: Animation.Infinite; running: parent.visible }
        }
        Label { text: root.out.text || ""; size: 12; color: Theme.labelSecondary; anchors.verticalCenter: parent.verticalCenter }
    }
    StatusCard {
        visible: root.out.kind === "failure"
        width: parent.width
        tone: "bad"; title: root.out.title || ""
        Label { width: parent.width; wrap: true; text: root.out.text || "" }
    }
    EmptyState { visible: root.out.kind === "empty"; width: parent.width; topMargin: 0; text: root.out.text || "" }
    Loader {
        active: root.out.kind === "result"
        visible: active
        width: parent.width
        sourceComponent: Column {
            width: root.width
            StatusCard {
                visible: !!root.out.refreshFailed
                width: parent.width
                tone: "warn"; title: "刚才那次刷新没成功,下面是上一次的结果"
                Label { width: parent.width; wrap: true; text: root.out.refreshFailed || "" }
            }
            Item { width: 1; height: root.out.refreshFailed ? 8 : 0 }
            // .fly-stale:下 8、6 × 10、控件圆角、12px 橙字、橙 12% 底
            Rectangle {
                visible: !!root.out.stale
                width: parent.width; height: visible ? staleL.implicitHeight + 12 : 0
                radius: Theme.radiusControl; color: Theme.tint(Theme.orange, 0.12)
                Label { id: staleL; x: 10; y: 6; width: parent.width - 20; wrap: true; text: "表单改过了,下面是改之前的结果。点「测算」重算。"; size: 12; color: Theme.orangeText }
            }
            Item { width: 1; height: root.out.stale ? 8 : 0 }
            FlyResult { width: parent.width; r: root.out.result || ({}); opacity: root.out.stale ? 0.55 : 1 }
        }
    }

    // ---- 小件
    // 一行字段(.fly-row:折行、底对齐、行距 10 列距 14、下 10)
    component FlyRow: WrapRow {
        width: parent ? parent.width : 300
        columnSpacing: 14
        rowSpacing: 10
        alignBottom: true
        bottomPadding: 10
    }
    // 字段(label:竖排、间距 4、11px 二级色)
    component Field: Column {
        property string label: ""
        property string tip: ""
        default property alias control: holder.data
        width: implicitWidth
        height: implicitHeight
        spacing: 4
        Label { text: parent.label; size: 11; color: Theme.labelSecondary; Tip { text: parent.parent.tip } }
        Item { id: holder; width: childrenRect.width; height: childrenRect.height }
    }
    // 表单里的一格(AntD Input small:24 高):受控——字由 store 给,打字只 patch;回车 = 测算
    component FlyInput: Input {
        property string key: ""
        readonly property string v: root.form[key] !== undefined ? root.form[key] : ""
        small: true
        width: 96
        mono: false
        onVChanged: if (!focused && text !== v) text = v
        Component.onCompleted: text = v
        onEdited: function (t) { var p = {}; p[key] = t; root.controller.patch(p) }
        /// 原版只有用 text() 拼的那几格接了回车(「哪一天到」「到期日」没接)
        property bool runOnEnter: true
        onAccepted: if (runOnEnter) root.store.run(false)
    }
    // .chip-tag:3 × 10、控件圆角、12px 行高 1.5、填充底;extra = 跟在后面的二级色小字(离现价多远)
    component Chip: Rectangle {
        id: chip
        property string text: ""
        property string extra: ""
        property string tip: ""
        signal clicked()
        implicitWidth: chipRow.implicitWidth + 22; implicitHeight: 26
        radius: Theme.radiusControl
        color: chipHover.hovered ? Theme.bgFillStrong : Theme.bgFill
        Row {
            id: chipRow
            anchors.centerIn: parent
            spacing: 6
            // 只有现价旁边的关口胶囊(.fly-spot-levels .chip-tag)是等宽数字;时刻快捷钮是普通数字
            Label { text: chip.text; size: 12; css: 1.5; tnum: chip.extra !== "" }
            Label { visible: chip.extra !== ""; text: chip.extra; size: 12; css: 1.5; tnum: true; color: Theme.labelSecondary }
        }
        HoverHandler { id: chipHover; cursorShape: Qt.PointingHandCursor }
        TapHandler { onPressedChanged: if (pressed) chip.forceActiveFocus(); onTapped: chip.clicked() }
        Tip { text: chip.tip }
    }
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
}
