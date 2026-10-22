import QtQuick
import Dafri.Kit

// 想法(pages/Ideas.tsx):随手记,不解析、不下单。上面记一条;下面筛选 + 检索 + 总结知识;最新一次总结;每条想法一张卡片
// (AI 分析的结果嵌在卡片里,行情事实与 AI 叙事分开标注)。模型与取数都在 C++(shell/ideas_controller);切走这一页状态清空,同原版组件卸载
ScrollPage {
    id: page
    property var controller: null
    readonly property var m: controller ? controller.page : ({})
    Component.onCompleted: if (controller) controller.setVisible(true)
    Component.onDestruction: if (controller) controller.setVisible(false)
    Connections {
        target: page.controller
        ignoreUnknownSignals: true
        function onAdded() { ideaInput.text = "" }
        // 发到解析:原文已经放进交易指令页的输入框,这里切过去
        function onNavigateRequested(key) { Nav.navigate(key) }
    }

    PageHead {
        width: parent.width
        title: "想法"
        Label { text: "随手记,不解析、不下单"; size: 11; color: Theme.labelSecondary }
    }
    // .row.tight:输入(占满)+「记下」,间距 8、下 10
    Item {
        width: parent.width
        height: 32 + 10
        Input {
            id: ideaInput
            width: parent.width - 8 - addBtn.width
            placeholder: "例:AXTI 周五尾盘买入"
            onEdited: function (t) { if (t.length > 2000) text = t.slice(0, 2000) }
            onAccepted: if (page.controller) page.controller.add(text)
        }
        Button { id: addBtn; anchors.right: parent.right; kind: "primary"; text: "记下"; onClicked: if (page.controller) page.controller.add(ideaInput.text) }
    }
    Primer {
        id_: "intro-ideas"
        width: parent.width
        topPadding: 0
        summary: "「AI 分析」和「发到解析」是什么"
        Hint {
            topPadding: 0
            text: "「AI 分析」用配置的大模型解读逻辑、待核实点与风险,<b>仅供参考,不会下单</b>; 「发到解析」把文本带到「交易指令」页。"
        }
    }
    // .row.tight:筛选(小号 26)、检索(小号 24,占满)、附带交易结果、总结;间距 8、下 10、竖直居中
    Item {
        width: parent.width
        height: 26 + 10
        Segmented {
            id: filterSeg
            small: true
            options: [{ value: "active", label: "进行中" }, { value: "all", label: "全部" }]
            value: page.m.filter || "active"
            onActivated: function (v) { if (page.controller) page.controller.setFilter(v) }
        }
        SearchInput {
            id: searchBox
            small: true
            x: filterSeg.width + 8
            y: (26 - height) / 2
            // 复选框(AntD:字的右边还有 8 的内边距)和总结按钮靠右,检索框占剩下的
            width: parent.width - x - 8 - (withTrades.width + 8) - 8 - digestBtn.width
            placeholder: "检索想法:蝴蝶 结算 / RKLB(回车)"
            onSearched: function (t) { if (page.controller) page.controller.search(t) }
        }
        Checkbox {
            id: withTrades
            x: searchBox.x + searchBox.width + 8
            y: (26 - height) / 2
            text: "附带交易结果"
            checked: page.m.withTrades !== false
            onToggled: function (on) { if (page.controller) page.controller.setWithTrades(on) }
        }
        Button {
            id: digestBtn
            anchors.right: parent.right
            y: (26 - height) / 2
            small: true
            text: page.m.digestButton || "总结知识"
            busy: !!page.m.digesting
            onClicked: if (page.controller) page.controller.digest()
        }
    }

    // 最新一次知识总结(.digest-card:下 8)
    StatusCard {
        visible: !!page.m.digest
        width: parent.width
        title: page.m.digest ? page.m.digest.title : ""
        Sections { id: digestSecs; sections: page.m.digest ? page.m.digest.sections : [] }
        // 列表的下 6 与元数据行的上 6 合并(CSS 外边距合并)
        Meta { width: parent.width; topPadding: digestSecs.sections.length ? 0 : 6; items: page.m.digest ? page.m.digest.meta : [] }
    }
    Item { visible: !!page.m.digest; width: 1; height: 8 }

    Column {
        width: parent.width
        spacing: 8
        EmptyState { visible: !!page.m.empty; width: parent.width; text: page.m.empty || "" }
        Repeater {
            model: page.m.cards || []
            IdeaCard { required property var modelData; width: parent.width; c: modelData }
        }
    }

    // BulletList:一行 13px 的标题,下面一个列表(.idea-card / .digest-card 的 ul:上 2 下 6、左 16、12px 正文色)
    component Sections: Column {
        id: secs
        property var sections: []
        width: parent ? parent.width : 0
        Repeater {
            model: secs.sections
            Column {
                required property var modelData
                width: secs.width
                Label { width: parent.width; wrap: true; text: modelData.title; size: 13 }
                Column {
                    width: parent.width
                    topPadding: 2; bottomPadding: 6
                    Repeater {
                        model: modelData.items
                        Item {
                            required property var modelData
                            width: secs.width
                            height: li.implicitHeight
                            Label { x: 5; text: "•"; size: 12 }
                            Label { id: li; x: 16; width: secs.width - 16; wrap: true; text: modelData; size: 12 }
                        }
                    }
                }
            }
        }
    }

    // 一条想法(IdeaCard:AntD 小号 Card + .idea-card):标题是代码(等宽 12px 590),右边状态词(.status 11px 510,进行中橙、已完成绿、其余红);
    // 正文 13px、元数据、AI 分析(.result 上 8,嵌一张状态卡片)、按钮(.card-actions 上 8,间距 6)
    component IdeaCard: StatusCard {
        id: card
        property var c: ({})
        title: c.title || ""
        titleFamily: Theme.fontMono; titleSize: 12; titleWeight: Theme.weightSemibold
        extra: Label {
            text: card.c.status || ""
            size: 11; weight: Theme.weightMedium
            color: card.c.statusTint === "pending" ? Theme.orangeText : card.c.statusTint === "filled" ? Theme.greenText : Theme.redText
        }
        Label { width: parent.width; wrap: true; text: card.c.text || ""; size: 13 }
        Meta { width: parent.width; items: card.c.meta || [] }
        Item {
            visible: !!card.c.analysis
            width: parent.width
            height: visible ? 8 + analysis.height : 0
            Analysis { id: analysis; y: 8; width: parent.width; a: card.c.analysis || ({}) }
        }
        Row {
            topPadding: 8
            spacing: 6
            Button { visible: !!card.c.active; small: true; kind: "primary"; text: card.c.analyzeLabel || "AI 分析"; busy: !!card.c.analyzing; onClicked: if (page.controller) page.controller.analyze(card.c.id) }
            Button { visible: !!card.c.active; small: true; text: "发到解析"; onClicked: if (page.controller) page.controller.sendToTrade(card.c.id) }
            Button { visible: !!card.c.active; small: true; kind: "text"; text: "完成"; onClicked: if (page.controller) page.controller.setStatus(card.c.id, "done") }
            Button { visible: !!card.c.active; small: true; kind: "text"; text: "归档"; onClicked: if (page.controller) page.controller.setStatus(card.c.id, "archived") }
            Button { visible: !card.c.active; small: true; kind: "text"; text: "恢复为进行中"; onClicked: if (page.controller) page.controller.setStatus(card.c.id, "active") }
        }
    }

    // AI 分析那张(状态卡片):行情事实(.stock-sub 二级色、一行省略;打头的那一行 13px——.idea-card 的「身里第一个 div 13px」也落在它头上——其余 11px)、
    // 逻辑(13px)、待核实与风险两段列表、建议(.reason)、元数据
    component Analysis: StatusCard {
        id: an
        property var a: ({})
        title: a.title || ""
        Repeater {
            model: an.a.facts || []
            Label {
                required property var modelData
                required property int index
                width: parent.width
                elide: Text.ElideRight
                text: modelData
                size: index === 0 ? 13 : 11
                color: Theme.labelSecondary
            }
        }
        Label { visible: !!an.a.thesis; width: parent.width; wrap: true; text: an.a.thesis || ""; size: 13 }
        Sections { id: anSecs; sections: an.a.sections || [] }
        // 列表的下 6 与后面的上边距合并:建议(.reason 上 4)、元数据(上 6)都并进那 6 里
        Label { visible: !!an.a.suggestion; width: parent.width; wrap: true; topPadding: anSecs.sections.length ? 0 : 4; text: an.a.suggestion || ""; size: 11.5; color: Theme.labelSecondary }
        Meta { width: parent.width; topPadding: anSecs.sections.length && !an.a.suggestion ? 0 : 6; items: an.a.meta || [] }
    }
}
