import QtQuick
import Dafri.Kit

// 扫描(pages/Screener.tsx + lib/ScanTable.tsx、LeadersSection.tsx、DeviationSection.tsx):一个股票池、一次扫描、一张表——每只股一行,
// RS 强度与各周期的 CD 背离并排;点哪一行,下面就是它的极值偏离。模型与取数都在 C++(shell/screener_controller、shell/screener_rules);
// 切走这一页状态清空,同原版组件卸载
ScrollPage {
    id: page
    property var controller: null
    readonly property var m: controller ? controller.page : ({})
    readonly property var dev: m.dev || ({})
    readonly property var leaders: m.leaders || ({})
    Component.onCompleted: if (controller) controller.setVisible(true)
    Component.onDestruction: if (controller) controller.setVisible(false)
    Connections {
        target: page.controller
        ignoreUnknownSignals: true
        // 点了一行:复盘在表的下面,不滚过去的话点了像没反应(scrollIntoView block: start,吸顶大标题留 64:.scan-detail 的 scroll-margin-top)
        function onRevealDeviation() { revealLater.restart() }
    }
    // 等这一拍排完再滚。页面自己的 Timer(不用 Qt.callLater):页面在这一拍里被拆掉时跟着没了
    Timer { id: revealLater; interval: 0; onTriggered: page.revealTop(devSection, 64) }
    function revealTop(item, margin) {
        var p = item.mapToItem(page.column, 0, 0)
        page.contentY = Math.max(0, Math.min(p.y + 6 - margin, page.contentHeight - page.height))
    }

    PageHead { width: parent.width; title: "扫描" }
    // .sub-head:扫着是「正在…」,不然是一行摘要;靠右、11px 二级色、18 高;上 -4、下 8
    Item {
        width: parent.width
        height: 18 + 8 - 4
        Working {
            visible: !!page.m.busy
            anchors.right: parent.right
            y: -4 + (18 - height) / 2
            text: page.m.progress || ""
        }
        Label {
            visible: !page.m.busy
            anchors.right: parent.right
            y: -4 + (18 - implicitHeight) / 2
            text: page.m.summary || ""
            size: 11; color: Theme.labelSecondary; tnum: true
        }
    }
    // .row.tight.scan-bar:股票池(占满)、基准、周期、均线、「扫描」;间距 8、下 10;放不下就折行(股票池最窄 180)
    Item {
        id: scanBar
        width: parent.width
        readonly property real fixedW: 8 + benchSeg.width + 8 + tfPicks.width + 8 + 92 + 8 + scanBtn.width
        readonly property bool wraps: width - fixedW < 180
        height: (wraps ? 32 + 8 + 32 : 32) + 10
        Select {
            id: poolSelect
            width: scanBar.wraps ? parent.width : parent.width - scanBar.fixedW
            options: page.m.sectorOptions || []
            value: page.m.sector
            onActivated: function (v) { if (page.controller) page.controller.setSector(v) }
        }
        Row {
            x: scanBar.wraps ? 0 : poolSelect.width + 8
            y: scanBar.wraps ? 40 : 0
            height: 32
            spacing: 8
            Segmented {
                id: benchSeg
                anchors.verticalCenter: parent.verticalCenter
                small: true
                options: ["SPY", "QQQ"]
                value: page.m.benchmark
                onActivated: function (v) { if (page.controller) page.controller.setBenchmark(v) }
                Tip { text: "RS 强度的基准" }
            }
            // .tf-picks:填充底的轨道、内边距 2、间距 2、8 圆角;每个周期一枚可勾的标签(左右 10、6 圆角、12px);勾上的是控件面 + 控件投影、510
            Rectangle {
                id: tfPicks
                anchors.verticalCenter: parent.verticalCenter
                width: tfRow.implicitWidth + 4
                height: 26
                radius: 8
                color: Theme.bgFill
                Tip { text: "找 CD 背离的 K 线周期,可多选;一个都不选就只算 RS" }
                Row {
                    id: tfRow
                    x: 2; y: 2
                    spacing: 2
                    Repeater {
                        model: page.m.timeframes || []
                        Item {
                            required property var modelData
                            width: tfText.implicitWidth + 20
                            height: 22
                            Glass {
                                anchors.fill: parent
                                visible: parent.modelData.checked
                                radius: 6
                                fill: Theme.bgControl
                                edge: Theme.edgeControl
                            }
                            Rectangle {
                                anchors.fill: parent
                                radius: 6
                                visible: !parent.modelData.checked && tfHover.hovered
                                color: Theme.bgFill
                            }
                            Label {
                                id: tfText
                                anchors.centerIn: parent
                                text: parent.modelData.label
                                size: 12; css: 1.5
                                weight: parent.modelData.checked ? Theme.weightMedium : Font.Normal
                            }
                            HoverHandler { id: tfHover }
                            TapHandler { onTapped: if (page.controller) page.controller.toggleTimeframe(parent.modelData.value, !parent.modelData.checked) }
                        }
                    }
                }
            }
            InputNumber {
                width: 92
                min: 0; max: 250
                value: page.m.ma === undefined ? null : page.m.ma
                onValueEdited: function (v) { if (page.controller) page.controller.setMa(v) }
                Tip { text: "背离的右侧确认均线周期,0 = 不要求确认" }
            }
            Button {
                id: scanBtn
                kind: "primary"
                text: "扫描"
                busy: !!page.m.busy
                onClicked: if (page.controller) page.controller.run()
            }
        }
    }
    Primer {
        id_: "intro-scan"
        width: parent.width
        topPadding: 0
        summary: "这一页的数字怎么算"
        HintList {
            items: [
                "<b>RS 强度</b>:每个区间(1 周 / 1 月 / 1 季 / 半年 / 1 年,按交易日)算成员收益与基准收益,<b>RS = (1 + 成员收益) ÷ (1 + 基准收益) − 1</b>,就是\"跑赢基准多少\"。综合分是各区间 RS 的平均;按成分股的<b>业务标签</b>汇总时取中位数(抗一只妖股),并数跑赢家数。标签在「板块」页的成分股行上点击即可改。日线来自券商,10 分钟内重复扫描不重新拉取。",
                "<b>拐点(CD 背离)</b>:CD 指 MACD 快线 DIF(EMA12 − EMA26)。价格创更低的低点、DIF 却抬高 = 底背离;价格创新高、DIF 却走低 = 顶背离;经典口径要求两个点的 DIF 在零轴同一侧。这是<b>左侧</b>信号——拐点还没确认,所以可选<b>右侧均线确认</b>:背离之后收盘穿过指定均线且仍站在那一侧才算「已确认」,穿过又回去算「作废」。周线由日线重采样;日内周期走行情页 K 线的节流缓存,一次最多 40 个(标的 × 周期)。",
                "<b>极值偏离</b>(点表里的一行):<b>修正版买卖压力</b>是收盘在当根<b>真实区间</b>(把前收盘算进高低点,跳空也量得出)里的位置,折成 −1 … +1,按相对成交量加权(当根量 ÷ 前 20 根均量,封顶 3 倍),再做 5 根 EMA 平滑。<b>偏离程度</b>是收盘相对均线的百分比,对近段历史折 <b>z 分数</b>——同样偏离 8%,对日常波动 1% 的股是极值,对波动 5% 的不算;|z| ≥ 2 标为极值。只陈述数字,不给操作建议。"
            ]
        }
    }

    // ---- 行业标签卡(.rs-tags:每张最窄 240、等分、间距 12;上下 10,上面那 10 与 Primer 的下 12 合并)
    Hint {
        visible: !!(page.m.tagCards && page.m.tagCards.hint)
        width: parent.width
        text: page.m.tagCards && page.m.tagCards.hint ? page.m.tagCards.hint : ""
    }
    Grid {
        id: tagGrid
        readonly property var cards: page.m.tagCards && page.m.tagCards.cards ? page.m.tagCards.cards : []
        visible: cards.length > 0
        width: parent.width
        columns: Math.max(1, Math.floor((width + 12) / (240 + 12)))
        columnSpacing: 12; rowSpacing: 12
        bottomPadding: 10
        Repeater {
            model: tagGrid.cards
            TagCard { required property var modelData; width: (tagGrid.width - (tagGrid.columns - 1) * 12) / tagGrid.columns; c: modelData }
        }
    }

    // ---- 表(AntD 小号 Table:格子 5 × 8、12px;表头 11px 590 二级色、下边 1px;每行下边 1px;带纵向滚动的表固定布局:
    //      给了宽的列照宽,没给宽的(各周期的背离)分剩下的;一列都没有剩下的就按比例撑满)
    Column {
        id: table
        visible: !!page.m.table
        width: parent.width
        readonly property var cols: page.m.table ? page.m.table.columns : []
        readonly property var widths: {
            var fixed = 0, flex = 0
            for (var i = 0; i < cols.length; ++i) { if (cols[i].width) fixed += cols[i].width; else flex += 1 }
            var extra = Math.max(0, width - fixed), out = []
            for (var k = 0; k < cols.length; ++k) {
                if (!cols[k].width) out.push(extra / flex)
                else out.push(flex > 0 || fixed <= 0 ? cols[k].width : cols[k].width * Math.max(1, width / fixed))
            }
            return out
        }
        readonly property var offsets: { var out = [0]; for (var k = 0; k < widths.length; ++k) out.push(out[k] + widths[k]); return out }
        function colX(i) { return offsets[i] || 0 }
        Item {
            width: parent.width
            height: 29.7
            Repeater {
                model: table.cols
                Item {
                    required property var modelData
                    required property int index
                    x: table.colX(index)
                    width: table.widths[index] || 0
                    height: parent.height - 1
                    // 排序的列:字靠右,后面空 4 是上下两枚三角(11px;排着的那一枚强调色)
                    readonly property real sorterW: modelData.sortable ? 4 + 11 : 0
                    Row {
                        id: head
                        x: parent.modelData.right ? parent.width - 8 - parent.sorterW - implicitWidth : 8
                        y: 5
                        spacing: 6
                        Label { text: modelData.title; size: 11; weight: Theme.weightSemibold; color: Theme.labelSecondary; css: 16.17 }
                        Label { visible: !!modelData.sub; text: modelData.sub || ""; size: 11; color: Theme.labelTertiary; css: 16.17 }
                    }
                    Item {
                        visible: !!parent.modelData.sortable
                        x: parent.width - 8 - 11; y: 5
                        width: 11; height: 18.7
                        Icon { y: 0; name: "ad-caret-up"; size: 11; color: parent.parent.modelData.order === "ascend" ? Theme.blue : Theme.tint(Theme.labelSecondary, 0.65) }
                        Icon { y: 7.7; name: "ad-caret-down"; size: 11; color: parent.parent.modelData.order === "descend" ? Theme.blue : Theme.tint(Theme.labelSecondary, 0.65) }
                    }
                    Tip { text: parent.modelData.tip || "" }
                    TapHandler { enabled: !!parent.modelData.sortable; onTapped: if (page.controller) page.controller.sortBy(parent.modelData.key) }
                    HoverHandler { cursorShape: parent.modelData.sortable ? Qt.PointingHandCursor : Qt.ArrowCursor }
                }
            }
            Rectangle { y: parent.height - 1; width: parent.width; height: 1; color: Theme.separator }
        }
        // 表体最高 520,超出在表里滚(scroll.y = 520)
        Flickable {
            id: bodyFlick
            width: parent.width
            height: Math.min(520, bodyCol.height)
            contentHeight: bodyCol.height
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            interactive: contentHeight > height
            Column {
                id: bodyCol
                width: bodyFlick.width
                Repeater {
                    model: page.controller ? page.controller.rows : null
                    ScanRow { required property var modelData; width: bodyCol.width; r: modelData }
                }
            }
        }
    }
    Meta { visible: !!page.m.table; width: parent.width; items: (page.m.meta || []).map(function (t) { return { text: t } }) }
    // 上 10 并进 Primer 的下 12,下 10 并进节标题的上 24
    EmptyState { visible: !!page.m.empty; width: parent.width; topMargin: 0; bottomMargin: 0; text: page.m.empty || "" }

    // ---- 强势股筛选(.leaders:上 18,与节标题的上 24 合并)
    SectionTitle { width: parent.width; text: "强势股筛选 · 趋势模板 + VCP" }
    Item {
        width: parent.width
        height: 32 + 10
        Row {
            height: 32
            spacing: 8
            Button {
                kind: "primary"
                text: "筛选强势股"
                busy: !!page.leaders.busy
                onClicked: if (page.controller) page.controller.runLeaders()
            }
            Segmented {
                visible: !!page.leaders.data
                anchors.verticalCenter: parent.verticalCenter
                small: true
                options: page.leaders.data ? page.leaders.data.segments : []
                value: page.leaders.filter
                onActivated: function (v) { if (page.controller) page.controller.setLeadersFilter(v) }
            }
            Label {
                visible: !!page.leaders.data
                anchors.verticalCenter: parent.verticalCenter
                text: page.leaders.data ? page.leaders.data.info : ""
                size: 12; color: Theme.labelSecondary; tnum: true
            }
        }
    }
    Primer {
        id_: "intro-leaders"
        width: parent.width
        topPadding: 0
        summary: "这些规则从哪来、怎么算"
        HintList {
            items: [
                "<b>趋势模板</b>(Mark Minervini,美国投资锦标赛 1997、2021 冠军):价在 150 / 200 日线上、150 日线在 200 日线上、200 日线上行至少 1 个月、50 日线在两者之上、价在 50 日线上、比 52 周低点高 30% 以上、离 52 周高点 25% 以内、RS 评级 ≥ 70。<b>8 条全过才算第二阶段上升趋势</b>,一条不过就淘汰。",
                "<b>VCP 波动收缩</b>:从基底最高点起,每次回撤比上一次浅(例如 20% → 10% → 5%),最后一次缩量;放量(≥ 50 日均量 1.4 倍)越过枢轴——最后一次收缩开始时的高点——才是他的买点。",
                "<b>RS 评级</b>(William O'Neil / IBD,David Ryan 靠这套三连冠美国投资锦标赛):近 3 个月涨幅占 40%、前三个季度各 20%,在这次扫的池子里排百分位。池子越大越有意义。",
                "<b>大盘方向</b>(CAN SLIM 的 M):基准跌 ≥ 0.2% 且量比前一天大算一个派发日,25 个交易日内累积 4 个以上是承压、跌破 200 日线是调整。O'Neil:四只股票有三只跟着大盘走。",
                "只用券商日线;CAN SLIM 里要财报与机构持仓的 C / A / I 没算。只陈述规则过没过,不构成投资建议。"
            ]
        }
    }
    // .leaders .notice:上下 8
    Column {
        width: parent.width
        Alert {
            visible: !!page.leaders.error
            width: parent.width
            tone: "error"; title: "强势股没筛成"; text: page.leaders.error || ""
        }
        Item { visible: !!page.leaders.error; width: 1; height: 8 }
        Working { visible: !!page.leaders.busy && !page.leaders.data; text: "正在拉日线按趋势模板逐只检查…" }
        Alert {
            visible: !!page.leaders.data
            width: parent.width
            tone: page.leaders.data ? ({ ok: "success", warn: "warn", bad: "error", info: "info" })[page.leaders.data.market.tone] : "info"
            title: page.leaders.data ? page.leaders.data.market.title : ""
            text: page.leaders.data ? page.leaders.data.market.text : ""
        }
        Item { visible: !!page.leaders.data; width: 1; height: 8 }
        LeadersTable { visible: !!page.leaders.data && page.leaders.data.rows.length > 0; width: parent.width; rows: page.controller ? page.controller.leaderRows : null }
        EmptyState { visible: !!page.leaders.data && page.leaders.data.rows.length === 0; compact: true; width: parent.width; text: "这个筛选下没有股票。" }
        Meta { visible: !!page.leaders.data; width: parent.width; items: page.leaders.data ? page.leaders.data.notes.map(function (t) { return { text: t } }) : [] }
    }

    // ---- 极值偏离(#panel-deviation)
    Column {
        id: devSection
        width: parent.width
        // .scan-detail-head:节标题(上 24 下 9)+ 代码;右边状态与上一只 / 下一只(底对齐,下 8)
        Item {
            width: parent.width
            height: 58
            SectionTitle { id: devTitle; text: "极值偏离" }
            Label {
                visible: !!page.dev.symbol
                x: devTitle.x + devTitle.implicitWidth + 4
                y: 24 + (25 - implicitHeight) / 2
                text: page.dev.symbol || ""
                size: 14; weight: Theme.weightSemibold; family: Theme.fontMono; color: Theme.labelSecondary
            }
            Row {
                anchors.right: parent.right
                y: 58 - 8 - 24
                height: 24
                spacing: 6
                // .muted:右边多空 4
                Item {
                    width: statusL.implicitWidth + 4
                    height: parent.height
                    Label {
                        id: statusL
                        anchors.verticalCenter: parent.verticalCenter
                        text: page.dev.status || ""
                        size: 11; color: Theme.labelSecondary; tnum: true
                    }
                }
                StepButton { icon: "ad-left"; tip: "上一只"; onClicked: if (page.controller) page.controller.step(-1) }
                StepButton { icon: "ad-right"; tip: "下一只"; onClicked: if (page.controller) page.controller.step(1) }
            }
        }
        // .row.tight.scan-bar:标的(占满)、手输(92)、周期(100)、均线(92)、z 历史(92)、「复盘」;间距 8、下 10
        Item {
            width: parent.width
            height: 32 + 10
            Select {
                id: devSelect
                width: parent.width - 8 - 92 - 8 - 100 - 8 - 92 - 8 - 92 - 8 - devBtn.width
                options: page.dev.options || []
                value: page.dev.selected ? page.dev.current : undefined
                placeholder: page.dev.placeholder || "标的"
                onActivated: function (v) { if (page.controller) page.controller.review(v) }
            }
            Input {
                id: freeInput
                x: devSelect.width + 8
                width: 92
                maximumLength: 12
                placeholder: "或手输"
                text: page.dev.free || ""
                onEdited: function (t) { if (page.controller) page.controller.setFree(t.slice(0, 12)) }
                onAccepted: if (page.controller) page.controller.reviewCurrent()
            }
            Select {
                x: freeInput.x + 92 + 8
                width: 100
                options: (page.m.timeframes || []).map(function (t) { return { value: t.value, label: t.label } })
                value: page.dev.timeframe
                onActivated: function (v) { if (page.controller) page.controller.setDevTimeframe(v) }
            }
            InputNumber {
                x: freeInput.x + 92 + 8 + 100 + 8
                width: 92
                min: 2; max: 250
                value: page.dev.period === undefined ? null : page.dev.period
                onValueEdited: function (v) { if (page.controller) page.controller.setPeriod(v) }
                Tip { text: "偏离用的均线周期" }
            }
            InputNumber {
                x: freeInput.x + 92 + 8 + 100 + 8 + 92 + 8
                width: 92
                min: 10; max: 500
                value: page.dev.lookback === undefined ? null : page.dev.lookback
                onValueEdited: function (v) { if (page.controller) page.controller.setLookback(v) }
                Tip { text: "折 z 分数用的历史根数" }
            }
            Button {
                id: devBtn
                anchors.right: parent.right
                text: "复盘"
                busy: !!page.dev.busy
                onClicked: if (page.controller) page.controller.reviewCurrent()
            }
        }
        // 上 10 与工具条的下 10 合并
        EmptyState { visible: page.dev.state === "empty"; width: parent.width; topMargin: 0; text: page.dev.empty || "" }
        StatusCard {
            visible: page.dev.state === "short"
            width: parent.width
            tone: "warn"; title: "数据不够"
            Label { width: parent.width; wrap: true; text: page.dev.readout || ""; size: 12; color: Theme.labelSecondary }
        }
        // .cards:竖排、间距 8;六格读数(.stat-grid:每格最窄 150、等分、间距 8,上下 10)、结论、两张图、本段的极值
        Column {
            visible: page.dev.state === "ok"
            width: parent.width
            spacing: 8
            Grid {
                id: tiles
                width: parent.width
                topPadding: 10; bottomPadding: 10
                columnSpacing: 8; rowSpacing: 8
                columns: Math.max(1, Math.min(6, Math.floor((width + 8) / (150 + 8))))
                Repeater {
                    model: page.dev.tiles || []
                    StatTile {
                        required property var modelData
                        width: (tiles.width - (tiles.columns - 1) * 8) / tiles.columns
                        mono: true
                        label: modelData.label; value: modelData.value
                        tone: modelData.tone === "hot" ? "neg" : modelData.tone === "cold" ? "pos" : ""
                    }
                }
            }
            StatusCard {
                width: parent.width
                tone: page.dev.verdict ? page.dev.verdict.tone : "info"
                title: page.dev.verdict ? page.dev.verdict.title : ""
                // 卡片里的列表(.status-card ul 压过 .dev-readout):上 6、左 16、11.5px、行高 1.6,项间 2(上下 2 合并);
                // 字是橙色,info / ok 两种是正文色
                Column {
                    id: readout
                    readonly property color ink: page.dev.verdict && (page.dev.verdict.tone === "info" || page.dev.verdict.tone === "ok") ? Theme.label : Theme.orangeText
                    width: parent.width
                    topPadding: 6; bottomPadding: 2
                    spacing: 2
                    Repeater {
                        model: page.dev.verdict ? page.dev.verdict.readout : []
                        Item {
                            required property var modelData
                            width: parent.width
                            height: li.implicitHeight
                            Label { x: 5; text: "•"; size: 11.5; css: 1.6; color: readout.ink }
                            Label { id: li; x: 16; width: parent.width - 16; wrap: true; text: modelData; size: 11.5; css: 1.6; color: readout.ink }
                        }
                    }
                }
            }
            StatusCard {
                width: parent.width
                title: page.dev.devTitle || ""
                // .chart-wrap.short:上 6、220 高
                Item { width: parent.width; height: 6 + 220; Chart { y: 6; width: parent.width; height: 220; source: page.controller ? page.controller.devChart : null } }
            }
            StatusCard {
                width: parent.width
                title: page.dev.pressureTitle || ""
                // .chart-wrap.short:上 6、220 高
                Item { width: parent.width; height: 6 + 220; Chart { y: 6; width: parent.width; height: 220; source: page.controller ? page.controller.pressureChart : null } }
            }
            Meta { visible: !!page.dev.window; width: parent.width; topPadding: 6; items: page.dev.window ? [{ text: page.dev.window }] : [] }
        }
    }

    // ---- 组件 ------------------------------------------------------------------------------------

    // .hint-list:左 16、11px 二级色、行高 1.6,项上下 2(<b> 是正文色)
    component HintList: Column {
        property var items: []
        width: parent ? parent.width : 0
        Repeater {
            model: parent.items
            Item {
                required property var modelData
                width: parent.width
                height: 2 + li.implicitHeight + 2
                Label { x: 5; y: 2; text: "•"; size: 11; color: Theme.labelSecondary; css: 1.6 }
                Label {
                    id: li
                    x: 16; y: 2; width: parent.width - 16; wrap: true
                    textFormat: Text.StyledText
                    text: modelData.replace(/<b>/g, "<b><font color=\"" + Theme.label + "\">").replace(/<\/b>/g, "</font></b>")
                    size: 11; color: Theme.labelSecondary; css: 1.6
                }
            }
        }
    }

    // .rs-tag-card:卡片面、卡片影、20 圆角、内边距 14 × 16,不画边。头:名(13px 590)与综合(17px 750)两端对齐;
    // 下 10 一排小柱:向上绿、向下红,±30% 封顶;数字(11px 650)和区间名(9.5px 三级色)在柱子下面;再下 5 一行成分股(10px 三级色,一行省略)
    component TagCard: Card {
        id: card
        property var c: ({})
        padding: 0
        border: "transparent"
        height: 14 + 25 + 10 + 84.14 + 5 + 14.7 + 14
        Item {
            x: 16; y: 14
            width: card.width - 32
            height: 25
            Label { id: nameL; y: scoreL.y + scoreL.baselineOffset - baselineOffset; text: card.c.name || ""; size: 13; weight: Theme.weightSemibold }
            Label { id: scoreL; anchors.right: parent.right; text: card.c.score || ""; size: 17; weight: Theme.weightHeavy; family: Theme.fontDisplay }
        }
        Row {
            x: 16; y: 14 + 25 + 10
            width: card.width - 32
            spacing: 6
            Repeater {
                model: card.c.bars || []
                Item {
                    required property var modelData
                    width: (card.width - 32 - 6 * ((card.c.bars || []).length - 1)) / Math.max(1, (card.c.bars || []).length)
                    height: 84.14
                    Tip { text: parent.modelData.title || "" }
                    // 上半(底边 1px 分隔线)向上长,下半向下长;柱宽 60%,最宽 22
                    Rectangle { y: 25; width: parent.width; height: 1; color: Theme.separator }
                    Rectangle {
                        visible: parent.modelData.pos
                        readonly property real bw: Math.min(22, parent.width * 0.6)
                        x: (parent.width - bw) / 2; width: bw
                        height: 25 * parent.modelData.h / 100
                        y: 25 - height
                        topLeftRadius: 4; topRightRadius: 4
                        color: Theme.chartUp
                    }
                    Rectangle {
                        visible: parent.modelData.neg
                        readonly property real bw: Math.min(22, parent.width * 0.6)
                        x: (parent.width - bw) / 2; width: bw
                        y: 26
                        height: 26 * parent.modelData.h / 100
                        bottomLeftRadius: 4; bottomRightRadius: 4
                        color: Theme.chartDown
                    }
                    Label {
                        y: 52 + 1
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: parent.modelData.text; size: 11; weight: Theme.weightBold; tnum: true
                        color: parent.modelData.pos ? Theme.greenText : parent.modelData.neg ? Theme.redText : Theme.labelTertiary
                    }
                    Label {
                        y: 52 + 1 + 16.17 + 1
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: parent.modelData.label; size: 9.5; color: Theme.labelTertiary
                    }
                }
            }
        }
        Label {
            x: 16; y: 14 + 25 + 10 + 84.14 + 5
            width: card.width - 32
            text: card.c.symbols || ""; size: 10; color: Theme.labelTertiary; elide: Text.ElideRight
        }
    }

    // 表的一行:格子 5 × 8;RS 格按幅度染绿 / 红(正按这一列排时不染,AntD 的排序列底色盖住它);打开的那一行除 RS 格外蓝 10%;
    // 悬停整行填充底;dim:没分也没命中的那几行整行三级色
    component ScanRow: Item {
        id: row
        property var r: ({})
        readonly property var cells: r.cells || ({})
        // 行高:有第二行(确认 / 第二个摆动点)的 5 + 18.16 + 14.7 + 5;有信号胶囊的 18.16;只有字的 17.64
        readonly property bool hasSig: table.cols.some(function (c) { return c.key.indexOf("tf:") === 0 })
        readonly property bool hasSecond: table.cols.some(function (c) { return c.key.indexOf("tf:") === 0 && row.cells[c.key] && !!row.cells[c.key].second })
        readonly property real contentH: hasSecond ? 18.16 + 14.7 : hasSig ? 18.16 : 17.64
        height: 5 + contentH + 5 + 1
        HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
        TapHandler { onTapped: if (page.controller) page.controller.drill(row.r.symbol) }
        Repeater {
            model: table.cols
            Item {
                id: cell
                required property var modelData
                required property int index
                readonly property var v: row.cells[modelData.key]
                readonly property bool rs: modelData.key.indexOf("w") === 0 && /^w\d+$/.test(modelData.key) || modelData.key === "score"
                readonly property color textColor: row.r.dim ? Theme.labelTertiary : Theme.label
                x: table.colX(index)
                width: table.widths[index] || 0
                height: row.height - 1
                Rectangle {
                    anchors.fill: parent
                    color: hover.hovered ? Theme.bgFill
                         : cell.rs ? (cell.v && !cell.v.sorted && cell.v.heat !== undefined ? Theme.tint(cell.v.cls === "neg" ? Theme.red : Theme.green, Number(cell.v.heat) / 100) : "transparent")
                         : row.r.open ? Theme.tint(Theme.blue, 0.10) : "transparent"
                }
                Tip { text: cell.v && cell.v.title ? cell.v.title : "" }
                Loader {
                    x: 8
                    width: parent.width - 16
                    anchors.verticalCenter: parent.verticalCenter
                    sourceComponent: cell.modelData.key === "symbol" ? symCell
                                   : cell.modelData.key.indexOf("tf:") === 0 ? sigCell
                                   : cell.modelData.key === "last" && cell.v && cell.v.err ? errCell : textCell
                    property var cellData: cell
                }
            }
        }
        Rectangle { y: parent.height - 1; width: parent.width; height: 1; color: Theme.separator }
        Component {
            id: textCell
            Label {
                readonly property var c: parent ? parent.cellData : null
                horizontalAlignment: c && c.modelData.right ? Text.AlignRight : Text.AlignLeft
                text: !c ? "" : typeof c.v === "string" ? c.v : c.v && c.v.text !== undefined ? c.v.text : ""
                size: 12; tnum: true
                color: !c ? Theme.label : c.modelData.key === "rank" || (c.v && c.v.cls === "dim") ? Theme.labelTertiary : c.textColor
            }
        }
        Component {
            id: symCell
            // 链接按钮(AntD Button type=link):字前有 1 的透明边
            Label {
                x: 1
                text: row.r.symbol || ""
                size: 12; weight: Theme.weightSemibold; family: Theme.fontMono; color: Theme.blue
                Tip { text: "看这只的极值偏离" }
            }
        }
        Component {
            id: errCell
            // 现价那一列靠右
            Item {
                height: errPill.height
                SigPill { id: errPill; x: parent.parent ? parent.parent.width - width : 0; kind: "err"; text: "拿不到" }
            }
        }
        Component {
            id: sigCell
            Column {
                readonly property var s: parent && parent.cellData ? parent.cellData.v || ({}) : ({})
                SigPill { kind: s.kind === "sig" ? s.cls : s.kind || "none"; text: s.text || ""; sub: s.sub || "" }
                Label {
                    visible: !!s.second
                    text: s.second || ""
                    size: 10; css: 14.7
                    color: s.ok ? Theme.label : Theme.labelTertiary
                }
            }
        }
    }

    // .sig:11px 510、内边距 1 × 6、6 圆角;bull / bear 是 16% 的淡染底 + 同色字;none 三级色;err 橙字;.sub 400、80% 不透明、左 3
    component SigPill: Rectangle {
        id: pill
        property string kind: "none"
        property alias text: pillText.text
        property string sub: ""
        readonly property color fg: kind === "bull" ? Theme.greenText : kind === "bear" ? Theme.redText : kind === "err" ? Theme.orangeText : Theme.labelTertiary
        width: pillRow.implicitWidth + 12
        height: 18.16
        radius: 6
        color: kind === "bull" ? Theme.tint(Theme.green, 0.16) : kind === "bear" ? Theme.tint(Theme.red, 0.16) : "transparent"
        Row {
            id: pillRow
            x: 6; y: 1
            spacing: 3
            Label { id: pillText; size: 11; weight: Theme.weightMedium; color: pill.fg; css: 16.17 }
            Label { visible: pill.sub !== ""; text: pill.sub; size: 11; color: pill.fg; opacity: 0.8; css: 16.17 }
        }
    }

    // 上一只 / 下一只:小号方按钮 24 × 24,一枚 AntD 箭头
    component StepButton: Rectangle {
        id: sb
        property string icon: ""
        property string tip: ""
        signal clicked()
        enabled: !!page.dev.hasOrder
        width: 24; height: 24
        radius: Theme.radiusSmall
        color: !enabled ? Theme.bgFill : sbHover.hovered ? Theme.bgFillStrong : Theme.bgControl
        border.width: 1; border.color: Theme.separator
        Icon { anchors.centerIn: parent; name: sb.icon; size: 12; color: sb.enabled ? Theme.label : Theme.labelTertiary }
        Tip { text: sb.tip }
        HoverHandler { id: sbHover }
        TapHandler { enabled: sb.enabled; onTapped: sb.clicked() }
    }

    // 强势股的表(AntD Table,scroll.x = max-content):每列按最宽的那一格(含表头)+ 左右 8 排开,合起来比页面宽就在表里横着滚。
    // 列宽从一份不显示的副本量出来(LeaderCell 不设宽,省略号那一列量的是全长),真正画的那一份按量出来的宽排
    component LeadersTable: Item {
        id: lt
        property var rows: null
        readonly property var titles: [["代码", false], ["趋势模板", false], ["RS 评级", true], ["比基准", true], ["离高点", true], ["VCP", false], ["量比", true], ["结论", false]]
        readonly property var widths: [m0.implicitWidth + 16, m1.implicitWidth + 16, m2.implicitWidth + 16, m3.implicitWidth + 16,
                                       m4.implicitWidth + 16, m5.implicitWidth + 16, m6.implicitWidth + 16, m7.implicitWidth + 16]
        readonly property var offsets: { var out = [0]; for (var k = 0; k < widths.length; ++k) out.push(out[k] + widths[k]); return out }
        readonly property real total: offsets[widths.length]
        function colX(i) { return offsets[i] || 0 }
        height: lflick.height
        Repeater {
            model: 8
            Column {
                required property int index
                visible: false
                // AntD 在表体里还藏着一行量宽用的表头(td 的 12px、th 的粗体),列宽也照它撑
                Label { text: lt.titles[parent.index][0]; size: 12; weight: 700 }
                Repeater { model: lt.rows; LeaderCell { required property var modelData; col: parent.index; d: modelData; measuring: true } }
                Component.onCompleted: [m0, m1, m2, m3, m4, m5, m6, m7][index].source = this
            }
        }
        // 八个量宽的代理:Repeater 里的 Column 交出来给 widths 用
        QtObject { id: m0; property Item source: null; readonly property real implicitWidth: source ? source.implicitWidth : 0 }
        QtObject { id: m1; property Item source: null; readonly property real implicitWidth: source ? source.implicitWidth : 0 }
        QtObject { id: m2; property Item source: null; readonly property real implicitWidth: source ? source.implicitWidth : 0 }
        QtObject { id: m3; property Item source: null; readonly property real implicitWidth: source ? source.implicitWidth : 0 }
        QtObject { id: m4; property Item source: null; readonly property real implicitWidth: source ? source.implicitWidth : 0 }
        QtObject { id: m5; property Item source: null; readonly property real implicitWidth: source ? source.implicitWidth : 0 }
        QtObject { id: m6; property Item source: null; readonly property real implicitWidth: source ? source.implicitWidth : 0 }
        QtObject { id: m7; property Item source: null; readonly property real implicitWidth: source ? source.implicitWidth : 0 }
        Flickable {
            id: lflick
            width: lt.width
            height: lcol.height
            contentWidth: Math.max(lt.width, lt.total)
            contentHeight: lcol.height
            clip: true
            flickableDirection: Flickable.HorizontalFlick
            boundsBehavior: Flickable.StopAtBounds
            interactive: contentWidth > width
            Column {
                id: lcol
                width: lflick.contentWidth
                // 表头:5 + 16.17 + 5,下边 1px
                Item {
                    width: parent.width
                    height: 5 + 16.17 + 5 + 1
                    Repeater {
                        model: lt.titles
                        Label {
                            required property var modelData
                            required property int index
                            x: lt.colX(index) + 8; y: 5
                            width: lt.widths[index] - 16
                            horizontalAlignment: modelData[1] ? Text.AlignRight : Text.AlignLeft
                            text: modelData[0]; size: 11; weight: Theme.weightSemibold; color: Theme.labelSecondary; css: 16.17
                        }
                    }
                    Rectangle { y: parent.height - 1; width: parent.width; height: 1; color: Theme.separator }
                }
                Repeater {
                    model: lt.rows
                    Item {
                        id: lr
                        required property var modelData
                        readonly property var d: modelData
                        // 行高:VCP 成形的两行(胶囊 18.16 + 一行 14.7);拿不到的胶囊 18.16;其余一行字 17.64
                        width: lcol.width
                        height: 5 + (d.vcp.found ? 18.16 + 14.7 : d.error ? 18.16 : 17.64) + 5 + 1
                        HoverHandler { id: lrHover; cursorShape: Qt.PointingHandCursor }
                        TapHandler { onTapped: if (page.controller) page.controller.drill(lr.d.symbol) }
                        Rectangle { anchors.fill: parent; color: lrHover.hovered ? Theme.bgFill : "transparent" }
                        Rectangle { y: parent.height - 1; width: parent.width; height: 1; color: Theme.separator }
                        Repeater {
                            model: 8
                            Item {
                                required property int index
                                x: lt.colX(index) + 8
                                width: lt.widths[index] - 16
                                height: lr.height - 1
                                LeaderCell {
                                    anchors.verticalCenter: parent.verticalCenter
                                    x: lt.titles[parent.index][1] ? parent.width - width : 0
                                    width: parent.index === 7 ? parent.width : implicitWidth
                                    col: parent.index; d: lr.d
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 强势股表的一格:按列画(量宽的副本 measuring 时不设宽、不挂悬停)
    component LeaderCell: Item {
        id: lc
        property int col: 0
        property var d: ({})
        property bool measuring: false
        implicitWidth: loader.item ? loader.item.implicitWidth : 0
        implicitHeight: loader.item ? loader.item.implicitHeight : 0
        height: implicitHeight
        Loader {
            id: loader
            width: lc.col === 7 && !lc.measuring ? lc.width : undefined
            sourceComponent: lc.col === 0 ? symC : lc.col === 1 ? ttC : lc.col === 5 ? vcpC : textC
        }
        Component {
            id: symC
            // 链接按钮:字前后各有 1 的透明边
            Item {
                implicitWidth: symL.implicitWidth + 2
                implicitHeight: symL.implicitHeight
                Label { id: symL; x: 1; text: lc.d.symbol || ""; size: 12; weight: Theme.weightSemibold; family: Theme.fontMono; color: Theme.blue }
                Tip { text: lc.measuring ? "" : lc.d.tip || "" }
            }
        }
        Component {
            id: ttC
            // .tt-dots:8 个 7px 的小点,间距 3;过 = 绿,没过 = 红 55%,判断不了 = 填充底 + 发丝圈;一个空格、左 4 再写过了几条
            Item {
                implicitWidth: lc.d.error ? errP.width : dotsRow.width + spaceW + 4 + countL.implicitWidth
                implicitHeight: lc.d.error ? errP.height : 17.64
                readonly property real spaceW: 3.4
                SigPill { id: errP; visible: !!lc.d.error; kind: "err"; text: "拿不到" }
                Row {
                    id: dotsRow
                    visible: !lc.d.error
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 3
                    Repeater {
                        model: lc.d.dots || []
                        Rectangle {
                            required property var modelData
                            width: 7; height: 7; radius: 3.5
                            color: modelData === "ok" ? Theme.green : modelData === "no" ? Theme.tint(Theme.red, 0.55) : Theme.bgFill
                            border.width: modelData === "na" ? 1 : 0
                            border.color: Theme.separator
                        }
                    }
                }
                // 悬停看每一条用到的数(Tip 铺满它挂的那一项,不能放进 Row)
                Item {
                    visible: dotsRow.visible
                    width: dotsRow.width; height: parent.height
                    Tip { text: lc.measuring ? "" : (lc.d.dotsTip || []).join("\n") }
                }
                Label { id: countL; visible: !lc.d.error; x: dotsRow.width + parent.spaceW + 4; anchors.verticalCenter: parent.verticalCenter; text: lc.d.passed || ""; size: 12; tnum: true; color: Theme.labelSecondary }
            }
        }
        Component {
            id: vcpC
            Item {
                implicitWidth: lc.d.vcp && lc.d.vcp.found ? Math.max(vp.width, vd.implicitWidth) : vt.implicitWidth
                implicitHeight: lc.d.vcp && lc.d.vcp.found ? 18.16 + 14.7 : 17.64
                Tip { text: lc.measuring ? "" : lc.d.vcp ? lc.d.vcp.title || "" : "" }
                Label { id: vt; visible: !(lc.d.vcp && lc.d.vcp.found); anchors.verticalCenter: parent.verticalCenter; text: lc.d.vcp ? lc.d.vcp.text || "" : ""; size: 11; color: Theme.labelSecondary }
                SigPill { id: vp; visible: !!(lc.d.vcp && lc.d.vcp.found); kind: lc.d.vcp && lc.d.vcp.bull ? "bull" : "none"; text: lc.d.vcp ? lc.d.vcp.label || "" : "" }
                Label { id: vd; visible: vp.visible; y: 18.16; text: lc.d.vcp ? lc.d.vcp.detail || "" : ""; size: 10; css: 14.7; color: Theme.labelTertiary }
            }
        }
        Component {
            id: textC
            Label {
                readonly property var v: lc.col === 2 ? lc.d.rating : lc.col === 3 ? lc.d.vs : lc.col === 4 ? lc.d.high : lc.col === 6 ? lc.d.vol : lc.d.verdict
                text: v === undefined ? "" : String(v)
                size: 12; tnum: lc.col !== 7
                elide: lc.col === 7 && !lc.measuring ? Text.ElideRight : Text.ElideNone
                color: lc.col === 3 && lc.d.vsTone === "pos" ? Theme.upText : lc.col === 3 && lc.d.vsTone === "neg" ? Theme.downText : Theme.label
                Tip { text: lc.col === 7 && !lc.measuring ? lc.d.verdict || "" : "" }
            }
        }
    }
}
