import QtQuick
import QtQuick.Layouts
import Dafri.Kit

// 新建追踪的表单(lib/TrackForm.tsx + TrackExitFields.tsx + TrackKeyLevels.tsx 的 TrackLevelPicker):
// 三列的格子(.track-form),开关、试算、说明各占满一行。值收在 values 里(键同 React 版的各个 state),
// 按下「开始追踪」交给 C++(shell/track_form:载荷、确认框、凭据都在那边,和原版逐步对拍过)。
Item {
    id: root
    property var position: ({})
    property var controller: null
    readonly property bool isCombo: position.sec_type === "BAG"
    readonly property bool derivative: isCombo || position.sec_type === "OPT" || position.sec_type === "FOP"
    readonly property bool isLong: Number(position.quantity) > 0
    readonly property string symbol: position.symbol || ""
    // 表单的值:初值照 React 版的 useState(组合的平仓方式默认限价、利润回撤门槛 10)
    property var v: ({ tp: null, sl: null, trail: null, profitDd: null, ddArm: 10, tiers: false, spotTarget: null, stopBelow: null, stopAbove: null,
                       fraction: null, chaseMax: null, autoPicked: null, orderType: isCombo ? "LMT" : "MKT", host: false, brokerSpotStop: false, spotStopLimit: null,
                       exits: { exitAt: "", stopConfirm: null, stopBasis: "mid", chaseGrace: null, chaseStep: null, chaseMax: null, chaseLead: null, chaseInterval: null, rapidWindow: null, rapidPct: null, peakConfirm: false, tiers: [] } })
    function set(part) { var n = Object.assign({}, v); for (var k in part) n[k] = part[k]; v = n }
    function setExit(part) { var e = Object.assign({}, v.exits); for (var k in part) e[k] = part[k]; set({ exits: e }) }
    readonly property bool hasSpotTarget: v.spotTarget !== null && v.spotTarget > 0
    readonly property bool autoOn: v.autoPicked !== null ? v.autoPicked : !!(statusAuto)
    property bool statusAuto: false
    readonly property bool hasSpotStop: v.stopBelow > 0 || v.stopAbove > 0
    readonly property bool hostAllowed: !isCombo || hasSpotTarget || (v.brokerSpotStop && hasSpotStop)
    readonly property bool hostOn: v.host && hostAllowed
    readonly property bool saving: controller ? !!controller.saving[position.key] : false

    // 标的目标价的试算:防抖 400ms;试算结果和它算的那个目标价绑在一起,目标价一变旧的当场作废
    property var preview: null        // { target, row }
    property string previewErr: ""
    // 最后一次试算的序号:更早发出去的(目标价或追价上限已经改了)回来也不认,同 React 版 effect 的 alive
    property int previewSeq: -1
    readonly property var priced: hasSpotTarget && preview && preview.target === v.spotTarget ? preview.row : null
    Timer {
        id: debounce
        interval: 400
        onTriggered: if (root.controller && root.hasSpotTarget) root.previewSeq = root.controller.preview(root.position.key, root.v.spotTarget, root.v.chaseMax)
    }
    onVChanged: {
        var key = String(v.spotTarget) + "|" + String(v.chaseMax)
        if (key === lastPreviewKey) return
        lastPreviewKey = key
        preview = null; previewErr = ""
        previewSeq = -1
        if (hasSpotTarget) debounce.restart(); else debounce.stop()
    }
    property string lastPreviewKey: ""
    Connections {
        target: root.controller
        ignoreUnknownSignals: true
        function onPreviewed(seq, target, result, error) {
            if (seq !== root.previewSeq || target !== root.v.spotTarget) return
            var o = root.controller.previewOutcome(result, error)
            root.preview = o.priced ? { target: target, row: o.priced } : null
            root.previewErr = o.error || ""
        }
    }

    // .track-form:上 10(和上面那一行按钮的 margin-bottom 10 合并成一个,那 10 已经在按钮那一行里)、0.5px 分隔线、再 10
    implicitHeight: 0.5 + 10 + grid.implicitHeight
    width: parent ? parent.width : 600
    Rectangle { y: 0; width: parent.width; height: 0.5; color: Theme.separator }
    GridLayout {
        id: grid
        y: 10.5
        width: parent.width
        columns: 3
        columnSpacing: 10
        // .track-form 的行间距是 8;GridLayout 把每一行的高取整(一格字段 11px 名 16.17 + 3 + 输入框 32 = 51.17 → 52),
        // 量的每行多 0.83、八行攒到 +3.9:间距里扣回去
        rowSpacing: 8 - (52 - (Math.round(11 * 1.47 * 100) / 100 + 3 + 32))

        // 关键价位:点一个填进止损或目标
        Rectangle {
            id: picker
            // alertsRev 让这条绑定跟着价位警告变(点了「算关键价位」之后的转圈、算出来的价位)。
            // position 每秒都是一份新对象:先压成字符串,字没变就不换 pm,下面 chip 的 Repeater 才不会每秒重建
            readonly property string pmJson: root.controller ? (root.controller.alertsRev, JSON.stringify(root.controller.levelPicker(root.position))) : ""
            readonly property var pm: pmJson && pmJson !== "null" ? JSON.parse(pmJson) : null
            visible: !!pm
            Layout.columnSpan: 3
            Layout.fillWidth: true
            // .track-levels 的下边距 2(网格里不合并,加在行距 8 上)
            Layout.bottomMargin: 2
            implicitHeight: pickCol.implicitHeight + (pm && pm.pending ? 8 : 11)
            radius: 6
            color: Theme.bgFill
            Column {
                id: pickCol
                x: 8; y: picker.pm && picker.pm.pending ? 4 : 6
                width: parent.width - 16
                spacing: 5
                Row {
                    visible: !!(picker.pm && picker.pm.pending)
                    spacing: 6
                    Label { text: picker.pm && picker.pm.pending ? picker.pm.pending.text : ""; size: 11; color: Theme.labelSecondary; anchors.verticalCenter: parent.verticalCenter }
                    Button {
                        kind: "text"; small: true; inline: true
                        anchors.verticalCenter: parent.verticalCenter
                        text: picker.pm && picker.pm.pending ? picker.pm.pending.button : ""
                        busy: !!(picker.pm && picker.pm.pending && picker.pm.pending.computing)
                        onClicked: picker.pm.pending.create ? root.controller.createWatch(root.symbol) : root.controller.refreshWatch(picker.pm.pending.watchId)
                    }
                }
                Row {
                    visible: !!(picker.pm && picker.pm.title)
                    spacing: 8
                    Label { id: pickTitle; text: picker.pm ? (picker.pm.title || "") : ""; size: 12; weight: 600 }
                    Label { text: picker.pm ? (picker.pm.summary || "") : ""; size: 11; color: Theme.labelSecondary }
                }
                LevelStrip {
                    visible: !!(picker.pm && picker.pm.strip)
                    width: parent.width
                    layout: picker.pm && picker.pm.strip ? function (w) { return root.controller.levelStrip(picker.pm.strip.levels, picker.pm.strip.spot, w) } : null
                }
                Repeater {
                    model: picker.pm && picker.pm.title ? [{ label: picker.pm.stopLabel, chips: picker.pm.stopChips, stop: true }, { label: picker.pm.targetLabel, chips: picker.pm.targetChips, stop: false }] : []
                    Flow {
                        id: chipRow
                        required property var modelData
                        readonly property bool stop: modelData.stop
                        width: pickCol.width
                        spacing: 4
                        Text { text: modelData.label; color: Theme.labelSecondary; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; rightPadding: 2; height: 22; verticalAlignment: Text.AlignVCenter }
                        Repeater {
                            model: modelData.chips
                            Button {
                                required property var modelData
                                small: true
                                text: modelData.label
                                Tip { text: modelData.tip }
                                onClicked: {
                                    if (chipRow.stop) {
                                        if (root.derivative) root.set(modelData.side === "below" ? { stopBelow: modelData.price } : { stopAbove: modelData.price })
                                        else root.set({ sl: modelData.price })
                                    } else {
                                        root.set(root.derivative ? { spotTarget: modelData.price } : { tp: modelData.price })
                                    }
                                }
                            }
                        }
                    }
                }
                Hint { visible: !!(picker.pm && picker.pm.hint); text: picker.pm ? (picker.pm.hint || "") : ""; topPadding: 3 }
            }
        }

        // 标的目标价:人心里想的止盈位是标的走到哪儿;换算成价格由引擎每轮现算
        Field {
            Layout.columnSpan: 3
            label: "标的目标价(" + root.symbol + ")"
            sub: "填标的走到哪儿就走;止盈价按当前波动率每秒现算,不用自己估"
            InputNumber { width: parent.width; min: 0; step: 1; placeholder: root.symbol + " 走到多少"; value: root.v.spotTarget; onValueEdited: function (x) { root.set({ spotTarget: x }) } }
        }
        Rectangle {
            visible: root.hasSpotTarget
            Layout.columnSpan: 3
            Layout.fillWidth: true
            Layout.topMargin: -2
            implicitHeight: previewCol.implicitHeight + 14
            radius: 6
            color: Theme.bgFill
            Column {
                id: previewCol
                x: 9; y: 7
                width: parent.width - 18
                readonly property var lines: root.hasSpotTarget && root.controller ? root.controller.previewLines(root.position, root.v.spotTarget, root.priced, root.previewErr) : []
                Flow {
                    width: parent.width
                    spacing: 14
                    Repeater {
                        model: previewCol.lines.filter(function (l) { return l.cls === "meta" || l.cls === "strong" || l.cls === "up" || l.cls === "down" })
                        Label { css: 0;
                            required property var modelData
                            text: modelData.text
                            color: modelData.cls === "strong" ? Theme.label : modelData.cls === "up" ? Theme.upText : modelData.cls === "down" ? Theme.downText : Theme.labelSecondary
                            size: 11.5; weight: modelData.cls === "strong" ? Theme.weightMedium : Font.Normal; family: Theme.fontFamily
                        }
                    }
                }
                Repeater {
                    model: previewCol.lines.filter(function (l) { return l.cls === "hint" || l.cls === "warn" })
                    Hint { required property var modelData; text: modelData.text; warn: modelData.cls === "warn"; topPadding: 4; textFormat: Text.PlainText }
                }
            }
        }

        Field { label: "止盈价"; InputNumber { width: parent.width; min: 0; step: 0.01; enabled: !root.hasSpotTarget; placeholder: root.hasSpotTarget ? "由上面的标的目标价现算" : root.isLong ? "高于现价" : "低于现价"
                                                        value: root.hasSpotTarget ? null : root.v.tp; onValueEdited: function (x) { root.set({ tp: x }) } } }
        Field { label: "止损价"; InputNumber { width: parent.width; min: 0; step: 0.01; placeholder: root.isLong ? "低于现价" : "高于现价"; value: root.v.sl; onValueEdited: function (x) { root.set({ sl: x }) } } }
        Field {
            visible: root.derivative
            label: "标的跌到多少止损(" + root.symbol + ")"
            tip: "只看标的现价。可只填一侧,或两侧任一触发就平仓。下方可选择交给 IBKR 条件单;本机盯盘需要软件保持运行。"
            InputNumber { width: parent.width; min: 0; step: 1; placeholder: "低于 " + root.symbol + " 现价,跌到就平"; value: root.v.stopBelow; onValueEdited: function (x) { root.set({ stopBelow: x }) } }
        }
        Field {
            visible: root.derivative
            label: "标的涨到多少止损(" + root.symbol + ")"
            tip: "只看标的现价。可只填一侧,或两侧任一触发就平仓。下方可选择交给 IBKR 条件单;本机盯盘需要软件保持运行。"
            InputNumber { width: parent.width; min: 0; step: 1; placeholder: "高于 " + root.symbol + " 现价,涨到就平"; value: root.v.stopAbove; onValueEdited: function (x) { root.set({ stopAbove: x }) } }
        }
        Field { label: "跟踪止损 %(按价格)"; InputNumber { width: parent.width; min: 0; step: 0.01; placeholder: "价格从峰值回落 N%,全平"; value: root.v.trail; onValueEdited: function (x) { root.set({ trail: x }) } } }
        Field { label: "利润回撤 %(按利润)"; InputNumber { width: parent.width; min: 0; step: 0.01; enabled: !root.v.tiers; placeholder: "利润从峰值缩水 N%"; value: root.v.profitDd; onValueEdited: function (x) { root.set({ profitDd: x }) } } }
        Field { label: "利润回撤起算门槛 %"; InputNumber { width: parent.width; min: 0; step: 0.01; enabled: !root.v.tiers; placeholder: "浮盈到过成本的 N% 才开始算回撤;清空=一盈利就算"; value: root.v.ddArm; onValueEdited: function (x) { root.set({ ddArm: x }) } } }
        SwitchRow {
            label: "分档利润回撤(蝶式 40/30/20)"
            sub: root.isCombo
                 ? "按每组浮盈的金额:到过 $100 才开始追,之后让 40%;到过 $200 收紧到 30%;到过成本 3 倍让 20%。15:00 后一律减半,离峰值不到 0.20 不触发。勾上就不看上面那个固定百分比"
                 : "按浮盈相对成本的倍数换档:<1× 让 40%、1–3× 让 30%、≥3× 让 20%,15:00 后一律减半。现价到过成本的 1.3 倍才开始追,离峰值不到 0.20 不触发(和复盘回放同一套)。勾上就不看上面那个固定百分比"
            checked: root.v.tiers
            onToggled: function (on) { root.set(on ? { tiers: true, profitDd: null } : { tiers: false }) }
        }
        Field { label: "触发后平仓比例 %"; InputNumber { width: parent.width; min: 0; step: 0.01; placeholder: "默认 100 全平,50=卖一半"; value: root.v.fraction; onValueEdited: function (x) { root.set({ fraction: x }) } } }
        Field {
            visible: root.position.sec_type !== "STK"
            label: "追价最多让价 %"
            InputNumber { width: parent.width; min: 0; step: 0.01; placeholder: "默认 10;触发后先挂立刻成交价等两秒,之后每秒再让一跳,让到这里为止(至少两跳)"; value: root.v.chaseMax; onValueEdited: function (x) { root.set({ chaseMax: x }) } }
        }
        Item { Layout.fillWidth: true; visible: root.position.sec_type === "STK" }

        // 更多出场规则:默认折着
        ExitFields { Layout.columnSpan: 3; Layout.fillWidth: true }

        SwitchRow {
            label: "到价自动平仓"
            sub: "到价即自动发平仓单,不再询问;仍受自动执行、实盘开关、熔断三道闸门约束"
            checked: root.autoOn
            onToggled: function (on) { root.set({ autoPicked: on }) }
        }
        Field {
            label: "平仓方式"
            Select {
                width: parent.width
                enabled: !root.isCombo
                value: root.v.orderType
                options: [{ value: "MKT", label: "市价(一定成交)" }, { value: "LMT", label: "限价(控价,可能不成交)" }]
                onActivated: function (x) { root.set({ orderType: x }) }
            }
        }
        Item { Layout.columnSpan: 2; Layout.fillWidth: true }
        SwitchRow {
            visible: root.derivative && root.hasSpotStop
            label: "标的止损交给 IBKR 条件单"
            sub: "按常规时段官方标的行情触发,软件关闭后仍有效;SPX 不用夜盘 ES 推算价。两条线按「或」触发,不支持持续秒数确认。需要开启自动平仓与券商托管"
            checked: root.v.brokerSpotStop
            onToggled: function (on) { root.set({ brokerSpotStop: on, host: on || root.v.host }) }
        }
        Field {
            visible: root.derivative && root.hasSpotStop && root.v.brokerSpotStop && (root.isCombo || root.v.orderType === "LMT")
            Layout.columnSpan: 3
            label: root.isCombo ? "条件触发后的平仓限价(组合净价)" : "条件触发后的平仓限价"
            sub: root.isLong ? "填最低愿意收取的价格;条件满足后按此限价平仓,可能不成交" : "填最高愿意支付的价格;条件满足后按此限价平仓,可能不成交"
            InputNumber { width: parent.width; min: 0; step: 0.05; value: root.v.spotStopLimit; placeholder: "必填,与 SPX 触发点位是两个不同的价格"; onValueEdited: function (x) { root.set({ spotStopLimit: x }) } }
        }
        SwitchRow {
            label: "止盈/止损托管到券商(IBKR)"
            sub: root.v.brokerSpotStop && root.hasSpotStop
                 ? "IBKR 条件平仓单与止盈/止损单放在同一 OCA 组,一张成交其余撤销。请在追踪卡片核对已挂出的条件单或拒单原因"
                 : root.isCombo
                 ? (root.hasSpotTarget
                    ? "券商那边挂一张限价止盈单,价按上面的标的目标价每秒现算、原地改;GTC,关机也有效。止损、利润回撤由软件盯着——它们触发,或标的真到了目标价,软件把这张单改到立刻成交的价平掉(软件开着时)"
                    : "组合可填写「标的目标价」托管止盈,或填写标的止损并选择 IBKR 条件单")
                 : "GTC 单挂在券商服务器,关机也触发,不受本机轮询与行情延迟影响。利润回撤为动态停损,软件开着时按秒调整,关掉则停在最后价位"
            checked: root.hostOn
            enabled: root.hostAllowed
            onToggled: function (on) { root.set({ host: on, brokerSpotStop: on && root.v.brokerSpotStop }) }
        }
        Column {
            visible: root.isCombo
            Layout.columnSpan: 3
            Layout.fillWidth: true
            spacing: 4
            Label {
                width: parent.width; wrap: true; css: 1.5
                text: root.v.brokerSpotStop && root.hasSpotStop
                      ? "组合条件单按标的点位激活,按你填写的组合净价限价平仓。券商接受后关机仍有效;限价不保证成交,不会自动改成市价。其他本机出场规则仍需要软件运行。"
                      : "组合按整组净价触发,平仓发一张腿方向全部反转的 BAG 限价单。标的目标价可托管限价止盈;标的止损可选 IBKR 条件单。其他止损与利润回撤由软件盯盘。"
                color: Theme.labelSecondary; size: 11.5; family: Theme.fontFamily
            }
            Label {
                visible: !root.paper
                width: parent.width; wrap: true; css: 1.5
                textFormat: Text.StyledText
                text: "<font color='" + Theme.orangeText + "'><b>实盘账户</b></font> 和单腿一样:打开到价自动平仓、设置里允许了实盘下单,到价就发单。这张腿方向反转的 BAG 平仓单还没在实盘成交过,第一次到价时在 TWS 里看一眼成交。"
                color: Theme.labelSecondary; size: 11.5; family: Theme.fontFamily
            }
        }
        // 设了目标价却算不出价钱,就不给点:那一步下去要么被引擎拒、要么是盲签一张真单
        Button {
            Layout.columnSpan: 3
            kind: "primary"; small: true
            text: "开始追踪"
            busy: root.saving
            enabled: !(root.hasSpotTarget && !root.priced)
            Tip { visible: root.hasSpotTarget && !root.priced; text: "这个点位的价格还没算出来" }
            onClicked: if (root.controller) root.controller.startTrack(root.position, root.v)
        }
    }
    /// 认不出这个账户(配置里没有它)时按实盘说:提示宁可偏严
    property bool paper: false

    // 一格(.track-field):上面 11px 二级色的名字,下面输入框;带 sub 的占满一行、名字 12px 正文色
    component Field: Column {
        property string label: ""
        property string sub: ""
        property string tip: ""
        default property alias control: holder.data
        Layout.fillWidth: true
        Layout.alignment: Qt.AlignBottom
        Layout.preferredWidth: 1
        spacing: 3
        Item {
            width: parent.width
            height: fieldLabel.implicitHeight + (fieldSub.visible ? 1 + fieldSub.implicitHeight : 0)
            Label {
                id: fieldLabel
                width: parent.width; wrap: true
                text: parent.parent.label
                color: parent.parent.sub !== "" ? Theme.label : Theme.labelSecondary
                size: parent.parent.sub !== "" ? 12 : 11
            }
            Label {
                id: fieldSub
                visible: parent.parent.sub !== ""
                y: fieldLabel.implicitHeight + 1
                width: parent.width; wrap: true
                text: parent.parent.sub
                size: 11; color: Theme.labelSecondary
            }
            Tip { visible: parent.parent.tip !== ""; text: parent.parent.tip }
        }
        Item { id: holder; width: parent.width; height: childrenRect.height }
    }
    // 一行开关(.switch-row):左边名字 + 二级色的小字,右边开关
    component SwitchRow: Item {
        id: sw
        property string label: ""
        property string sub: ""
        property bool checked: false
        signal toggled(bool on)
        Layout.columnSpan: 3
        Layout.fillWidth: true
        Layout.topMargin: 2
        implicitHeight: 4 + Math.max(texts.implicitHeight, 26) + 4
        Column {
            id: texts
            y: 4
            width: sw.width - 56
            Label { width: parent.width; wrap: true; text: sw.label; size: 13 }
            Item { width: 1; height: 1 }
            Label { width: parent.width; wrap: true; text: sw.sub; size: 11; color: Theme.labelSecondary }
        }
        Switch {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            checked: sw.checked
            enabled: sw.enabled
            onToggled: function (on) { sw.toggled(on) }
        }
    }
    // 更多出场规则(TrackExitFields.tsx):到点平仓、确认秒数、止损口径、峰值确认、止损追价、分批止盈
    component ExitFields: Column {
        id: ex
        objectName: "exitFields"
        property bool open: false
        spacing: 6
        // <summary>:上下 4、12px 二级色(行高 1.47,一行 25.64)
        Item {
            width: ex.width; height: 4 + summaryL.implicitHeight + 4
            Row {
                y: 4
                spacing: 6
                Text { anchors.verticalCenter: summaryL.verticalCenter; text: "›"; rotation: ex.open ? 90 : 0; color: Theme.labelSecondary; font.pixelSize: 12 }
                Label { id: summaryL; text: "更多出场规则(急跌保护、到点平仓、分批止盈、止损与追价)"; size: 12; color: Theme.labelSecondary }
            }
            TapHandler { onTapped: ex.open = !ex.open }
        }
        GridLayout {
            visible: ex.open
            width: ex.width
            columns: Math.max(1, Math.floor((ex.width + 12) / (190 + 12)))
            columnSpacing: 12
            rowSpacing: 8
            Field {
                label: "到点平仓(美东 HH:MM)"
                tip: "下一次到这个钟点(美东)时持仓还在就平,记作到点平仓,不算止损。夜盘里填 03:00 指的是今晚过了零点的 03:00。软件关着不盯。"
                Input { width: parent.width; placeholder: "如 15:45;不填 = 不设"; text: root.v.exits.exitAt; onEdited: function (t) { root.setExit({ exitAt: t }) } }
            }
            Field {
                label: root.derivative ? "标的止损确认(秒)" : "止损确认(秒)"
                tip: root.derivative ? root.symbol + " 越过标的止损价之后,要在线外连续待满这么多秒才平;中途回到线内就从头数。不填 = 一碰线就平。"
                                     : root.symbol + " 的现价越过止损价(或跟踪止损线)之后,要在线外连续待满这么多秒才平;一笔打穿又弹回的不算,中途回到线内就从头数。不填 = 一碰线就平。托管到券商时用不了:券商触线即发。"
                InputNumber { width: parent.width; min: 0; max: 600; step: 1; placeholder: "不填 = 触线即算"; value: root.v.exits.stopConfirm; onValueEdited: function (x) { root.setExit({ stopConfirm: x }) } }
            }
            Field {
                visible: root.derivative
                label: "止损按哪个价判"
                tip: "止损、跟踪止损、利润回撤拿哪个价判。中间价:持仓的现价(各腿买卖中间价拼出来的)。可成交价:此刻立刻平掉能拿到的价(持有的腿按买价、卖出的腿按卖价)——它比中间价低一截,止损线等于\"至少卖到这个价\";代价是盘口一变宽就可能触发,便宜的蝶更明显。拿不到可成交价的那一秒退回按中间价判。止盈始终看中间价。"
                Select { width: parent.width; value: root.v.exits.stopBasis; options: [{ value: "mid", label: "中间价(默认)" }, { value: "natural", label: "可成交价(各腿买卖价)" }]; onActivated: function (x) { root.setExit({ stopBasis: x }) } }
            }
            Field {
                visible: root.derivative
                label: "峰值确认"
                tip: "跟踪止损与利润回撤的峰值(最有利价)默认每秒都能往上推。组合的现价是几条腿的中间价拼出来的,一条腿的报价晚到半秒、一笔挂得高的卖价,都能把它抬一截又落回——峰值只升不降,之后一比就是一次假回撤。勾上之后峰值要连续两秒都见到才推;代价是晚一秒,真的只出现了一秒的高点也不算。"
                Checkbox { height: Theme.controlHeight; text: "连续两秒都见到才推"; checked: root.v.exits.peakConfirm; onToggled: function (on) { root.setExit({ peakConfirm: on }) } }
            }
            Field {
                visible: root.derivative
                label: "止损追价:先等(秒)"
                tip: "止损类(止损、跟踪止损、利润回撤、标的止损)触发后,平仓单先在立刻成交价上等几秒再开始让价。不填 = 2 秒(和止盈同一套);0 = 不等。"
                InputNumber { width: parent.width; min: 0; max: 60; step: 1; placeholder: "不填 = 2"; value: root.v.exits.chaseGrace; onValueEdited: function (x) { root.setExit({ chaseGrace: x }) } }
            }
            Field {
                visible: root.derivative
                label: "止损追价:每秒让(跳)"
                tip: "止损类触发后每秒让几跳。不填 = 1 跳(和止盈同一套)。"
                InputNumber { width: parent.width; min: 1; max: 20; step: 1; placeholder: "不填 = 1"; value: root.v.exits.chaseStep; onValueEdited: function (x) { root.setExit({ chaseStep: x }) } }
            }
            Field {
                visible: root.derivative
                label: "止损追价:最多让价 %"
                tip: "止损类触发后最多让到立刻成交价的百分之几。不填 = 用上面的「追价最多让价 %」。"
                InputNumber { width: parent.width; min: 0; max: 100; step: 1; placeholder: "不填 = 同止盈"; value: root.v.exits.chaseMax; onValueEdited: function (x) { root.setExit({ chaseMax: x }) } }
            }
            Field {
                visible: root.derivative
                label: "下跌时追价多让(倍)"
                tip: "任何触发的追价都管:立刻成交价正在往不利方向走时,平仓单按「上一个改价间隔跌了多少」再多挂这么多倍,免得单子到了交易所价已经在它下面、一直追不上。不填 = 1 倍;0 = 不多让(只按每秒让一跳)。多让的加上每秒让的,仍不超过「追价最多让价 %」;行情不动时不多让。"
                InputNumber { width: parent.width; min: 0; max: 3; step: 0.5; placeholder: "不填 = 1"; value: root.v.exits.chaseLead; onValueEdited: function (x) { root.setExit({ chaseLead: x }) } }
            }
            Field {
                visible: root.derivative
                label: "追价改价间隔(秒)"
                tip: "追价时平仓单最快多久改一次价,0.25–1 秒。不填 = 1 秒(盯盘的节拍);填得更小,行情推送一到、离上次改价够了这么久就改,不等下一拍。"
                InputNumber { width: parent.width; min: 0.25; max: 1; step: 0.25; placeholder: "不填 = 1"; value: root.v.exits.chaseInterval; onValueEdited: function (x) { root.setExit({ chaseInterval: x }) } }
            }
            Field {
                visible: root.isCombo || root.position.sec_type === "OPT"
                label: "急跌保护:观察窗口(秒)"
                tip: "与下一项一起填写才启用。不等利润回撤线:最近这段时间内,可平仓报价从窗口内最有利的位置向不利方向变动达到阈值就平,亏损时也生效。多头看下跌,空头看平仓成本上涨。只在软件开着、有新鲜同步的实时买卖报价时检测。"
                InputNumber { objectName: "rapidWindowInput"; width: parent.width; min: 0.25; max: 5; step: 0.25; placeholder: "不填 = 不启用"; value: root.v.exits.rapidWindow; onValueEdited: function (x) { root.setExit({ rapidWindow: x }) } }
            }
            Field {
                visible: root.isCombo || root.position.sec_type === "OPT"
                label: "急跌保护:不利变动 %"
                tip: "按窗口内最有利的可平仓报价计算百分比,不是浮盈回吐百分比。触发后复用已有平仓单,使用止损追价设置、原平仓比例和让价上限。组合用限价追价,不保证成交;盘口突然变宽也可能触发。"
                InputNumber { objectName: "rapidPctInput"; width: parent.width; min: 0.01; max: 100; step: 0.1; placeholder: "与观察窗口一起填写"; value: root.v.exits.rapidPct; onValueEdited: function (x) { root.setExit({ rapidPct: x }) } }
            }
        }
        Column {
            visible: ex.open
            width: ex.width
            spacing: 6
            topPadding: 4
            Text {
                width: parent.width; wrapMode: Text.Wrap
                text: "分批止盈:持仓价到某一档就平掉此刻持仓的一部分(至少 1 张),成交之后接着盯剩下的。" + (root.isLong ? "各档的价一档比一档高。" : "各档的价一档比一档低。") + (root.hostOn ? " 托管到券商时设不了。" : "")
                color: Theme.labelSecondary; font.pixelSize: 11; font.family: Theme.fontFamily
            }
            Repeater {
                // 模型只放档数:改一个价时这一行不重建(重建了正在打字的框会丢焦点,后面的字落空)
                model: root.v.exits.tiers.length
                Row {
                    required property int index
                    readonly property var modelData: root.v.exits.tiers[index] || ({})
                    spacing: 8
                    Text { text: "第 " + (index + 1) + " 档"; color: Theme.labelSecondary; font.pixelSize: 11; font.family: Theme.fontFamily; anchors.verticalCenter: parent.verticalCenter }
                    InputNumber {
                        width: 130; min: 0; step: 0.05; enabled: !root.hostOn; placeholder: "持仓价到多少"; value: modelData.price === undefined ? null : modelData.price
                        onValueEdited: function (x) { var t = root.v.exits.tiers.slice(); t[index] = Object.assign({}, t[index], { price: x }); root.setExit({ tiers: t }) }
                    }
                    InputNumber {
                        width: 130; min: 1; max: 100; step: 5; enabled: !root.hostOn; placeholder: "平百分之几"; value: modelData.fraction === undefined ? null : modelData.fraction
                        onValueEdited: function (x) { var t = root.v.exits.tiers.slice(); t[index] = Object.assign({}, t[index], { fraction: x }); root.setExit({ tiers: t }) }
                    }
                    Button { kind: "text"; small: true; text: "去掉"; onClicked: root.setExit({ tiers: root.v.exits.tiers.filter(function (_, j) { return j !== index }) }) }
                }
            }
            Button {
                visible: root.v.exits.tiers.length < 4
                small: true
                enabled: !root.hostOn
                text: "加一档"
                onClicked: root.setExit({ tiers: root.v.exits.tiers.concat([{ price: null, fraction: null }]) })
            }
        }
    }
}
