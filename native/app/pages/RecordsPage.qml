import QtQuick
import Dafri.Kit

// 交易记录(pages/Records.tsx):页头的疏密与导出、这一批记录的去向(分段条 + 图例)、筛选条 + 关键词、一张表、点开一行的单据。
// 模型在 C++(shell/records_rules,经 shell/records_controller);进页即读,停留期间 15 秒一轮。
ScrollPage {
    id: page
    property var controller: null
    readonly property var m: controller ? controller.page : ({})
    readonly property bool compact: !!m.compact
    Component.onCompleted: if (controller) controller.setVisible(true)
    Component.onDestruction: if (controller) controller.setVisible(false)
    // Esc 收起打开的详情:在 C++ 里听(app/escape_watcher.h,只看不拦,抽屉与对话框照样收到同一下)

    PageHead {
        width: parent.width
        title: m.title || "交易记录"
        Row {
            spacing: 8
            Segmented {
                small: true
                options: [{ value: "cozy", label: "舒适" }, { value: "compact", label: "紧凑" }]
                value: page.compact ? "compact" : "cozy"
                onActivated: function (v) { if (page.controller) page.controller.setCompact(v === "compact") }
                anchors.verticalCenter: parent.verticalCenter
            }
            Button { small: true; text: "导出"; onClicked: if (page.controller) page.controller.exportAll(); anchors.verticalCenter: parent.verticalCenter }
        }
    }

    // 这一批记录的去向(.status-mix):卡片面、20 圆角、14 × 16;分段条 10 高 5 圆角、段间 2;图例上 10、项间 16、圆点 8、字 11.5 二级色、数 13px 700
    Glass {
        visible: !!page.m.mix
        width: parent.width
        height: visible ? 14 + 10 + 10 + legend.implicitHeight + 14 : 0
        radius: Theme.radiusCard
        fill: Theme.bgElevated
        edge: Theme.edgeCard
        // 下 14
        Item { width: 1; height: 1 }
        Item {
            id: bar
            x: 16; y: 14
            width: parent.width - 32; height: 10
            clip: true
            readonly property var parts: page.m.mix ? page.m.mix.parts : []
            readonly property real total: { var t = 0; for (var i = 0; i < parts.length; ++i) t += parts[i].grow; return t }
            // flex-grow 分剩下的宽(段间 2,每段最少 4)
            Row {
                spacing: 2
                Repeater {
                    model: bar.parts
                    Rectangle {
                        required property var modelData
                        required property int index
                        width: Math.max(4, (bar.width - 2 * (bar.parts.length - 1)) * modelData.grow / Math.max(1, bar.total))
                        height: 10
                        // 每段 2 圆角;整条 5 圆角(overflow: hidden)落在头尾两段的外侧
                        radius: 2
                        topLeftRadius: index === 0 ? 5 : 2; bottomLeftRadius: index === 0 ? 5 : 2
                        topRightRadius: index === bar.parts.length - 1 ? 5 : 2; bottomRightRadius: index === bar.parts.length - 1 ? 5 : 2
                        color: Theme.tintOf(modelData.tint)
                        Tip { text: modelData.title }
                    }
                }
            }
        }
        Flow {
            id: legend
            x: 16; y: 14 + 10 + 10
            width: parent.width - 32
            spacing: 16
            Repeater {
                model: page.m.mix ? page.m.mix.legend : []
                Row {
                    required property var modelData
                    spacing: 6
                    height: 19
                    Rectangle { width: 8; height: 8; radius: 4; color: Theme.tintOf(modelData.tint); anchors.verticalCenter: parent.verticalCenter }
                    Label { text: modelData.label; size: 11.5; color: Theme.labelSecondary; anchors.verticalCenter: parent.verticalCenter }
                    Label { text: String(modelData.count); size: 13; weight: 700; family: Theme.fontDisplay; tnum: true; anchors.verticalCenter: parent.verticalCenter }
                }
            }
        }
    }
    Item { visible: !!page.m.mix; width: 1; height: 14 }

    // 筛选条 + 关键词(.row.tight:间距 8、下 10;Segmented 不缩,搜索框占剩下的)
    Item {
        width: parent.width
        height: Theme.controlHeight + 10
        Segmented {
            id: filters
            small: true
            y: (Theme.controlHeight - height) / 2
            options: (page.m.filters || []).map(function (f) { return { value: f.key, label: f.label, count: f.count, disabled: f.disabled } })
            value: { var fs = page.m.filters || []; for (var i = 0; i < fs.length; ++i) if (fs[i].selected) return fs[i].key; return "all" }
            onActivated: function (v) { if (page.controller) page.controller.setFilter(v) }
        }
        SearchInput {
            x: filters.width + 8
            width: parent.width - x
            placeholder: "按标的 / 原因 / 指令内容筛选"
            onEdited: function (t) { if (page.controller) page.controller.setKeyword(t) }
        }
    }

    Alert {
        visible: !!page.m.error
        width: parent.width
        tone: "error"
        text: page.m.error || ""
    }
    Item { visible: !!page.m.error; width: 1; height: 10 }

    // 表(AntD Table:格子里的数字一律等宽(styles.css 的 td);中号 12 × 8、小号 5 × 8;表头 11px 590 二级色、下边 1px;每行下边 1px;悬停填充底;打开的那一行蓝 10%)
    Column {
        id: table
        width: parent.width
        readonly property real padY: page.compact ? 5 : 12
        // 列宽:96 / 150 / 余下 / 150 / 110 / 112(意图那一列吃剩下的)
        readonly property var widths: [96, 150, Math.max(120, width - 96 - 150 - 150 - 110 - 112), 150, 110, 112]
        function colX(i) { var x = 0; for (var k = 0; k < i; ++k) x += widths[k]; return x }
        Item {
            width: parent.width
            height: table.padY + 18.7 + table.padY + 1
            Repeater {
                model: page.m.columns || []
                Item {
                    required property var modelData
                    required property int index
                    x: table.colX(index)
                    width: table.widths[index]
                    height: parent.height - 1
                    Label {
                        x: 8; anchors.verticalCenter: parent.verticalCenter
                        width: parent.width - 16
                        horizontalAlignment: parent.index === 4 ? Text.AlignRight : Text.AlignLeft
                        text: parent.modelData.title; size: 11; weight: Theme.weightSemibold; color: Theme.labelSecondary
                    }
                    // 排序的上下两枚三角(11px;排着的那一枚强调色)
                    Item {
                        visible: parent.modelData.sortable
                        x: parent.width - 8 - 11; y: table.padY
                        width: 11; height: 18.7
                        Icon { y: 0; name: "ad-caret-up"; size: 11; color: parent.parent.modelData.order === "ascend" ? Theme.blue : Theme.tint(Theme.labelSecondary, 0.65) }
                        Icon { y: 7.7; name: "ad-caret-down"; size: 11; color: parent.parent.modelData.order === "descend" ? Theme.blue : Theme.tint(Theme.labelSecondary, 0.65) }
                    }
                    TapHandler { enabled: parent.modelData.sortable; onTapped: if (page.controller) page.controller.sortBy(parent.modelData.key) }
                    HoverHandler { cursorShape: parent.modelData.sortable ? Qt.PointingHandCursor : Qt.ArrowCursor }
                }
            }
            Rectangle { y: parent.height - 1; width: parent.width; height: 1; color: Theme.separator }
        }
        // 空表:控件面的一行(AntD 6 不铺底,shell.css 补回来)里一个空态
        Rectangle {
            visible: !!page.controller && page.controller.rows.count === 0
            width: parent.width
            height: visible ? 16 + emptyState.implicitHeight + 16 + 1 : 0
            color: Theme.bgControl
            EmptyState { id: emptyState; y: 16; width: parent.width; topMargin: 0; text: page.m.empty || "" }
            Rectangle { y: parent.height - 1; width: parent.width; height: 1; color: Theme.separator }
        }
        Repeater {
            model: page.controller ? page.controller.rows : null
            RecordRow { required property var modelData; width: table.width; r: modelData }
        }
    }

    Loader {
        active: !!(page.controller && page.controller.openId)
        visible: active
        width: parent.width
        sourceComponent: RecordDetail { controller: page.controller; d: page.controller ? page.controller.detail : ({}) }
    }

    // 一行:时间(悬停给全写)、代码徽章 + 买卖、意图(下面一行理由)、账户(实盘橙)、金额(右对齐)、状态胶囊
    component RecordRow: Rectangle {
        id: row
        property var r: ({})
        readonly property real padY: table.padY
        // 内容高:徽章 30;意图一行 17.64,有理由再加 4 + 16.17
        readonly property real contentH: Math.max(30, 17.64 + (r.reason ? 4 + 16.17 : 0))
        height: padY + contentH + padY + 1
        color: r.open ? Theme.tint(Theme.blue, 0.10) : hover.hovered ? Theme.bgFill : "transparent"
        HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
        TapHandler { onTapped: if (page.controller) page.controller.open(row.r.id) }
        Rectangle { y: parent.height - 1; width: parent.width; height: 1; color: Theme.separator }
        Item {
            y: row.padY
            width: parent.width
            height: row.contentH
            Label {
                x: table.colX(0) + 8; anchors.verticalCenter: parent.verticalCenter
                text: row.r.time || ""; size: 12; tnum: true
                Tip { text: row.r.timeTitle || "" }
            }
            Row {
                x: table.colX(1) + 8; anchors.verticalCenter: parent.verticalCenter
                spacing: 8
                SymBadge {
                    small: true; symbol: row.r.symbol || ""
                    anchors.verticalCenter: parent.verticalCenter
                    Tip { text: row.r.symbolLink ? "打开 " + row.r.symbolLink + " 的档案" : "" }
                    TapHandler { enabled: !!row.r.symbolLink; onTapped: if (page.controller) page.controller.dossier(row.r.symbolLink) }
                }
                Pill {
                    visible: !!row.r.side
                    tint: row.r.buy ? "up" : "down"; tri: row.r.buy ? "up" : "down"
                    text: row.r.side || ""
                    anchors.verticalCenter: parent.verticalCenter
                }
            }
            Column {
                x: table.colX(2) + 8; anchors.verticalCenter: parent.verticalCenter
                width: table.widths[2] - 16
                Label { width: parent.width; text: row.r.intent || ""; size: 12; tnum: true; elide: Text.ElideRight; Tip { text: row.r.intent || "" } }
                Label { visible: !!row.r.reason; width: parent.width; topPadding: 4; text: row.r.reason || ""; size: 11; tnum: true; color: Theme.labelSecondary; elide: Text.ElideRight }
            }
            Label {
                visible: row.r.account !== null && row.r.account !== undefined
                x: table.colX(3) + 8; anchors.verticalCenter: parent.verticalCenter
                width: table.widths[3] - 16
                text: row.r.account || ""; size: 12; tnum: true; elide: Text.ElideRight
                color: row.r.paper ? Theme.labelSecondary : Theme.orangeText
                weight: row.r.paper ? Font.Normal : Theme.weightSemibold
            }
            Label {
                x: table.colX(4) + 8; anchors.verticalCenter: parent.verticalCenter
                width: table.widths[4] - 16
                horizontalAlignment: Text.AlignRight
                text: row.r.amount || ""; size: 12; tnum: true
            }
            Pill {
                x: table.colX(5) + 8; anchors.verticalCenter: parent.verticalCenter
                dot: true; tint: row.r.statusTint || "gray"; text: row.r.status || ""
            }
        }
    }
}
