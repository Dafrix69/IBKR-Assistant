import QtQuick
import Dafri.Kit

// 账户里的一份持仓(pages/Tracker.tsx 的 PositionBody 与外面那张 StatusCard):大号的未实现盈亏、事实栏(数量 / 成本 / 现价 / 账户)、
// 设置追踪的按钮与表单。组合下面折着它的腿。m = shell/tracker_page 的 positionModel
StatusCard {
    id: root
    property var m: ({})
    property var controller: null
    width: parent ? parent.width : 400
    title: m.title || ""
    extra: Pill { tint: root.m.pill ? root.m.pill.tint : "gray"; text: root.m.pill ? root.m.pill.text : ""; tri: root.m.pill && root.m.pill.tri ? root.m.pill.tri : "" }

    PositionBody { m: root.m; controller: root.controller; width: parent.width }

    // 腿明细(组合):上 8;头上下各 4、12px 行高 1.47(一行 27 高),默认收着;一条腿一张小卡片,可以按腿追踪
    Item {
        id: legs
        property bool open: false
        visible: !!root.m.legsHeader
        width: parent.width
        height: visible ? 8 + 27 + (open ? legsCol.implicitHeight : 0) : 0
        // AntD 折叠头:展开箭头那一格 12 宽、右边再空 12(.ant-collapse-expand-icon 的 padding-inline-end),字从 27 起(量的 React 版)
        Row {
            y: 8 + 4
            height: 19
            spacing: 0
            Item {
                width: 27; height: parent.height
                Text { text: "›"; rotation: legs.open ? 90 : 0; color: Theme.labelSecondary; font.pixelSize: 11; font.family: Theme.fontFamily; anchors.verticalCenter: parent.verticalCenter }
            }
            Label { text: root.m.legsHeader || ""; size: 11; color: Theme.labelSecondary; anchors.verticalCenter: parent.verticalCenter }
            TapHandler { onTapped: legs.open = !legs.open }
        }
        Column {
            id: legsCol
            y: 8 + 27
            width: parent.width
            spacing: 8
            visible: legs.open
            // 同外层:按 key 原地更新的模型,腿的现价一变不重建(里面可能开着按腿追踪的表单)
            Repeater {
                model: legs.open && root.controller ? root.controller.legsModel(root.m.key) : null
                StatusCard {
                    required property var modelData
                    width: legsCol.width
                    title: modelData.title
                    extra: Pill { tint: modelData.pill.tint; text: modelData.pill.text; tri: modelData.pill.tri || "" }
                    PositionBody { m: modelData; controller: root.controller; width: parent.width }
                }
            }
        }
    }

    // 一份持仓的主体(PositionBody):pos-hero(上 2、高 48:徽章 38 + 大数 26px 行高 1.1 + 小字 11.5px;右边事实栏每格 6 10 内边距、
    // 数 14px 行高 1.47、名 10.5px 行高 1.47、最窄 74、间距 6)→「已在追踪」11px 一行 / 设置追踪(上 8)→ 表单
    component PositionBody: Column {
        id: body
        property var m: ({})
        property var controller: null
        Item {
            width: parent.width
            height: 2 + 48
            Row {
                id: heroRow
                y: 2
                height: 48
                spacing: body.m.compact ? 10 : 12
                SymBadge { visible: !body.m.compact; symbol: body.m.badge ? body.m.badge.text : ""; anchors.verticalCenter: parent.verticalCenter }
                Column {
                    anchors.verticalCenter: parent.verticalCenter
                    Label {
                        text: body.m.hero || ""
                        color: body.m.heroDir === "up" ? Theme.upText : body.m.heroDir === "down" ? Theme.downText : Theme.label
                        size: body.m.compact ? 20 : 26; weight: Theme.weightHeavy; family: Theme.fontDisplay; letterSpacing: -0.5; css: 1.1; tnum: true
                    }
                    Row {
                        Label { text: body.m.heroSub || ""; size: 11.5; color: Theme.labelSecondary; tnum: true }
                        Repeater {
                            model: body.m.heroNotes || []
                            Item {
                                required property var modelData
                                width: note.implicitWidth; height: note.implicitHeight
                                Label { id: note; text: modelData.text; size: 11.5; color: Theme.labelSecondary }
                                Tip { text: modelData.tip }
                            }
                        }
                    }
                }
                Pill { visible: !!body.m.pct; tint: body.m.pct ? body.m.pct.tint : "gray"; text: body.m.pct ? body.m.pct.text : ""; tri: body.m.pct ? body.m.pct.tint : ""; anchors.verticalCenter: parent.verticalCenter }
            }
            Row {
                y: 2
                anchors.right: parent.right
                spacing: 6
                Repeater {
                    model: body.m.facts || []
                    Rectangle {
                        required property var modelData
                        width: Math.max(74, factCol.implicitWidth + 20)
                        height: 6 + factCol.implicitHeight + 6
                        radius: Theme.radiusTile
                        color: Theme.bgFill
                        Column {
                            id: factCol
                            x: 10; y: 6
                            Label {
                                text: modelData.value
                                size: modelData.text ? 12.5 : 14; weight: modelData.text ? Theme.weightSemibold : 700
                                family: modelData.text ? Theme.fontFamily : Theme.fontDisplay; tnum: true; letterSpacing: modelData.text ? 0 : -0.14
                            }
                            Label { text: modelData.label; size: 10.5; color: Theme.labelSecondary }
                        }
                    }
                }
            }
        }
        Label { visible: !!body.m.tracked; text: "已在追踪中,设置见下方。"; size: 11; color: Theme.labelSecondary }
        // .row.tight 的 margin: 0 0 10px 压过了 .track-toggle 的 margin-top: 8(两个类名比一个优先):紧贴在大数下面、下面空 10
        Item {
            visible: !body.m.tracked
            width: parent.width
            height: visible ? toggleBtn.height + 10 : 0
            Button {
                id: toggleBtn
                y: 0
                small: true
                text: body.m.open ? "收起" : "设置追踪"
                onClicked: if (body.controller) body.controller.toggleForm(body.m.key)
            }
        }
        Loader {
            active: !!body.m.open && !body.m.tracked
            width: parent.width
            visible: active
            source: "TrackForm.qml"
            // 都是绑定,不是一次性赋值:持仓的现价、账户类别变了,表单当场跟着变(React 版每次渲染都现取)
            onLoaded: {
                item.position = Qt.binding(function () { return body.m.position })
                item.controller = body.controller
                item.paper = Qt.binding(function () { return body.controller ? (body.controller.statusRev, body.controller.isPaper(body.m.position.account)) : false })
            }
        }
    }
}
