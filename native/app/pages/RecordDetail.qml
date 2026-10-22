import QtQuick
import Dafri.Kit

// 一条交易记录的单据(lib/RecordDetail.tsx + styles.css 的 .detail):卡片面、0.5px 发丝边、20 圆角、内边距 16 × 18,离上面 14。
// 头(标的 · 买卖 数量、状态胶囊、右边「分析这笔交易」「收起」)下面一道分隔线;票据 + 阶段路径铺在填充底上;
// 失败原因;五个小节(空的不画);状态时间线;成交明细;提醒;原始记录(JSON)收在折叠里。
// 竖向的间距照 CSS 的外边距合并:头的下 4 和后面那块的上边距(12 / 10)合并成后者。量的 React 版(1360 宽,记录 r1)。
// d = shell/records_rules 的 detailModel
Column {
    id: root
    property var controller: null
    property var d: ({})
    readonly property bool ok: d.state === "ok"
    topPadding: 14

    Glass {
        width: parent.width
        height: 0.5 + 16 + body.implicitHeight + 16 + 0.5
        radius: Theme.radiusCard
        fill: Theme.bgElevated
        edge: Theme.edgeCard
        border: Theme.separator
        borderWidth: 0.5
        Column {
            id: body
            x: 18.5; y: 16.5
            width: parent.width - 37

            // 读着:四行骨架(LoadingBlock rows=4:上 6 下 14;AntD Skeleton 每行 16 高、行距 16)
            Column {
                visible: root.d.state === "loading"
                width: parent.width
                topPadding: 6; bottomPadding: 14
                spacing: 16
                Repeater {
                    model: [0.62, 0.48, 0.54, 0.40]
                    Rectangle { required property real modelData; width: parent.width * modelData; height: 16; radius: 4; color: Theme.bgFill }
                }
            }
            EmptyState { visible: !!root.d.empty; width: parent.width; text: root.d.empty || "" }

            // 头(.detail-head:按钮那一行 24 高、下 9、0.5px 分隔线)
            Item {
                visible: root.ok
                width: parent.width
                height: visible ? 24 + 9 + 0.5 : 0
                Row {
                    y: (24 - height) / 2
                    spacing: 10
                    Label { id: titleL; text: root.d.title || ""; size: 13; weight: 700; anchors.verticalCenter: parent.verticalCenter }
                    Pill { dot: true; tint: root.d.statusTint || "gray"; text: root.d.status || ""; anchors.verticalCenter: parent.verticalCenter }
                }
                Row {
                    anchors.right: parent.right
                    spacing: 6
                    Button { visible: !!root.d.review; small: true; text: "分析这笔交易"; onClicked: if (root.controller) root.controller.review(root.d.id) }
                    Button { small: true; kind: "text"; text: "收起"; onClicked: if (root.controller) root.controller.close() }
                }
                Rectangle { y: parent.height - 0.5; width: parent.width; height: 0.5; color: Theme.separator }
            }

            // 票据 + 走到哪一步(.detail-ticket:上 12、内边距 14 × 16、瓦片圆角、填充底;票据下 12;
            // 阶段路径在一个 19.11 高的行框里,按基线落在 +2.4)
            Item {
                visible: root.ok && !!root.d.ticket
                width: parent.width
                height: visible ? 12 + tile.height : 0
                Rectangle {
                    id: tile
                    y: 12
                    width: parent.width
                    height: 14 + ticket.implicitHeight + 19.11 + 14
                    radius: Theme.radiusTile
                    color: Theme.bgFill
                    OrderTicket { id: ticket; x: 16; y: 14; width: parent.width - 32; t: root.d.ticket || ({}); topPadding: 0; bottomPadding: 12; numsFill: Theme.bgElevated }
                    StagePath {
                        x: 16; y: 14 + ticket.implicitHeight + 2.4
                        stages: ["校验", "提交", "成交"]
                        current: root.d.stageCurrent || 0
                        tone: Theme.tintOf(root.d.statusTint || "gray")
                    }
                }
            }

            Item { visible: root.ok && !!root.d.errorDetail; width: 1; height: 10 }
            Alert { visible: root.ok && !!root.d.errorDetail; plain: true; width: parent.width; tone: "error"; title: "失败原因"; text: root.d.errorDetail || "" }

            // 小节(.detail-section:上 12;小标题 11px 590 三级色、字距 0.02em、行高 16.17、下 6;
            // AntD 小号 Descriptions:每行 22.6 高(最后一行 18.8),字从 +1 起;名 84 宽 12px 二级色、值 12px 等宽数字)
            Repeater {
                model: root.ok ? root.d.sections : []
                Column {
                    id: section
                    required property var modelData
                    width: body.width
                    topPadding: 12
                    SectionHead { text: section.modelData.title }
                    Repeater {
                        model: section.modelData.rows
                        Item {
                            required property var modelData
                            required property int index
                            readonly property bool last: index === section.modelData.rows.length - 1
                            width: body.width
                            height: Math.max(22.6, 1 + v.implicitHeight + 4) - (last ? 3.8 : 0)
                            Label { x: 1; y: 1; width: 84; text: parent.modelData[0]; size: 12; color: Theme.labelSecondary }
                            Label { id: v; x: 85; y: 1; width: parent.width - 85; wrap: true; text: parent.modelData[1]; size: 12; tnum: true }
                        }
                    }
                }
            }

            // 状态时间线(自己画的一列圆点加连线:圆点 10、3px 强调色边;连线 2px 分隔色、从 10 起;字从 26 起、上移 5;
            // 每项最少 18 高、下 8,最后一项最少 48)
            Column {
                visible: root.ok && !!root.d.timeline && root.d.timeline.length > 0
                width: parent.width
                topPadding: 12
                SectionHead { text: "状态时间线" }
                Repeater {
                    model: root.ok ? root.d.timeline : []
                    Item {
                        id: step
                        required property var modelData
                        required property int index
                        readonly property bool last: index === root.d.timeline.length - 1
                        width: body.width
                        height: Math.max(step.last ? 48 : 18, line.height) + 8
                        Rectangle { visible: !step.last; x: 4; y: 10; width: 2; height: parent.height - 10; color: Theme.separator }
                        Rectangle { width: 10; height: 10; radius: 5; color: Theme.bgElevated; border.width: 3; border.color: Theme.blue }
                        Row {
                            id: line
                            x: 26; y: -5
                            spacing: 10
                            Label { text: step.modelData.label; size: 12; weight: 700 }
                            Label { text: step.modelData.at; size: 12; color: Theme.labelSecondary; tnum: true }
                        }
                    }
                }
            }

            // 成交明细(AntD 小号表:5 × 8、表头 12px 590 二级色、表底控件面;列宽按自动排版:每列按它最宽的那段字分剩下的宽)
            Column {
                id: fills
                visible: root.ok && !!root.d.fills
                width: parent.width
                topPadding: 12
                readonly property var heads: ["时间", "数量", "价格", "手续费"]
                readonly property var rows: root.d.fills ? root.d.fills.rows : []
                // 每列最宽的那段字 + 16(左右内边距)
                readonly property var maxW: {
                    var w = []
                    for (var c = 0; c < 4; ++c) {
                        var m = measure.width(heads[c], true)
                        for (var r = 0; r < rows.length; ++r) m = Math.max(m, measure.width([rows[r].time, rows[r].qty, rows[r].price, rows[r].commission][c], false))
                        w.push(m + 16)
                    }
                    return w
                }
                readonly property real sumW: maxW.reduce(function (a, b) { return a + b }, 0)
                function colW(c) { return width * maxW[c] / Math.max(1, sumW) }
                function colX(c) { var x = 0; for (var k = 0; k < c; ++k) x += colW(k); return x }
                SectionHead { text: root.d.fills ? root.d.fills.title : "" }
                Rectangle {
                    width: parent.width
                    height: (1 + fills.rows.length) * 28.6
                    color: Theme.bgControl
                    Repeater {
                        model: fills.heads
                        Label {
                            required property string modelData
                            required property int index
                            x: fills.colX(index) + 8; y: 5; width: fills.colW(index) - 16
                            horizontalAlignment: index === 0 ? Text.AlignLeft : Text.AlignRight
                            text: modelData; size: 12; weight: Theme.weightSemibold; color: Theme.labelSecondary
                        }
                    }
                    Rectangle { y: 27.6; width: parent.width; height: 1; color: Theme.separator }
                    Repeater {
                        model: fills.rows
                        Item {
                            required property var modelData
                            required property int index
                            y: 28.6 * (index + 1)
                            width: fills.width; height: 28.6
                            Repeater {
                                model: [parent.modelData.time, parent.modelData.qty, parent.modelData.price, parent.modelData.commission]
                                Label {
                                    required property string modelData
                                    required property int index
                                    x: fills.colX(index) + 8; y: 5; width: fills.colW(index) - 16
                                    horizontalAlignment: index === 0 ? Text.AlignLeft : Text.AlignRight
                                    text: modelData; size: 12; tnum: true
                                }
                            }
                            Rectangle { y: 27.6; width: parent.width; height: 1; color: Theme.separator }
                        }
                    }
                }
            }

            Repeater {
                model: root.ok ? root.d.warnings : []
                Column {
                    required property string modelData
                    width: body.width
                    topPadding: 10
                    Alert { width: parent.width; plain: true; tone: "warn"; title: "提醒"; text: parent.modelData }
                }
            }

            // 原始记录(JSON):折着(这个项目在意可审计性,那份原文要留得住)。上 12;头 8 / 0 内边距、箭头那格左 4 宽 11 右 12,
            // 12px 二级色;展开后是 <pre>,最高 260 滚动
            Column {
                id: rawBox
                visible: root.ok
                width: parent.width
                topPadding: 12
                property bool open: false
                Item {
                    width: parent.width
                    height: 8 + 19 + 8
                    Icon { x: 4 + 0.5; y: 8 + 4.5; name: "ad-right"; size: 10; color: Theme.labelSecondary; rotation: rawBox.open ? 90 : 0
                           Behavior on rotation { NumberAnimation { duration: 150 } } }
                    Label { x: 27; y: 8 + (19 - 17.64) / 2; text: "原始记录(JSON)"; size: 12; color: Theme.labelSecondary }
                    TapHandler { onTapped: rawBox.open = !rawBox.open }
                    HoverHandler { cursorShape: Qt.PointingHandCursor }
                }
                Flickable {
                    visible: rawBox.open
                    width: parent.width
                    height: visible ? Math.min(260, raw.implicitHeight) : 0
                    clip: true
                    contentWidth: raw.implicitWidth
                    contentHeight: raw.implicitHeight
                    boundsBehavior: Flickable.StopAtBounds
                    TextEdit {
                        id: raw
                        readOnly: true
                        selectByMouse: true
                        text: root.d.raw || ""
                        font.family: Theme.fontMono
                        font.pixelSize: 12
                        color: Theme.label
                    }
                }
            }
        }
    }

    // 量列宽用(12px,表头 590)
    FontMetrics { id: bodyMetrics; font.family: Theme.fontFamily; font.pointSize: Theme.px(12); font.features: ({ "tnum": 1 }) }
    FontMetrics { id: headMetrics; font.family: Theme.fontFamily; font.pointSize: Theme.px(12); font.weight: Theme.weightSemibold }
    QtObject {
        id: measure
        function width(text, head) { return (head ? headMetrics : bodyMetrics).advanceWidth(text) }
    }

    component SectionHead: Label {
        bottomPadding: 6
        size: 11; weight: Theme.weightSemibold; color: Theme.labelTertiary
        letterSpacing: 0.22
    }
}
