import QtQuick
import Dafri.Kit

// 板块(pages/Sectors.tsx):板块 = 股票池,一只股登记一次,行上的「价位」「异动」两个开关决定盯它的什么。
// 上面新建板块、异动监控的心跳一行、每个板块一张卡片(列头 + 每只一行 + 价位条);下面最近异动、最近价位触发、提醒方式、触发条件、
// 价位穿越、反复碰均线。模型与取数在 C++(shell/sectors_controller + sectors_store);切走这一页,页面自己的状态清空
ScrollPage {
    id: page
    property var controller: null
    readonly property var m: controller ? controller.page : ({})
    Component.onCompleted: if (controller) controller.setVisible(true)
    Component.onDestruction: if (controller) controller.setVisible(false)
    Connections {
        target: page.controller
        ignoreUnknownSignals: true
        function onSectorCreated() { nameInput.text = "" }
        // 弹窗「查看」跳过来:把那一只的行滚到眼前
        function onReveal(symbol) { revealLater.symbol = symbol; revealLater.restart() }
    }
    // 等这一拍排完再找行。用页面自己的 Timer,不用 Qt.callLater:页面在这一拍里被拆掉时,Timer 跟着没了,排进去的函数不会落在已经销毁的上下文里
    Timer {
        id: revealLater
        property string symbol: ""
        interval: 0
        onTriggered: { var r = page.findRow(symbol); if (r) page.reveal(r) }
    }
    function findRow(symbol) {
        for (var i = 0; i < cardsRep.count; ++i) {
            var card = cardsRep.itemAt(i)
            var r = card ? card.rowFor(symbol) : null
            if (r) return r
        }
        return null
    }

    PageHead {
        width: parent.width
        title: "板块"
        Button { small: true; kind: "text"; text: "刷新行情"; onClicked: if (page.controller) page.controller.refreshQuotes() }
    }
    Item {
        width: parent.width
        height: 32 + 10
        Input {
            id: nameInput
            width: parent.width - 8 - newBtn.width
            placeholder: "自定义板块,例:AI 算力、减肥药、光模块"
            onEdited: function (t) { if (t.length > 50) text = t.slice(0, 50) }
            onAccepted: if (page.controller) page.controller.createSector(text)
        }
        Button { id: newBtn; anchors.right: parent.right; kind: "primary"; text: "新建板块"; onClicked: if (page.controller) page.controller.createSector(nameInput.text) }
    }
    Primer {
        id_: "intro-sectors"
        width: parent.width
        topPadding: 0
        summary: "池子、两个开关、扫描的关系"
        Hint {
            topPadding: 0
            text: "<b>板块就是股票池:一只股登记一次</b>,行上的两个开关决定盯它的什么—— <b>价位</b>(穿越期权墙 / 均线 / 整数关口时弹窗,行下画一条价位条)与 <b>异动</b>(放量 / 急涨急跌 / 大涨大跌,引擎每 5 秒看一遍)。加进来默认两个都开; 异动最多同时盯 30 只(每只占一条 TWS 行情线路),开不上的会直说。 「扫描」页对<b>同一个池子</b>做批量复盘(RS 强度 / 拐点 / 极值偏离),不用再维护第二份名单。"
        }
        Hint {
            text: "「AI 选股」由大模型给出板块代表性美股,<b>仅供研究参考</b>,不会自动交易。 行情来自 TWS,未订阅标的用 15 分钟延迟数据;行情每 30 秒刷一次,异动指标每 5 秒。 <b>只提醒,不下单。</b>"
        }
    }
    MonitorLine { width: parent.width; mon: page.m.monitor || ({}) }

    // 板块卡片(#sectors-list:每张最窄 720、等分,间距 12)
    EmptyState {
        visible: (page.m.sectors || []).length === 0
        width: parent.width
        text: "还没有板块。输入一个主题试试,比如「AI 算力」。"
    }
    Grid {
        id: grid
        visible: (page.m.sectors || []).length > 0
        width: parent.width
        columns: Math.max(1, Math.floor((width + 12) / (Math.min(720, width) + 12)))
        columnSpacing: 12; rowSpacing: 12
        // 按 id 原地更新(5 秒一轮的重读不重建卡片:敲了一半的代码、滚到一半的列表都还在)
        Repeater {
            id: cardsRep
            model: page.controller ? page.controller.cards : null
            SectorCard { required property var modelData; width: (grid.width - (grid.columns - 1) * 12) / grid.columns; s: modelData }
        }
    }

    SectionTitle { text: "最近异动"; count: (page.m.anomalyFeed || []).length }
    Feed { width: parent.width; model: page.m.anomalyFeed || []; empty: "还没有异动。盘中放量、急涨急跌时会出现在这里,同时弹窗提醒。" }

    // #section-alerts(.page-section 上 22,与分节标题的上 24 合并成 24)
    SectionTitle { text: "最近价位触发"; count: (page.m.priceFeed || []).length }
    // .sub-head:上 -4 下 8、18 高、靠右
    Item {
        width: parent.width
        height: 18 + 8 - 4
        Label { anchors.right: parent.right; y: -4 + (18 - implicitHeight) / 2; text: page.m.priceSub || ""; size: 11; color: Theme.labelSecondary }
    }
    Primer {
        id_: "intro-alerts"
        width: parent.width
        topPadding: 0
        summary: "价位从哪来、什么时候报"
        Hint {
            topPadding: 0
            text: "价位来自<b>当天期权墙</b>(持仓墙 / 成交墙 / 最大痛点 / Gamma 翻转)、<b>日线趋势位</b> (20 / 60 / 120 / 200 日均线与 52 周高低点)和<b>整数关口</b> (现价附近的步长整数倍:41 块、步长 5 → 40 和 45)。穿越报一次,离开足够远并过冷却后才再报,不会刷屏。 <b>OI 是隔夜存量</b>,当日到期以成交墙为准。任何页面都会检查(需已连 TWS)。"
        }
        Hint {
            text: "另有一类:<b>短期内反复碰同一条日均线</b>(默认 10 个交易日里第 3 次碰 20 / 60 / 120 / 200 日线)。 连着几天贴着线走只算一次,同一段只报一次;口径在页面底部「反复碰均线」里改。"
        }
        Hint {
            text: "新开的盯单由引擎<b>排队慢慢算</b>(期权链请求贵,一轮只算一只),算好之前行下写「正在算价位…」; 每天开盘后还会自己重算一遍,均线不会停在上次手点「重算墙」的那天。"
        }
    }
    Feed { width: parent.width; model: page.m.priceFeed || []; empty: "还没有价位触发记录。" }

    SectionTitle { text: "提醒方式" }
    Group {
        width: parent.width
        hint: "价位提醒与异动提醒共用这两个开关。"
        SwitchRow {
            width: parent.width
            label: "弹窗提醒"
            sub: "屏幕右上角的置顶小窗,不抢键盘焦点;关掉则退回系统通知"
            checked: page.m.popupOn !== false
            onToggled: function (on) { if (page.controller) page.controller.setPopupEnabled(on) }
            before: Button { small: true; text: "试弹"; onClicked: if (page.controller) page.controller.testPopup() }
        }
        SwitchRow {
            width: parent.width
            label: "提示音"
            sub: "急涨 / 上穿升调,急跌 / 下破降调,放量与反复碰均线是同一个音响两下"
            checked: page.m.soundOn !== false
            onToggled: function (on) { if (page.controller) page.controller.setSoundEnabled(on) }
            before: Button { small: true; text: "试听"; onClicked: if (page.controller) page.controller.previewTone() }
        }
    }

    SectionTitle { text: "触发条件" }
    Conditions { width: parent.width; c: page.m.conditions || null }

    SectionTitle { text: "价位穿越" }
    Group {
        width: parent.width
        hint: "开着时提醒会晚几十秒(等那一分钟走完),换来的是不报收回去的假突破。反复碰均线不受这个开关影响。"
        SwitchRow {
            width: parent.width
            label: "穿越要等 1 分钟收盘确认"
            sub: "关:两次取价(10 秒一次)之间跨过价位就报。开:跨过的那一分钟收完,最后一笔价还在价位另一侧才报"
            checked: !!page.m.crossConfirm
            onToggled: function (on) { if (page.controller) page.controller.setCrossConfirm(on) }
        }
    }

    SectionTitle { text: "反复碰均线" }
    TouchConfig { width: parent.width; t: page.m.touch || null }

    // ---- 心跳一行(.quality-monitor:元数据行,项间 14、竖 3、竖直居中,下 8;状态点那一项是 AntD Badge:6 的点、间 8、13px 正文色)
    component MonitorLine: Item {
        id: ml
        property var mon: ({})
        implicitHeight: (mon.hint ? hintL.implicitHeight : flow.implicitHeight) + 8
        Label { id: hintL; visible: !!ml.mon.hint; width: parent.width; wrap: true; text: ml.mon.hint || ""; size: 11; css: 1.55; color: Theme.labelSecondary }
        Flow {
            id: flow
            visible: !ml.mon.hint
            width: parent.width
            spacing: 14
            Repeater {
                model: ml.mon.items || []
                // 状态点(AntD Badge status:6 的点、离字 8、字 13px 正文色)
                Row {
                    required property var modelData
                    spacing: 8
                    // 一行竖直居中:按最高的那一项(13px 的状态字,行高 19.11)
                    height: 19.11
                    Rectangle {
                        visible: !!modelData.badge
                        anchors.verticalCenter: parent.verticalCenter
                        width: 6; height: 6; radius: 3
                        color: modelData.badge === "success" ? Theme.green : modelData.badge === "warning" ? Theme.orange : modelData.badge === "error" ? Theme.red : Theme.labelTertiary
                    }
                    Label {
                        anchors.verticalCenter: parent.verticalCenter
                        text: modelData.text
                        size: modelData.badge ? 13 : 11.5; tnum: true
                        color: modelData.badge ? Theme.label : modelData.link ? Theme.blue : modelData.warn ? Theme.orangeText : Theme.labelSecondary
                        HoverHandler { enabled: !!modelData.link; cursorShape: Qt.PointingHandCursor }
                        TapHandler { enabled: !!modelData.link; onTapped: Nav.navigate(modelData.link) }
                    }
                }
            }
        }
    }

    // ---- 一个板块(AntD 小号 Card + .sector-card:头上 8、30 高;身上 6 下 16、左右 16)
    component SectorCard: Card {
        id: sc
        property var s: ({})
        padding: 0
        implicitHeight: 30 + 6 + body.implicitHeight + 16 + 1
        function rowFor(symbol) {
            for (var i = 0; i < rowsRep.count; ++i) { var r = rowsRep.itemAt(i); if (r && r.r.symbol === symbol) return r }
            return null
        }
        Label { x: 17; y: 9 + (22 - implicitHeight) / 2; text: sc.s.title || ""; size: 13; weight: Theme.weightSemibold; family: Theme.fontMono; tnum: true }
        Row {
            anchors.right: parent.right; anchors.rightMargin: 17
            y: 9
            spacing: 4
            Button { small: true; padding: 6; implicitHeight: 22; text: sc.s.pickLabel || ""; busy: !!sc.s.picking; onClicked: if (page.controller) page.controller.pick(sc.s.id) }
            Button { small: true; padding: 6; implicitHeight: 22; kind: "text"; text: "删除"; onClicked: if (page.controller) page.controller.deleteSector(sc.s.id, sc.s.name) }
        }
        Column {
            id: body
            x: 17; y: 30 + 6
            width: sc.width - 34
            // 还没有成分股(<p class="muted">:上下 1em)
            Label {
                visible: !!sc.s.empty
                width: parent.width; wrap: true; topPadding: 11; bottomPadding: 11
                text: "还没有成分股:点「AI 选股」生成,或在下面手动添加。加进来的股默认盯价位、盯异动。"
                size: 11; color: Theme.labelSecondary
            }
            // .sector-stocks:上下 6、最高 300 超出滚动、右 2;列头钉在顶上
            Item {
                visible: !sc.s.empty
                width: parent.width
                height: visible ? 6 + Math.min(300, poolHead.height + rowsCol.implicitHeight) + 6 : 0
                PoolHead { id: poolHead; y: 6; width: parent.width - 2; windowMin: page.m.windowMin || "5" }
                Flickable {
                    y: 6 + poolHead.height
                    width: parent.width - 2
                    height: Math.min(300 - poolHead.height, rowsCol.implicitHeight)
                    contentHeight: rowsCol.implicitHeight
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds
                    Column {
                        id: rowsCol
                        width: parent.width
                        Repeater {
                            id: rowsRep
                            model: page.controller ? page.controller.rowsModel(sc.s.id) : null
                            PoolRow { required property var modelData; required property int index; width: rowsCol.width; r: modelData; last: index === (sc.s.rows || []).length - 1 }
                        }
                    }
                }
            }
            // 更新于(.card-meta:上 6,与上面的下 6 合并)
            Meta { visible: !sc.s.empty; topPadding: 0; width: parent.width; items: sc.s.meta ? [sc.s.meta] : [] }
            // 手动添加(.sector-card .row.tight:上 8)
            Item {
                width: parent.width
                height: 8 + 32
                Input {
                    id: symIn
                    y: 8
                    width: parent.width - 8 - 92 - 8 - addBtn.width
                    placeholder: "手动添加,如 NVDA"
                    onEdited: function (t) { if (t.length > 12) text = t.slice(0, 12) }
                    onAccepted: if (page.controller) page.controller.addStock(sc.s.id, symIn.text, tagIn.text)
                }
                Input {
                    id: tagIn
                    x: symIn.width + 8; y: 8
                    width: 92
                    placeholder: "业务标签"
                    onEdited: function (t) { if (t.length > 12) text = t.slice(0, 12) }
                    onAccepted: if (page.controller) page.controller.addStock(sc.s.id, symIn.text, tagIn.text)
                    Tip { text: "业务标签(如 芯片 / 数据中心),RS 强度按它汇总" }
                }
                Button {
                    id: addBtn
                    anchors.right: parent.right
                    y: 8 + (32 - height) / 2
                    small: true; padding: 6; implicitHeight: 22
                    text: "添加"
                    onClicked: if (page.controller) page.controller.addStock(sc.s.id, symIn.text, tagIn.text)
                }
                Connections {
                    target: page.controller
                    ignoreUnknownSignals: true
                    function onStockAdded(sectorId) { if (sectorId === sc.s.id) { symIn.text = ""; tagIn.text = "" } }
                }
            }
        }
    }

    // 列头(.stock-row.pool-head:上 2 下 4、10.5px 三级色,下 0.5 发丝线;和行同一套定宽格,靠左边的占位顶齐)
    component PoolHead: Item {
        id: ph
        property string windowMin: "5"
        height: 2 + headRow.height + 4 + 0.5
        Row {
            id: headRow
            y: 2
            anchors.right: parent.right
            spacing: 8
            HeadCell { w: 76; text: "现价" }
            HeadCell { w: 58; text: "涨跌" }
            HeadCell { w: 44; text: "量比"; tip: "全天量比:当日成交量 ÷ 同时段常态(90 日日均量 × 开盘到此刻的常态成交占比)" }
            HeadCell { w: 44; text: ph.windowMin + "分钟"; tip: "近 " + ph.windowMin + " 分钟成交量 ÷ 同时段常态;一笔大单撑起来的不算" }
            HeadCell { w: 34; text: "价位"; center: true; tip: "盯价位:穿越期权墙 / 均线 / 整数关口时弹窗" }
            HeadCell { w: 34; text: "异动"; center: true; tip: "盯异动:放量 / 急涨急跌 / 大涨大跌时弹窗(最多同时 30 只)" }
            Item { width: 40; height: 1 }
        }
        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 0.5; color: Theme.separator }
    }
    component HeadCell: Item {
        id: hc
        property real w: 44
        property string text: ""
        property string tip: ""
        property bool center: false
        width: w; height: hl.implicitHeight
        Label { id: hl; x: hc.center ? (hc.w - implicitWidth) / 2 : hc.w - implicitWidth; text: hc.text; size: 10.5; color: Theme.labelTertiary; tnum: true }
        Tip { text: hc.tip }
    }

    // 一只股:一行 + (盯价位时)行下的价位条(.stock-block:上 1 下 6、下沿 1px 线;最后一只没有线、下 0)
    component PoolRow: Column {
        id: pr
        property var r: ({})
        property bool last: false
        topPadding: 1
        bottomPadding: last ? 0 : 6
        Item {
            width: pr.width
            height: 5 + rowItems.height + 5
            // 左边:代码(600、最窄 52)+ 异动点、理由(11px 二级色,占满、省略)、标签胶囊
            Row {
                id: left
                anchors.verticalCenter: parent.verticalCenter
                spacing: 8
                width: pr.width - rowItems.width - 8
                Item {
                    width: Math.max(52, symL.implicitWidth + (pr.r.dot ? 11 : 0)); height: symL.implicitHeight
                    anchors.verticalCenter: parent.verticalCenter
                    Label { id: symL; text: pr.r.symbol || ""; size: 13; weight: 600 }
                    Rectangle {
                        visible: !!pr.r.dot
                        x: symL.implicitWidth + 5
                        anchors.verticalCenter: symL.verticalCenter
                        width: 6; height: 6; radius: 3
                        color: pr.r.dot && pr.r.dot.tone === "up" ? Theme.up : pr.r.dot && pr.r.dot.tone === "down" ? Theme.down : Theme.orange
                        Tip { text: pr.r.dot ? pr.r.dot.tip : "" }
                    }
                }
                Label {
                    id: subL
                    anchors.verticalCenter: parent.verticalCenter
                    width: Math.max(0, left.width - 52 - 8 - tagChip.width - 8 - (pr.r.dot ? 11 : 0))
                    elide: Text.ElideRight
                    text: pr.r.sub || ""
                    size: 11; color: Theme.labelSecondary
                    Tip { text: pr.r.subTip || "" }
                }
                TagChip { id: tagChip; anchors.verticalCenter: parent.verticalCenter; r: pr.r }
            }
            // 右边:定宽的数字格与两个开关、移除(和列头对齐)
            Row {
                id: rowItems
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                spacing: 8
                // 现价(76,右对齐,12px 等宽数字;延迟的前面一个 10px「延迟」)
                Item {
                    width: 76; height: priceL.implicitHeight
                    anchors.verticalCenter: parent.verticalCenter
                    Label { id: priceL; anchors.right: parent.right; text: pr.r.price ? pr.r.price.text : ""; size: pr.r.price && pr.r.price.kind === "none" ? 11 : 12; tnum: true
                        color: pr.r.price && pr.r.price.kind === "error" ? Theme.orangeText : pr.r.price && pr.r.price.kind === "none" ? Theme.labelSecondary : Theme.label
                        Tip { text: pr.r.price && pr.r.price.tip ? pr.r.price.tip : "" } }
                    Label { visible: !!(pr.r.price && pr.r.price.delayed); anchors.right: priceL.left; anchors.rightMargin: 5; anchors.baseline: priceL.baseline; text: "延迟"; size: 10; color: Theme.labelTertiary
                        Tip { text: "这只拿到的是延迟行情,提醒会晚约 15 分钟" } }
                }
                // 涨跌(58):数 + 一根以 0 为中心的小条(52 × 4,±5% 封顶),间 3
                Column {
                    width: 58
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 3
                    Label {
                        anchors.right: parent.right
                        text: pr.r.chg ? pr.r.chg.text : "—"; size: pr.r.chg ? 12 : 11; tnum: true
                        color: !pr.r.chg ? Theme.labelSecondary : pr.r.chg.tone === "pos" ? Theme.upText : pr.r.chg.tone === "neg" ? Theme.downText : Theme.label
                    }
                    DeltaBar { visible: !!pr.r.chg; anchors.right: parent.right; bar: pr.r.chg ? pr.r.chg.bar : null }
                }
                RatioCell { c: pr.r.rvol || ({}) }
                RatioCell { c: pr.r.burst || ({}) }
                SwitchCell { checked: !!pr.r.priceOn; busy: !!pr.r.priceBusy; tip: pr.r.priceTip || ""; onToggled: function (on) { if (page.controller) page.controller.toggle(pr.r.symbol, "price", on) } }
                SwitchCell { checked: !!pr.r.anomalyOn; busy: !!pr.r.anomalyBusy; tip: pr.r.anomalyTip || ""; onToggled: function (on) { if (page.controller) page.controller.toggle(pr.r.symbol, "anomaly", on) } }
                Item {
                    width: 40; height: 22
                    anchors.verticalCenter: parent.verticalCenter
                    Button { anchors.right: parent.right; small: true; padding: 6; implicitHeight: 22; kind: "text"; text: "移除"; onClicked: if (page.controller) page.controller.removeStock(pr.r.sector, pr.r.symbol) }
                }
            }
        }
        EarningsPanel {
            width: pr.width
            report: page.controller && page.controller.earnings ? (page.controller.earnings[pr.r.symbol] || {}) : ({})
            onRefresh: if (page.controller) page.controller.refreshEarnings(pr.r.symbol)
        }
        Levels { visible: !!pr.r.levels; width: pr.width; lv: pr.r.levels || ({}) }
        Rectangle { visible: !pr.last; width: pr.width; height: 1; color: Theme.separator }
    }

    // 量比的一格(44,11.5px,右对齐):关着「异动」/ 没数是「—」;全天量比下面一根表(36 × 4),到档橙色;窗口量比作不了准的压三级色、可带「参考」
    component RatioCell: Item {
        id: rc
        property var c: ({})
        width: 44; height: rcCol.implicitHeight
        anchors.verticalCenter: parent ? parent.verticalCenter : undefined
        Column {
            id: rcCol
            anchors.right: parent.right
            spacing: 3
            Row {
                anchors.right: parent.right
                spacing: 3
                Label {
                    text: rc.c.kind === "num" ? rc.c.text : "—"
                    // 没数的「—」是 .muted(11px)
                    size: rc.c.kind === "num" ? 11.5 : 11; tnum: true
                    weight: rc.c.hot ? Theme.weightSemibold : Font.Normal
                    color: rc.c.kind !== "num" ? Theme.labelSecondary : rc.c.hot ? Theme.orangeText : rc.c.soft ? Theme.labelTertiary : Theme.label
                }
                Label { visible: !!rc.c.reference; anchors.bottom: parent.bottom; text: "参考"; size: 10; color: Theme.labelTertiary }
            }
            Rectangle {
                visible: rc.c.meter !== undefined
                anchors.right: parent.right
                width: 36; height: 4; radius: 2
                color: Theme.bgFillStrong
                clip: true
                Rectangle { width: parent.width * (rc.c.meter || 0) / 100; height: parent.height; radius: 2; color: rc.c.tint === "orange" ? Theme.orange : Theme.gray }
            }
        }
        Tip { text: rc.c.tip || "" }
    }
    component DeltaBar: Item {
        id: db
        property var bar: null
        width: 52; height: 4
        Rectangle { anchors.fill: parent; radius: 2; color: Theme.bgFill }
        Rectangle {
            visible: !!db.bar && db.bar.dir !== ""
            x: db.bar && db.bar.dir === "up" ? db.width / 2 : db.width / 2 - width
            width: db.bar ? db.width * db.bar.pct / 100 : 0
            height: parent.height
            topRightRadius: db.bar && db.bar.dir === "up" ? 2 : 0; bottomRightRadius: topRightRadius
            topLeftRadius: db.bar && db.bar.dir === "down" ? 2 : 0; bottomLeftRadius: topLeftRadius
            color: db.bar && db.bar.dir === "up" ? Theme.up : Theme.down
        }
        // 0 那一条刻度:上下各伸出 2
        Rectangle { x: db.width / 2; y: -2; width: 1; height: db.height + 4; color: Theme.labelTertiary }
    }
    component SwitchCell: Item {
        id: swc
        property bool checked: false
        property bool busy: false
        property string tip: ""
        signal toggled(bool on)
        width: 34; height: 16
        anchors.verticalCenter: parent ? parent.verticalCenter : undefined
        Switch { anchors.centerIn: parent; small: true; checked: swc.checked; opacity: swc.busy ? 0.55 : 1; enabled: !swc.busy; onToggled: function (on) { swc.toggled(on) } }
        Tip { text: swc.tip }
    }
    // 业务标签胶囊(10px、16 高 + 上下 1、左右 7、8 圆角;有标签是蓝底蓝字,没有是填充底三级色「＋标签」);点一下变成输入框,回车 / 失焦提交,Esc 取消
    component TagChip: Item {
        id: tc
        property var r: ({})
        readonly property var t: r.tag || ({})
        width: t.editing ? 96 : Math.min(96, chipL.implicitWidth + 14)
        height: t.editing ? 20 : 18
        Rectangle {
            visible: !tc.t.editing
            anchors.fill: parent
            radius: 8
            color: tc.t.none ? Theme.bgFill : Theme.tint(Theme.blue, 0.12)
            Label { id: chipL; x: 7; anchors.verticalCenter: parent.verticalCenter; width: Math.min(implicitWidth, 96 - 14); elide: Text.ElideRight; text: tc.t.text || ""; size: 10; color: tc.t.none ? Theme.labelTertiary : Theme.blue }
            HoverHandler { cursorShape: Qt.PointingHandCursor }
            TapHandler { onTapped: if (page.controller) page.controller.editTag(tc.r.sector, tc.r.symbol) }
            Tip { text: tc.t.tip || "" }
        }
        Input {
            id: tagEdit
            visible: !!tc.t.editing
            anchors.fill: parent
            small: true
            placeholder: "业务标签"
            text: tc.t.value || ""
            onVisibleChanged: if (visible) { forceActiveFocus(); selectAll() }
            onEdited: function (s) { if (s.length > 12) text = s.slice(0, 12) }
            onAccepted: if (page.controller) page.controller.finishTag(tc.r.sector, tc.r.symbol, text, true)
            onEditingFinished: if (page.controller && tc.t.editing) page.controller.finishTag(tc.r.sector, tc.r.symbol, text, true)
            Keys.onEscapePressed: if (page.controller) page.controller.finishTag(tc.r.sector, tc.r.symbol, text, false)
        }
    }

    // 价位条(.stock-levels:上 6 左右 4 下 4、往两边各伸 4、填充底、6 圆角);还没有价位时是一行 11px 的「正在算价位…」(上 3 左右 6 下 4)
    component Levels: Item {
        id: lvs
        property var lv: ({})
        readonly property bool pending: lv.kind === "pending"
        height: visible ? (pending ? 3 + pendRow.height + 4 : 8 + strip.height + 4 + metaRow.height + (errL.visible ? errL.height : 0) + 4) : 0
        Rectangle { x: -4; width: lvs.width + 8; height: lvs.height; radius: 6; color: Theme.bgFill }
        Row {
            id: pendRow
            visible: lvs.pending
            x: 2; y: 3
            spacing: 8
            Label {
                anchors.verticalCenter: parent.verticalCenter
                text: lvs.lv.warn || lvs.lv.text || ""
                size: 11; color: lvs.lv.warn ? Theme.orangeText : Theme.labelSecondary
                Tip { text: lvs.lv.tip || "" }
            }
            Button { anchors.verticalCenter: parent.verticalCenter; inline: true; kind: "text"; textColor: Theme.blue; text: "立刻算"; busy: !!lvs.lv.computing; onClicked: if (page.controller) page.controller.refreshWatch(lvs.lv.id) }
        }
        LevelStrip {
            id: strip
            visible: !lvs.pending
            // 上 6 + 价位条自己的上 2(量的:条顶离这一块的顶 8)
            y: 8
            width: lvs.width
            layout: visible && page.controller ? function (w) { return page.controller.levelStrip(lvs.lv.levels || [], lvs.lv.spot === undefined ? null : lvs.lv.spot, w) } : null
        }
        // 墙的摘要 + 「重算墙」(.pool-wall.card-meta:上 4、左右 2)
        Flow {
            id: metaRow
            visible: !lvs.pending
            x: 2; y: 8 + strip.height + 4
            width: lvs.width - 4
            spacing: 14
            Repeater {
                model: lvs.pending ? [] : (lvs.lv.meta || [])
                Item {
                    required property var modelData
                    width: modelData.step ? stepRow.width : modelData.button !== undefined ? recalc.width : metaL.implicitWidth
                    // 这一行按最高的那一项(步长的下拉)竖直居中:18.9
                    height: 18.9
                    Row {
                        id: stepRow
                        visible: !!modelData.step
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 2
                        Label { anchors.verticalCenter: parent.verticalCenter; text: modelData.text || ""; size: 11.5; color: Theme.labelSecondary }
                        Select {
                            anchors.verticalCenter: parent.verticalCenter
                            borderless: true
                            enabled: !lvs.lv.computing
                            value: modelData.stepValue
                            options: page.stepOptions(modelData.stepValue)
                            onActivated: function (v) { if (page.controller) page.controller.refreshWatch(lvs.lv.id, "", v) }
                        }
                    }
                    Tip { text: modelData.step ? "自动 = 按现价分档:1 / 2.5 / 5 × 10ⁿ 里不小于现价 0.6% 的最小一档(相邻两个关口各自 ±0.3% 的范围不叠)。选一个数就一直用它" : "" }
                    Label { id: metaL; anchors.verticalCenter: parent.verticalCenter; visible: !modelData.step && modelData.button === undefined; text: modelData.text || ""; size: 11.5; tnum: true; color: Theme.labelSecondary
                        Tip { text: modelData.title || "" } }
                    Button { id: recalc; anchors.verticalCenter: parent.verticalCenter; visible: modelData.button !== undefined; inline: true; kind: "text"; textColor: Theme.blue; text: modelData.button || ""; busy: !!modelData.loading
                        onClicked: if (page.controller) page.controller.refreshWatch(lvs.lv.id) }
                }
            }
        }
        Label { id: errL; visible: !lvs.pending && !!lvs.lv.error; x: 2; y: metaRow.y + metaRow.height; width: lvs.width - 4; wrap: true; topPadding: 7; text: lvs.lv.error || ""; size: 11; css: 1.55; color: Theme.orangeText }
    }
    /// 步长可选的几档(StepPicker 的 STEP_CHOICES,盯单上存着别的数也列出来)
    function stepOptions(current) {
        var fixed = [0.5, 1, 2.5, 5, 10, 25, 50, 100]
        if (current > 0 && fixed.indexOf(current) < 0) fixed.push(current)
        fixed.sort(function (a, b) { return a - b })
        return [{ value: 0, label: "自动" }].concat(fixed.map(function (v) { return { value: v, label: String(v) } }))
    }

    // ---- 触发条件(lib/Conditions.tsx)
    component Conditions: Item {
        id: cd
        property var c: null
        implicitHeight: c ? grp.implicitHeight : empty.implicitHeight
        // 紧跟分节标题:小号空态的上 4 并进标题的下 9
        EmptyState { id: empty; visible: !cd.c; width: parent.width; compact: true; topMargin: 0; text: "阈值还没读到。" }
        Group {
            id: grp
            visible: !!cd.c
            width: parent.width
            hint: "改完自动保存,下一轮(5 秒内)生效;今天已经报过的档不会重报。"
            NumberRow {
                width: parent.width
                label: cd.c ? cd.c.rvolLabel : ""; sub: cd.c ? cd.c.rvolSub : ""
                min: 1.2; max: 20; step: 0.5; value: cd.c ? cd.c.rvol : null
                onValueEdited: function (v) {
                    if (v === null || !(v >= 1.2) || !page.controller) return
                    var a = Math.round(Math.min(20, v) * 100) / 100
                    page.controller.patchConditions({ rvol_tiers: [a, Math.round(a * 1.5 * 100) / 100, Math.round(a * 2.5 * 100) / 100] })
                }
            }
            NumberRow {
                width: parent.width
                label: cd.c ? cd.c.burstLabel : ""; sub: cd.c ? cd.c.burstSub : ""
                min: 1.5; max: 50; step: 0.5; value: cd.c ? cd.c.burst : null
                onValueEdited: function (v) { if (v !== null && v >= 1.5 && page.controller) page.controller.patchConditions({ burst_ratio: Math.round(Math.min(50, v) * 100) / 100 }) }
            }
            GroupRow {
                width: parent.width
                label: "短时窗口"; sub: "放量与急涨急跌看的是最近多久"
                Segmented {
                    small: true
                    options: [{ value: 3, label: "3 分钟" }, { value: 5, label: "5 分钟" }, { value: 10, label: "10 分钟" }]
                    value: cd.c ? cd.c.window : 5
                    onActivated: function (v) { if (page.controller) page.controller.patchConditions({ window_min: Number(v) }) }
                }
            }
            NumberRow {
                width: parent.width
                label: cd.c ? cd.c.spikeLabel : ""; sub: cd.c ? cd.c.spikeSub : ""
                min: 1.5; max: 20; step: 0.5; value: cd.c ? cd.c.spike : null
                onValueEdited: function (v) { if (v !== null && v >= 1.5 && page.controller) page.controller.patchConditions({ spike_sigma: Math.round(Math.min(20, v) * 100) / 100 }) }
            }
            NumberRow {
                width: parent.width
                label: "大涨大跌:起报 σ"; sub: cd.c ? cd.c.daySub : ""
                min: 0.5; max: 18; step: 0.5; value: cd.c ? cd.c.day : null
                onValueEdited: function (v) {
                    if (v === null || !(v >= 0.5) || !page.controller) return
                    var a = Math.round(Math.min(18, v) * 100) / 100
                    page.controller.patchConditions({ day_sigma_tiers: [a, Math.round((a + 1) * 100) / 100, Math.round((a + 2) * 100) / 100] })
                }
            }
            NumberRow {
                width: parent.width
                label: "冷却(分钟)"; sub: "短时放量 / 急涨急跌报过之后,至少隔这么久才会再报同一类"
                min: 1; max: 240; step: 1; value: cd.c ? cd.c.cooldown : null
                onValueEdited: function (v) { if (v !== null && v >= 1 && page.controller) page.controller.patchConditions({ cooldown_min: Math.round(Math.min(240, v)) }) }
            }
            SwitchRow {
                width: parent.width
                label: "急涨急跌、大涨大跌:扣掉大盘同期涨跌"
                sub: "开:只报扣掉标普 500 同期涨跌之后还够档的(直接相减,不按每只股的 beta);跟着指数走的 ETF 会因此不报。关:照自己的涨跌报,提醒里注明标普同期"
                    + (cd.c && cd.c.marketWarn ? " · 这一轮读不到标普 500 指数的行情(没有权限、今天还没开始跳、或者停更了):没有在扣,提醒里会写「无大盘参照、未扣」" : "")
                checked: !!(cd.c && cd.c.marketAdjust)
                onToggled: function (on) { if (page.controller) page.controller.patchConditions({ market_adjust: on }) }
            }
        }
    }

    // ---- 反复碰均线(lib/TouchConfig.tsx)
    component TouchConfig: Item {
        id: tcf
        property var t: null
        implicitHeight: t ? grp2.implicitHeight : empty2.implicitHeight
        EmptyState { id: empty2; visible: !tcf.t; width: parent.width; compact: true; topMargin: 0; text: "设置还没读到。" }
        Group {
            id: grp2
            visible: !!tcf.t
            width: parent.width
            hint: tcf.t ? tcf.t.hint : ""
            SwitchRow {
                width: parent.width
                label: "短期内反复碰同一条均线时提醒"
                sub: "只在常规时段判;同一段触碰只报一次,和同一条均线的穿越并成一条"
                checked: !!(tcf.t && tcf.t.enabled)
                onToggled: function (on) { if (page.controller) page.controller.patchTouch({ enabled: on }, true) }
            }
            GroupRow {
                width: parent.width
                enabled: !!(tcf.t && tcf.t.enabled)
                label: "看哪几条日均线"; sub: "最多 6 条;价位条上画的是 20 / 60 / 120 / 200"
                // Select mode="tags":选中的几条一排胶囊(这里不做下拉里加新值,只列可选的九条)
                Row {
                    spacing: 4
                    Repeater {
                        model: [5, 10, 20, 30, 50, 60, 120, 200, 250]
                        Rectangle {
                            required property var modelData
                            readonly property bool on: !!tcf.t && (tcf.t.periodValues || []).indexOf(modelData) >= 0
                            width: pl.implicitWidth + 12; height: 22; radius: 6
                            color: on ? Theme.bgControl : Theme.bgFill
                            border.width: on ? 1 : 0; border.color: Theme.separator
                            Label { id: pl; anchors.centerIn: parent; text: modelData + " 日"; size: 11.5; color: parent.on ? Theme.label : Theme.labelTertiary }
                            TapHandler {
                                enabled: !!(tcf.t && tcf.t.enabled)
                                onTapped: {
                                    var cur = (tcf.t.periodValues || []).slice()
                                    var i = cur.indexOf(parent.modelData)
                                    if (i >= 0) cur.splice(i, 1); else cur.push(parent.modelData)
                                    if (cur.length && page.controller) page.controller.patchTouch({ periods: cur }, true)
                                }
                            }
                        }
                    }
                }
            }
            NumberRow {
                width: parent.width
                enabled: !!(tcf.t && tcf.t.enabled)
                label: "「短期内」:最近几个交易日"; sub: "含今天"
                min: 3; max: 30; step: 1; value: tcf.t ? tcf.t.window : null
                onValueEdited: function (v) {
                    if (v === null || !(v >= 3) || !page.controller) return
                    var w = Math.round(Math.min(30, v)), cap = Math.ceil(w / 2)
                    page.controller.patchTouch(tcf.t.minTouches > cap ? { window_days: w, min_touches: cap } : { window_days: w }, false)
                }
            }
            NumberRow {
                width: parent.width
                enabled: !!(tcf.t && tcf.t.enabled)
                label: "第几次碰到开始报"; sub: tcf.t ? tcf.t.touchesSub : ""
                min: 2; max: tcf.t ? tcf.t.most : 10; step: 1; value: tcf.t ? tcf.t.minTouches : null
                onValueEdited: function (v) { if (v !== null && v >= 2 && page.controller) page.controller.patchTouch({ min_touches: Math.round(Math.min(10, v)) }, false) }
            }
            NumberRow {
                width: parent.width
                enabled: !!(tcf.t && tcf.t.enabled)
                label: "离均线多近算碰到(%)"; sub: "那天的最高 / 最低价进到均线上下这个范围以内;盘中看现价,两轮之间跨过去也算"
                min: 0; max: 2; step: 0.1; value: tcf.t ? tcf.t.band : null
                onValueEdited: function (v) { if (v !== null && v >= 0 && page.controller) page.controller.patchTouch({ band_pct: Math.round(Math.min(2, v) * 100) / 100 }, false) }
            }
        }
    }
}
