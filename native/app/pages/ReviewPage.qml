import QtQuick
import Dafri.Kit

// 交易分析(pages/Review.tsx):蝴蝶复盘(含止盈策略回放)与股票复盘。数字全来自引擎的 review.analyze;这里只负责摆。
// 模型与取数都在 C++(shell/review_controller、shell/review_rules);切走这一页状态清空(选中、周期、EM、类型记在本机),同原版组件卸载
ScrollPage {
    id: page
    property var controller: null
    readonly property var m: controller ? controller.page : ({})
    Component.onCompleted: if (controller) controller.setVisible(true)
    Component.onDestruction: if (controller) controller.setVisible(false)

    PageHead {
        width: parent.width
        title: "交易分析"
        Label { text: page.m.freshness || ""; size: 11; color: Theme.labelSecondary; tnum: true }
    }
    // .row.tight:类型(小号分段)、选哪一笔(占满)、周期(110)、EM(三级色的字 + 72 宽的数字框)、「同步成交」(文字按钮)、「分析」;间距 8、下 10
    Item {
        width: parent.width
        height: 32 + 10
        Segmented {
            id: kindSeg
            y: (32 - height) / 2
            small: true
            options: page.m.kinds || []
            value: page.m.kind
            onActivated: function (v) { if (page.controller) page.controller.setKind(v) }
        }
        Select {
            id: pick
            x: kindSeg.width + 8
            width: parent.width - x - 8 - 110 - 8 - emBox.width - 8 - syncBtn.width - 8 - runBtn.width
            options: page.m.options || []
            value: page.m.selected || undefined
            placeholder: page.m.placeholder || ""
            onActivated: function (v) { if (page.controller) page.controller.select(v) }
        }
        Select {
            id: tfSelect
            x: pick.x + pick.width + 8
            width: 110
            options: page.m.timeframes || []
            value: page.m.timeframe
            onActivated: function (v) { if (page.controller) page.controller.setTimeframe(v) }
        }
        Row {
            id: emBox
            x: tfSelect.x + 110 + 8
            height: 32
            spacing: 8
            Label { anchors.verticalCenter: parent.verticalCenter; text: "EM"; size: 11; color: Theme.labelSecondary }
            InputNumber {
                width: 72
                min: 1; max: 500; step: 0.5
                placeholder: "自动"
                enabled: !page.m.emDisabled
                value: page.m.em === undefined ? null : page.m.em
                onValueEdited: function (v) { if (page.controller) page.controller.setEm(v) }
                // 原版的 title 挂在整个 label 上;Tip 铺满它挂的那一项,不能直接放进 Row
                Tip { text: "常规时段一个标准差的点数(= 开盘时的平值跨式 × 1.25)。空着 = 自动:取开仓那天日内剧本记下的期权定价,那天没记到才用默认的 36 并在结果里写明。只用于蝴蝶的止盈策略回放,股票用不到" }
            }
        }
        Button {
            id: syncBtn
            x: emBox.x + emBox.width + 8
            y: (32 - height) / 2
            small: true; kind: "text"
            text: "同步成交"
            onClicked: if (page.controller) page.controller.sync()
            Tip { text: "向 TWS 重新拉取成交明细并刷新列表,连最近 7 天的一起要。连着 TWS 时应用自己也在同步,一般不用点" }
        }
        Button {
            id: runBtn
            anchors.right: parent.right
            kind: "primary"
            text: "分析"
            busy: !!page.m.loading
            onClicked: if (page.controller) page.controller.analyze()
        }
    }
    Group {
        width: parent.width
        SwitchRow {
            width: parent.width
            label: "附带本地未成交的记录"
            sub: "默认只列 IBKR 真实成交过的蝴蝶;打开后把本地校验过但没成交的也列出来(按限价估算)"
            checked: !!page.m.includeLocal
            onToggled: function (on) { if (page.controller) page.controller.setIncludeLocal(on) }
        }
    }
    Item { width: 1; height: 14 }
    Primer {
        id_: "intro-review"
        width: parent.width
        topPadding: 0
        summary: "数据来源、结论规则与止盈策略"
        Hint {
            topPadding: 0
            textFormat: Text.StyledText
            text: "列表来自 <b>IBKR 的成交明细</b>:引擎从 TWS 拉取逐笔成交,按订单把三条腿合成一张蝴蝶,并存进本地库累积 "
                  + "(TWS 平时只给它自己那个「当天」的成交,按 TWS 登录时选的时区过了午夜就翻篇;应用连着 TWS 时会自己把新成交同步进库,不用开着这一页。 "
                  + "应用没开、电脑睡着时漏掉的,连上之后会自己往回补最近 7 天;7 天之前的补不回来)。<b>股票</b>按\"从空仓到空仓\"的一段持仓算一笔:中途加仓、分批卖出都在这一笔里, "
                  + "成本按移动平均;期初仓位用当前持仓反推,卖的是更早买的货就只复盘出场、不编成本。股票的结论看的是进场 / 出场落在持有期区间的什么位置、 "
                  + "最大浮盈浮亏与兑现了多少、卖出之后又走了多远。<b>蝴蝶</b>选一张后拉取标的在<b>开仓前后到平仓 / 到期</b>的 K 线, "
                  + "画出三条行权价与盈利区,并按规则给出结论:开仓位置、开仓前后走势、持有期间离中心多远、曾经的机会、结局与方向对错。 "
                  + "理论价值按<b>到期内在价值</b>算(是下界,不是当时能卖到的价)。平仓按同一张蝴蝶的反向成交认定,没有就按到期结算。 "
                  + "K 线走 TWS 历史数据,需连接引擎。<b>止盈策略</b>按《SPX 0DTE 蝶式止盈策略 v2.0》回放:蝶价走势取 IBKR 组合分钟中间价, "
                  + "标出 1.35×D / 1.70×D 两档止盈、0.5×D 止损与预计盈利,SPX 图上标出 ±0.45W / ±0.55W / ±0.8W 临界线,并逐分钟回放策略会在哪里出手、与实际结果对比。"
        }
    }
    // #review-result.cards(Primer 的下 12 已经在它自己里):竖排、间距 8
    Column {
        width: parent.width
        spacing: 8
        Working { visible: !!page.m.loading; text: "正在拉取 K 线并复盘…" }
        StatusCard {
            visible: !page.m.loading && !!page.m.error
            width: parent.width
            tone: "bad"; title: "分析失败"
            Label { width: parent.width; wrap: true; text: page.m.error || ""; size: 13 }
        }
        // 卡片列表里的空态(.cards > .empty-state):外边距 10 还在,内容最少 72 高、竖直居中
        Item {
            visible: !!page.m.empty
            width: parent.width
            height: 10 + 72 + 10
            EmptyState { y: 10 + (72 - (implicitHeight - 20)) / 2 - 10; width: parent.width; text: page.m.empty || "" }
        }
        ReviewResult {
            visible: !!page.m.result
            width: parent.width
            r: page.m.result || ({})
            controller: page.controller
        }
    }
}
