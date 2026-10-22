import QtQuick
import Dafri.Kit

// ⌘K「查标的」(shell/DossierHost.tsx 的 Lookup,AntD Modal 420 宽):大号输入框(敲的不像代码时边变橙),回车打开档案;
// 下面一句提示(11.5px 二级色,上 8 下 10);「持仓」「最近」两排胶囊(.lookup-row:11px 三级色的名占 30、胶囊间距 6,行间 6)。
// 每次打开都清空、聚焦输入框。模型:IntelController.lookup(敲的字)(shell/intel_page_rules 的 lookupModel)
Modal {
    id: root
    property var controller: null
    property string typed: ""
    // held 与最近查过的跟着 store 变:显式依赖 lookupRevision(store 每变一次加一)
    readonly property var m: controller ? (controller.lookupRevision, controller.lookup(typed)) : ({})
    readonly property bool want: !!controller && controller.lookupOpen
    title: "查标的"
    panelWidth: 420
    onWantChanged: {
        if (want) {
            typed = ""
            open()
            Qt.callLater(function () { input.focusField() })
        } else if (visible) visible = false
    }
    onClosed: if (controller && controller.lookupOpen) controller.setLookupOpen(false)

    Column {
        width: parent.width
        Input {
            id: input
            width: parent.width
            large: true
            placeholder: "代码,如 NVDA、SPX、$TSLA"
            text: root.typed
            warn: !!root.m.warn
            onEdited: function (t) { root.typed = t }
            onAccepted: if (root.m.symbol) root.controller.openDossier(root.m.symbol)
        }
        Label {
            topPadding: 8; bottomPadding: 10
            width: parent.width; wrap: true
            text: root.m.hint || ""; size: 11.5; color: Theme.labelSecondary
        }
        ChipRow { label: "持仓"; items: root.m.held || [] }
        ChipRow { label: "最近"; items: root.m.recent || []; topPadding: (root.m.held || []).length ? 6 : 0 }
    }

    component ChipRow: Item {
        id: cr
        property string label: ""
        property var items: []
        property real topPadding: 0
        visible: items.length > 0
        width: parent ? parent.width : 0
        height: visible ? topPadding + flow.implicitHeight : 0
        Flow {
            id: flow
            y: cr.topPadding
            width: parent.width
            spacing: 6
            Item { width: 30; height: 26; Label { anchors.verticalCenter: parent.verticalCenter; text: cr.label; size: 11; color: Theme.labelTertiary } }
            Repeater {
                model: cr.items
                Rectangle {
                    required property var modelData
                    width: chipL.implicitWidth + 22; height: 26
                    radius: Theme.radiusControl
                    color: chipHover.hovered ? Theme.bgFillStrong : Theme.bgFill
                    Label { id: chipL; anchors.centerIn: parent; text: parent.modelData; size: 12; css: 1.5 }
                    HoverHandler { id: chipHover; cursorShape: Qt.PointingHandCursor }
                    TapHandler { onTapped: if (root.controller) root.controller.openDossier(parent.modelData) }
                }
            }
        }
    }
}
