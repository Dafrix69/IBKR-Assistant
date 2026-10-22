import QtQuick
import Dafri.Kit

// 情报(pages/Intel.tsx):Discord 里的消息、价位与异动的信号、宏观与自定义事件、自己下过的单、记下的想法,按时间排成一条线,
// 每一条都认出了它在说哪几只标的——点标的打开它的档案(全站共用的抽屉,挂在壳上)。只读,不发单。
// 状态在 IntelStore(时间线 60 秒一拉,种类与只看持仓由引擎筛);页面自己的只有关键字(切走清掉)。模型:shell/intel_controller + intel_page_rules
ScrollPage {
    id: page
    property var controller: null
    readonly property var m: controller ? controller.page : ({})
    signal write(string text)
    Component.onCompleted: if (controller) controller.setVisible(true)
    Component.onDestruction: if (controller) controller.setVisible(false)

    PageHead {
        width: parent.width
        title: "情报"
        Row {
            spacing: 8
            Button { text: "查标的 " + (page.m.modKey || "⌘") + "K"; onClicked: if (page.controller) page.controller.setLookupOpen(true) }
            Button { text: "刷新"; busy: !!page.m.loading; onClicked: if (page.controller) page.controller.reload() }
        }
    }
    Primer {
        id_: "intel"
        width: parent.width
        topPadding: 0
        summary: "消息、信号、事件、单子、想法按标的串成一条线;点标的看它的档案"
        Hint {
            topPadding: 0
            text: "Discord 频道里的每一条消息(bot 读的与本地收件读的)都会认出它提到了哪几只标的:写了 $ 的、在持仓 / 股票池 / 板块 / 提醒里的、 "
                  + "中文名与常用叫法(英伟达、标普);没写标的的期权行话(「7700 7725 bear call」)算作 SPX。像代码但不在名单里的词标一个问号,只作参考。"
            textFormat: Text.PlainText
        }
        Hint {
            text: "消息上记着提到那一刻的价,旁边是此刻的价:事后看得出\"他说的时候在哪、现在走到哪了\"。只取已经在订着的行情(指数、持仓、股票池), "
                  + "随口提到的票不另占行情线路。信任的人提到自己持仓的票时会弹窗提醒。像单子的消息可以「写进指令框」,发不发还是你自己的事。"
            textFormat: Text.PlainText
        }
    }
    Repeater {
        model: page.m.notices || []
        Alert { required property var modelData; width: parent ? parent.width : 0; tone: modelData.tone; title: modelData.title; text: modelData.text }
    }
    // .intel-bar:种类(小号分段)、只看持仓(小号开关 + 12px 二级色,间距 6)、关键字(小号、200 宽、可清空)、条数(靠右、11px 三级色),间距 12;上 10(与 Primer 的下 12 合并)、下 8
    Item {
        width: parent.width
        height: 26 + 8
        Row {
            spacing: 12
            height: 26
            Segmented {
                anchors.verticalCenter: parent.verticalCenter
                small: true
                options: page.m.kinds || []
                value: page.m.kind
                onActivated: function (v) { if (page.controller) page.controller.setKind(v) }
            }
            Row {
                anchors.verticalCenter: parent.verticalCenter
                spacing: 6
                Switch { small: true; anchors.verticalCenter: parent.verticalCenter; checked: !!page.m.heldOnly; onToggled: if (page.controller) page.controller.setHeldOnly(!page.m.heldOnly) }
                Label { anchors.verticalCenter: parent.verticalCenter; text: "只看持仓相关"; size: 12; color: Theme.labelSecondary }
            }
            Input {
                anchors.verticalCenter: parent.verticalCenter
                small: true; clearable: true; width: 200
                placeholder: "筛:代码或原文里的字"
                text: page.m.query || ""
                onEdited: function (t) { if (page.controller) page.controller.setQuery(t) }
            }
        }
        Label { anchors.right: parent.right; y: (26 - height) / 2; text: page.m.count || ""; size: 11; color: Theme.labelTertiary; tnum: true }
    }
    // .intel-hot:「常被提到」(11px 二级色)+ 胶囊(.chip-tag:26 高、左右 10、12px、控件圆角、填充底;持仓的蓝 14%;数 650 二级色、左 2),间距 6;下 12
    Item {
        visible: (page.m.hot || []).length > 0
        width: parent.width
        height: visible ? 26 + 12 : 0
        Row {
            spacing: 6
            Label { anchors.verticalCenter: parent.verticalCenter; text: "常被提到"; size: 11; color: Theme.labelSecondary }
            Repeater {
                model: page.m.hot || []
                Rectangle {
                    id: hot
                    required property var modelData
                    width: hotRow.implicitWidth + 22; height: 26
                    radius: Theme.radiusControl
                    color: modelData.held ? Theme.tint(Theme.blue, 0.14) : hotHover.hovered ? Theme.bgFillStrong : Theme.bgFill
                    Row {
                        id: hotRow
                        anchors.centerIn: parent
                        spacing: 2
                        Label { text: hot.modelData.symbol + " "; size: 12; css: 1.5 }
                        Label { text: String(hot.modelData.n); size: 12; weight: 650; color: Theme.labelSecondary; css: 1.5 }
                    }
                    HoverHandler { id: hotHover; cursorShape: Qt.PointingHandCursor }
                    TapHandler { onTapped: if (page.controller) page.controller.openDossier(hot.modelData.symbol) }
                    Loader { anchors.fill: parent; active: !!hot.modelData.held; sourceComponent: Tip { text: "持仓中" } }
                }
            }
        }
    }
    // 读着:五行骨架(LoadingBlock rows=5:上 6 下 14,每行 16 高、行距 16)
    Column {
        visible: page.m.timeline === null
        width: parent.width
        topPadding: 6; bottomPadding: 14
        spacing: 16
        Repeater {
            model: [0.62, 0.48, 0.54, 0.40, 0.58]
            Rectangle { required property real modelData; width: parent.width * modelData; height: 16; radius: 4; color: Theme.bgFill }
        }
    }
    IntelTimeline {
        visible: !!page.m.timeline
        width: parent.width
        tl: page.m.timeline || ({})
        onOpenSymbol: function (s) { if (page.controller) page.controller.openDossier(s) }
        onWrite: function (t) { page.write(t) }
    }
}
