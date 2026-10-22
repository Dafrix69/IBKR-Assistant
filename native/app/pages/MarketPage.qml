import QtQuick
import Dafri.Kit

// 行情(pages/Market.tsx):一页看一个标的——上面 K 线读盘(lib/PaPanel.tsx),图下面就是它的盘口;下半是「关注的盘口」(lib/BookWall.tsx),
// 点卡片上的代码就把它换成上面正在看的那个。模型与取数都在 C++(shell/market_controller);切走这一页状态清空,同原版组件卸载
ScrollPage {
    id: page
    property var controller: null
    readonly property var m: controller ? controller.page : ({})
    readonly property var books: m.books || ({})
    Component.onCompleted: if (controller) controller.setVisible(true)
    Component.onDestruction: if (controller) controller.setVisible(false)
    Connections {
        target: page.controller
        ignoreUnknownSignals: true
        // 盘口墙上点了代码 / 跳过来的:滚回顶上看图(滚内容区,不是 scrollIntoView——页头是吸顶的)
        function onScrollTop() { page.contentY = 0 }
    }

    PageHead { width: parent.width; title: "行情" }

    // ---- K 线读盘(#panel-pa)
    // .sub-head:新鲜度一行靠右,11px 二级色,18 高;上 -4(伸进页头的下边)、下 8
    Item {
        width: parent.width
        height: 18 + 8 - 4
        Label {
            anchors.right: parent.right
            y: -4 + (18 - implicitHeight) / 2
            text: page.m.freshness || ""
            size: 11; color: Theme.labelSecondary
        }
    }
    // .row.tight:标的(占满)、周期(110)、「分析」;间距 8、下 10
    Item {
        width: parent.width
        height: 32 + 10
        Input {
            id: symbolInput
            width: parent.width - 8 - 110 - 8 - runBtn.width
            placeholder: "标的,如 NVDA、SPY、SPX"
            text: page.m.symbol || ""
            onEdited: function (t) { if (page.controller) page.controller.setSymbolText(t.slice(0, 12)) }
            onAccepted: if (page.controller) page.controller.analyze()
        }
        Select {
            x: symbolInput.width + 8
            width: 110
            options: (page.m.timeframes || []).map(function (t) { return { value: t.key, label: t.label } })
            value: page.m.tfLabel ? page.m.timeframe : undefined
            onActivated: function (v) { if (page.controller) page.controller.setTimeframe(v) }
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
            label: "只看正常交易时段"
            sub: "默认含盘前盘后,个股与 ETF 还接上夜盘(美东 20:00–04:00),指数的盘外按期货推算;打开只取 09:30–16:00"
            checked: !!page.m.rth
            onToggled: function (on) { if (page.controller) page.controller.setRth(on) }
        }
    }
    Item { width: 1; height: 14 }
    Primer {
        id_: "intro-pa"
        width: parent.width
        topPadding: 0
        summary: "数据来源与判断方式"
        Hint {
            topPadding: 0
            text: "K 线走 TWS 历史数据接口,需行情权限;个股与 ETF 的夜盘(IBKR 的隔夜交易时段,美东 20:00–04:00)是向券商另要一次接在盘后后面;指数(SPX)只在常规时段计算,盘外那几段按期货(ES)减基差推算、和蝴蝶测算里标「期货推算」的现价同一个口径(顶栏行情带那一格夜里停在昨收),图上用灰色竖带标出,不是指数本身;仅延迟权限也能出图,数据晚 15–20 分钟,判定会退到数据确定到齐的那一根; 新鲜度见标题右侧,行情停了超 30 分钟会告警。方向判断<b>全部由规则计算、只用已收盘的 K 线</b>(正在形成的那一根只作提示), 权重公开在「判断依据」里; 「AI 解读」只叙述这些事实,不看图。图下面是同一标的的盘口,只读展示、不参与定价与下单, 无 Level 2 订阅时只有一档;指数没有盘口,看对应 ETF。已连网关时 K 线与盘口每 20 秒自动刷新。<b>仅供研究参考,不接下单链路。</b>"
        }
    }
    // #pa-result
    EmptyState {
        readonly property var r: page.m.result || ({})
        visible: r.state === "error" || r.state === "empty"
        width: parent.width
        text: r.text || ""
    }
    Working {
        visible: !!page.m.result && page.m.result.state === "loading"
        text: page.m.result ? page.m.result.text : ""
    }
    PaCards {
        visible: !!page.m.pa
        width: parent.width
        pa: page.m.pa || ({})
        controller: page.controller
    }
    // 下 12 与下面分节标题的上 24 合并(CSS 外边距合并):这里不留
    Primer {
        id_: "pa-legend-primer"
        intro: false
        width: parent.width
        topPadding: 16
        bottomPadding: 0
        summary: "图上画的是什么"
        Column {
            width: parent.width
            Repeater {
                model: [
                    "蜡烛按涨跌着色(可在「设置 → 涨跌配色」切换红涨绿跌);量能柱同色,按 95 分位归一化,开盘第一根巨量不会把其余压成一条线。",
                    "MA5 / MA10 / MA20 是引擎算的收盘价简单均线,只作图,不进打分;左上角显示最后一根(或光标所在那根)的均线值。",
                    "虚线是关键位:支撑用涨色、阻力用跌色;价格标签放在右侧价格轴上,挤在一起时会被推开并画引线回到真实价位。",
                    "半透明色块是未回补的 FVG(缺口),灰色虚线框是订单块;它们从产生那根 K 线画到最后一根,不铺到轴上。",
                    "点 + 小字是最近的摆动点(HH / HL / LH / LL);蓝色点线是现价。鼠标悬停显示十字光标与那一根的开高低收量。",
                    "最后一根还没走完时,它上面有一条标着「形成中」的竖线(延迟行情下数据还没到齐的标「未到齐」):这一根照常画,但不进任何判定。",
                    "滚轮缩放、按住拖动平移,拖价格轴或时间轴也能缩放;双击轴复位。每 20 秒的自动刷新不会把缩放到的位置刷掉。"
                ]
                // .hint-list:左 16、11px 二级色、行高 1.6,项上下 2
                Item {
                    required property var modelData
                    width: parent.width
                    height: 2 + li.implicitHeight + 2
                    Label { x: 5; y: 2; text: "•"; size: 11; color: Theme.labelSecondary; css: 1.6 }
                    Label { id: li; x: 16; y: 2; width: parent.width - 16; wrap: true; text: modelData; size: 11; color: Theme.labelSecondary; css: 1.6 }
                }
            }
        }
    }

    // ---- 关注的盘口(#panel-book)
    SectionTitle { text: "关注的盘口"; count: page.books.count || 0 }
    Item {
        width: parent.width
        height: 32 + 10
        Input {
            id: bookInput
            width: parent.width - 8 - addBtn.width - 8 - allBtn.width
            placeholder: "再盯一个盘口,如 SPY、NVDA(指数请用对应 ETF)"
            onAccepted: if (page.controller && page.controller.addBook(text)) text = ""
        }
        Button {
            id: addBtn
            x: bookInput.width + 8
            text: "添加"
            onClicked: if (page.controller && page.controller.addBook(bookInput.text)) bookInput.text = ""
        }
        Button {
            id: allBtn
            anchors.right: parent.right
            kind: "text"
            text: "全部刷新"
            enabled: !page.books.refreshAllDisabled
            onClicked: if (page.controller) page.controller.refreshAllBooks()
        }
    }
    // .sector-grid:每张最窄 440、等分,间距 12,按行顶对齐
    EmptyState {
        visible: (page.books.cards || []).length === 0
        width: parent.width
        text: "还没有关注的盘口。上面加一个,或在正在看的那张盘口上点「加入关注」。"
    }
    Grid {
        id: wall
        visible: (page.books.cards || []).length > 0
        width: parent.width
        columns: Math.max(1, Math.floor((width + 12) / (440 + 12)))
        columnSpacing: 12; rowSpacing: 12
        Repeater {
            model: page.books.cards || []
            BookCard { required property var modelData; width: (wall.width - (wall.columns - 1) * 12) / wall.columns; card: modelData }
        }
    }
    // 还没关注任何标的时,读盘常识正是这一刻要看的东西;加了标的它就该让路
    Primer {
        id_: "book-primer"
        intro: false
        width: parent.width
        topPadding: 16
        defaultOpen: (page.books.cards || []).length === 0
        summary: "读盘常识"
        Column {
            width: parent.width
            spacing: 8
            StatusCard {
                width: parent.width
                title: "订单簿是什么"
                Label { width: parent.width; wrap: true; textFormat: Text.StyledText; size: 13
                    text: "未成交限价单按价格聚合:买单从高到低,卖单从低到高。买一与卖一之差是<b>价差</b>,各价位挂单量是<b>深度</b>。一档(L1)只看买一/卖一;Level 2 看多档,需单独订阅。" }
            }
            StatusCard {
                width: parent.width
                title: "怎么读"
                Label { width: parent.width; wrap: true; size: 13
                    text: "价差窄、深度厚 = 流动性好、滑点小;价差宽、深度薄时大单会吃穿多档。某价位的异常大单可能是支撑/压力,也可能是随时撤掉的诱导单:挂单不等于成交。盘前盘后深度明显变薄。" }
            }
            StatusCard {
                width: parent.width
                tone: "warn"
                title: "对本系统的意义"
                Label { width: parent.width; wrap: true; size: 13
                    text: "AUTO_MID 按盘口中间价 ±滑点上限定价:价差 10 美分的票,上限 0.10 合理;价差 2 美元的期权组合则可能永远不成交。下条件单前先看价差,再定净权利金上限或滑点。期权盘口普遍比正股宽一个数量级。" }
            }
        }
    }

    // 盘口墙上的一张(BookCard:AntD 小号 Card + .sector-card):1px 边、头上 8(.sector-card 改的)、左右 16;
    // 代码是一颗按钮(等宽 590 13px,悬停变蓝,点了换成上面正在看的);右边「刷新」「移除」两颗小按钮(左右 6、高 22),间距 4。
    // 头 30 高(下边 -1 压在身上),身上 6 下 16
    component BookCard: Card {
        id: bc
        property var card: ({})
        padding: 0
        implicitHeight: 30 + 6 + body.implicitHeight + 16 + 1
        Label {
            id: sym
            x: 17; y: 9 + (22 - implicitHeight) / 2
            text: bc.card.symbol || ""
            size: 13; weight: Theme.weightSemibold; family: Theme.fontMono; tnum: true
            color: symHover.hovered ? Theme.blue : Theme.label
            HoverHandler { id: symHover; cursorShape: Qt.PointingHandCursor }
            TapHandler { onTapped: if (page.controller) page.controller.pick(bc.card.symbol) }
            Tip { text: "看它的 K 线" }
        }
        Row {
            anchors.right: parent.right; anchors.rightMargin: 17
            y: 9
            spacing: 4
            Button { small: true; padding: 6; implicitHeight: 22; text: bc.card.loading ? "读取中…" : "刷新"; busy: !!bc.card.loading; onClicked: if (page.controller) page.controller.loadBook(bc.card.symbol) }
            Button { small: true; padding: 6; implicitHeight: 22; kind: "text"; text: "移除"; onClicked: if (page.controller) page.controller.removeBook(bc.card.symbol) }
        }
        BookBody {
            id: body
            x: 17; y: 30 + 6
            width: bc.width - 34
            body: bc.card.body || ({})
        }
    }
}
