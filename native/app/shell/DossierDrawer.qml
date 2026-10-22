import QtQuick
import Dafri.Kit

// 一只标的的档案(lib/SymbolDossier.tsx,全站共用的抽屉,560 宽):头上「刷新」「K 线」「写指令」;
// 此刻的价(.hero-num 26px 750 显示字体、涨跌色)、涨跌(13px 600)、价从哪来(11px 三级色),间距 10;标签胶囊(间距 6),头与胶囊间 8、头下 6;
// 各段(持仓、追踪、在途单、接下来的事、价位、最近异动、想法):分节标题 + 列表(每项 12px、5 × 10、10 圆角、填充底,名在左、值在右二级色,间距 4、下 6),
// 价位是胶囊(阻力跌色、支撑涨色);.dossier 段间 10;最后是时间线(同情报页)。只读;「写指令」只往指令框里写一个开头。
// 模型:IntelController.dossier(shell/intel_page_rules 的 dossierModel)
Drawer {
    id: root
    property var controller: null
    readonly property var d: controller ? controller.dossier : ({})
    readonly property bool shown: !!d.symbol
    signal market(string symbol)
    signal write(string text)
    signal writeTimeline(string text)
    panelWidth: 560
    title: d.symbol || ""
    titleSize: 20; titleWeight: 700; titleFamily: Theme.fontDisplay
    subtitle: "档案"
    onShownChanged: if (shown) open(); else if (visible) visible = false
    onClosed: if (controller && shown) controller.closeDossier()
    extra: Row {
        spacing: 6
        Button { small: true; text: "刷新"; busy: !!root.d.loading; onClicked: if (root.controller) root.controller.refreshDossier() }
        Button { small: true; text: "K 线"; onClicked: { const s = root.d.symbol; root.controller.closeDossier(); root.market(s) } }
        Button { small: true; kind: "primary"; text: "写指令"; onClicked: { const s = root.d.symbol; root.controller.closeDossier(); root.write(s + " ") } }
    }

    Column {
        width: parent.width
        Alert { visible: !!root.d.error; width: parent.width; tone: "warn"; title: "没读到档案"; text: root.d.error || "" }
        // 读着:骨架(LoadingBlock rows=4)
        Column {
            visible: !root.d.ready
            width: parent.width
            topPadding: 6; bottomPadding: 14
            spacing: 16
            Repeater {
                model: [0.62, 0.48, 0.54, 0.40]
                Rectangle { required property real modelData; width: parent.width * modelData; height: 16; radius: 4; color: Theme.bgFill }
            }
        }
        Column {
            visible: !!root.d.ready
            width: parent.width
            spacing: 10
            // .dossier-head:价那一行、胶囊(折行),间距 8,下 6
            Column {
                width: parent.width
                spacing: 8
                bottomPadding: 6
                Item {
                    width: parent.width
                    height: 28.6
                    Label {
                        id: price
                        text: root.d.head ? root.d.head.price : ""
                        size: 26; weight: 750; family: Theme.fontDisplay; letterSpacing: -0.52; css: 1.1; tnum: true
                        color: root.d.head && root.d.head.dir === "up" ? Theme.upText : root.d.head && root.d.head.dir === "down" ? Theme.downText : Theme.label
                    }
                    Label {
                        id: chg
                        visible: !!(root.d.head && root.d.head.change)
                        x: price.implicitWidth + 10
                        anchors.baseline: price.baseline
                        text: root.d.head ? root.d.head.change : ""
                        size: 13; weight: Theme.weightSemibold; tnum: true
                        color: price.color
                    }
                    Label {
                        x: (chg.visible ? chg.x + chg.implicitWidth : price.implicitWidth) + 10
                        anchors.baseline: price.baseline
                        text: root.d.head ? root.d.head.source : ""
                        size: 11; color: Theme.labelTertiary
                    }
                }
                Flow {
                    visible: !!(root.d.head && root.d.head.pills.length)
                    width: parent.width
                    spacing: 6
                    Repeater {
                        model: root.d.head ? root.d.head.pills : []
                        Pill {
                            required property var modelData
                            tint: modelData.tint; text: modelData.text; dot: modelData.dot
                            Loader { anchors.fill: parent; active: !!parent.modelData.tip; sourceComponent: Tip { text: parent.parent.modelData.tip } }
                        }
                    }
                }
            }
            // .dossier-facts:分节标题与列表竖排、间距 4(flex 里标题的上 24 下 9 不合并)
            Column {
                width: parent.width
                spacing: 4
                Repeater {
                    model: root.d.sections || []
                    Column {
                        id: sec
                        required property var modelData
                        width: parent.width
                        spacing: 4
                        SectionTitle { text: sec.modelData.title; count: sec.modelData.count }
                        // 价位:胶囊(.chip-tag),间距 6,下 6
                        Flow {
                            visible: sec.modelData.kind === "levels"
                            width: parent.width
                            spacing: 6
                            bottomPadding: 6
                            Repeater {
                                model: sec.modelData.kind === "levels" ? sec.modelData.rows : []
                                Rectangle {
                                    required property var modelData
                                    width: lv.implicitWidth + 22; height: 26
                                    radius: Theme.radiusControl
                                    color: Theme.bgFill
                                    Label {
                                        id: lv
                                        anchors.centerIn: parent
                                        text: parent.modelData.text; size: 12; css: 1.5
                                        color: parent.modelData.kind === "resistance" ? Theme.downText : parent.modelData.kind === "support" ? Theme.upText : Theme.label
                                    }
                                    Tip { text: parent.modelData.tip }
                                }
                            }
                        }
                        // 列表:间距 4,下 6
                        Column {
                            visible: sec.modelData.kind !== "levels"
                            width: parent.width
                            spacing: 4
                            bottomPadding: 6
                            Repeater {
                                model: sec.modelData.kind !== "levels" ? sec.modelData.rows : []
                                Rectangle {
                                    id: li
                                    required property var modelData
                                    readonly property bool wrapK: modelData.cls === "wrap"
                                    width: parent.width
                                    height: 5 + Math.max(17.64, kLabel.implicitHeight) + 5
                                    radius: 10
                                    color: Theme.bgFill
                                    Row {
                                        id: vRow
                                        anchors.right: parent.right; anchors.rightMargin: 10
                                        y: 5
                                        visible: li.modelData.v !== undefined || !!li.modelData.pnl
                                        Label { text: li.modelData.v !== undefined ? li.modelData.v : ""; size: 12; color: Theme.labelSecondary; tnum: true; css: 1.47 }
                                        // TrackCard 的 Pnl:涨跌的是 590、涨跌色;持平与没有的是二级色(.muted);百分比 400、75% 透明、左 4
                                        Label {
                                            visible: !!li.modelData.pnl
                                            text: li.modelData.pnl ? " " + li.modelData.pnl.text : ""; size: 12; tnum: true; css: 1.47
                                            weight: li.modelData.pnl && li.modelData.pnl.cls !== "muted" ? 590 : Font.Normal
                                            color: !li.modelData.pnl ? Theme.label : li.modelData.pnl.cls === "pnl-up" ? Theme.upText : li.modelData.pnl.cls === "pnl-down" ? Theme.downText : Theme.labelSecondary
                                        }
                                        Item { visible: !!(li.modelData.pnl && li.modelData.pnl.pct); width: 4; height: 1 }
                                        Label {
                                            visible: !!(li.modelData.pnl && li.modelData.pnl.pct)
                                            opacity: 0.75
                                            text: li.modelData.pnl ? li.modelData.pnl.pct || "" : ""; size: 12; tnum: true; css: 1.47
                                            color: !li.modelData.pnl ? Theme.label : li.modelData.pnl.cls === "pnl-up" ? Theme.upText : li.modelData.pnl.cls === "pnl-down" ? Theme.downText : Theme.labelSecondary
                                        }
                                    }
                                    Label {
                                        id: kLabel
                                        x: 10; y: 5
                                        width: parent.width - 20 - (vRow.visible ? vRow.implicitWidth + 12 : 0)
                                        wrap: li.wrapK; elide: li.wrapK ? Text.ElideNone : Text.ElideRight
                                        text: li.modelData.k; size: 12; css: 1.47
                                        weight: li.modelData.cls === "high" ? Theme.weightSemibold : Font.Normal
                                    }
                                }
                            }
                        }
                    }
                }
            }
            SectionTitle { text: "时间线"; count: root.d.timelineCount || 0 }
            IntelTimeline {
                width: parent.width
                tl: root.d.timeline || ({})
                onOpenSymbol: function (s) { if (root.controller) root.controller.openDossier(s) }
                onWrite: function (t) { root.writeTimeline(t) }
            }
        }
    }
}
