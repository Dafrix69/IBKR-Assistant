import QtQuick
import Dafri.Kit

// 绩效体检(pages/Performance.tsx):已了结交易的美元账本 → 冠军交易员天天盯的那几个数 → 行为上的毛病。
// 数字与结论全来自引擎的 review.performance / review.signals;模型与取数在 C++(shell/performance_controller、shell/performance_rules),
// 这里只负责摆。切走这一页状态清空(范围、品种、天数、仓位计算器的权益与比例记在本机),同原版组件卸载
ScrollPage {
    id: page
    property var controller: null
    readonly property var m: controller ? controller.page : ({})
    readonly property bool hasData: !!m.hasData
    Component.onCompleted: if (controller) controller.setVisible(true)
    Component.onDestruction: if (controller) controller.setVisible(false)
    function openShare() { shareCard.openCard() }

    // 页头右边(.head-actions:间距 8):范围(小号分段)、品种(小号下拉 120)、天数(110)、重新计算、分享卡片
    PageHead {
        width: parent.width
        title: "绩效体检"
        Row {
            spacing: 8
            Segmented {
                anchors.verticalCenter: parent.verticalCenter
                small: true
                options: page.m.scopes || []
                value: page.m.scope
                onActivated: function (v) { if (page.controller) page.controller.setScope(v) }
            }
            Select {
                anchors.verticalCenter: parent.verticalCenter
                small: true; width: 120
                options: page.m.kinds || []
                value: page.m.kind
                onActivated: function (v) { if (page.controller) page.controller.setKind(v) }
            }
            Select {
                anchors.verticalCenter: parent.verticalCenter
                small: true; width: 110
                options: page.m.dayOptions || []
                value: page.m.days
                onActivated: function (v) { if (page.controller) page.controller.setDays(v) }
            }
            Button {
                anchors.verticalCenter: parent.verticalCenter
                small: true; text: "重新计算"
                busy: !!page.m.loading
                onClicked: if (page.controller) page.controller.reload()
            }
            Button {
                visible: !!page.m.share
                anchors.verticalCenter: parent.verticalCenter
                small: true; text: "分享卡片"
                onClicked: shareCard.openCard()
            }
        }
    }
    Primer {
        id_: "performance"
        width: parent.width
        topPadding: 0
        summary: "冠军们天天盯的几个数:胜率 × 盈亏比 = 期望值,再看回撤与行为。"
        Hint {
            topPadding: 0
            text: "账本是交易分析页的同一批真实成交(蝴蝶、股票持仓段)加上导入的 Flex 期权仓位,只算已经了结的。数字与结论都由本机代码算,不调模型、不外发。"
        }
        Hint {
            text: "规则借鉴自实盘比赛的优胜者与他们的教练:Van Tharp 的期望值与 R 倍数,Mark Minervini(美国投资锦标赛 1997、2021 冠军)的\"小亏就走\"与渐进式仓位, "
                  + "Andrea Unger(四届 World Cup 期货冠军)的时段过滤,Kevin Davey 的\"样本够多才谈优势\",以及期货实盘大赛把回撤算进排名的做法。 "
                  + "它们只描述已经发生的事与一条可以对照的规矩,不是买卖建议。"
        }
        Hint {
            text: "几十笔交易算出来的数本身就在晃:期望值、胜率旁边给 95% 区间,区间跨着 0 的数不上色;拿两组来比的结论(亏完马上再进、时段、亏后加码……)要差别出了噪声才说。 "
                  + "R 只代表设了初始风险的那一部分交易,盖住几笔、没盖住的为什么,写在核心数字下面。"
        }
    }

    Alert { visible: !!page.m.error; width: parent.width; tone: "error"; title: "算不出来"; text: page.m.error || "" }
    Working { visible: !!page.m.working; text: "正在翻账本…" }
    EmptyState { visible: !!page.m.empty; width: parent.width; text: page.m.empty || "" }
    Alert { visible: !!page.m.mix; width: parent.width; tone: "warn"; title: "实盘和模拟盘混在一起算"; text: page.m.mix || "" }

    SectionTitle { visible: page.hasData; text: "体检结论"; count: (page.m.findings || []).length }
    PerformanceParts.Findings { visible: page.hasData && (page.m.findings || []).length > 0; width: parent.width; findings: page.m.findings || [] }
    SectionTitle { visible: page.hasData && (page.m.advice || []).length > 0; text: "保护规则建议"; count: (page.m.advice || []).length }
    PerformanceParts.Advice { visible: page.hasData && (page.m.advice || []).length > 0; width: parent.width; advice: page.m.advice || []; controller: page.controller }
    SectionTitle { visible: page.hasData; text: "核心数字" }
    PerformanceParts.Stats { visible: page.hasData; width: parent.width; s: page.m.stats || ({}) }
    PerformanceParts.Equity { visible: page.hasData && !!page.m.equity; width: parent.width; meta: page.m.equity ? page.m.equity.meta : ""; controller: page.controller }
    PerformanceParts.Groups { visible: page.hasData; width: parent.width; g: page.m.groups || ({}) }
    PerformanceParts.Execution { visible: page.hasData && !!page.m.execution; width: parent.width; e: page.m.execution || ({}); controller: page.controller }
    SectionTitle { visible: page.hasData; text: "下一笔做多大" }
    PerformanceParts.Sizer { visible: page.hasData; width: parent.width; sz: page.m.sizer || ({}); controller: page.controller }
    SectionTitle { visible: page.hasData; text: "明细" }
    PerformanceParts.Ledger { visible: page.hasData && !!page.m.ledger; width: parent.width; l: page.m.ledger || ({}); controller: page.controller }

    SectionTitle { text: "信号成绩单" }
    PerformanceParts.Signals { width: parent.width; s: page.m.signals || ({}); controller: page.controller }

    ShareCard { id: shareCard; controller: page.controller }
}
