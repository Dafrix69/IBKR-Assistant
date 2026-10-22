import QtQuick

// 提示条(AntD Alert,React 版 ui/kit 的 Notice + theme/antd.ts):警告 / 错误 / 成功只淡淡染一层(10%)、边 35%,颜色主要落在图标上;
// 说明类是卡片面 + 发丝边。16 圆角,内边距 10 × 12(没有说明时 9 × 12);左边 14 的实心圆标。
// 有 title:标题 12px 字重 590(警告用橙色的可访问变体),正文 11.5px 二级色;没有 title:正文就是 12px 的标题。
// plain:直接用的 AntD Alert(带 description,不经 Notice,比如记录详情的「失败原因」「提醒」):图标 16、离字 12;标题 13px 正常字重正文色、下 8;说明 12px 正文色。
Rectangle {
    id: root
    property string tone: "info"   // info | warn | error | success
    property string title: ""
    property string text: ""
    /// 正文里有 <b>…</b>(加粗的一句)
    property bool rich: false
    property bool plain: false
    default property alias extra: more.data
    readonly property color toneColor: tone === "warn" ? Theme.orange : tone === "error" ? Theme.red : tone === "success" ? Theme.green : Theme.blue
    readonly property bool described: title !== ""
    readonly property real padY: described || plain ? 10 : 9
    implicitHeight: 1 + padY + col.implicitHeight + padY + 1
    radius: 16
    color: tone === "info" ? Theme.bgElevated : Theme.tint(toneColor, 0.10)
    border.width: 1
    border.color: tone === "info" ? Theme.separator : Theme.tint(toneColor, 0.35)
    Rectangle {
        x: 13; y: root.plain ? 11 : root.padY + 3
        width: root.plain ? 16 : 14; height: width; radius: width / 2
        color: root.toneColor
        Text {
            anchors.centerIn: parent
            text: root.tone === "success" ? "✓" : root.tone === "info" ? "i" : "!"
            color: "#ffffff"
            font.pixelSize: root.plain ? 11 : 10; font.weight: Theme.weightHeavy; font.family: Theme.fontFamily
        }
    }
    Column {
        id: col
        x: root.plain ? 41 : 39
        y: root.padY + 1
        width: root.width - x - 13
        Label {
            width: parent.width
            wrap: true
            text: root.described ? root.title : root.text
            textFormat: !root.described && root.rich ? Text.StyledText : Text.PlainText
            visible: text !== ""
            color: !root.plain && root.described && root.tone === "warn" ? Theme.orangeText : !root.plain && root.described && root.tone === "error" ? Theme.redText : Theme.label
            size: root.plain && root.described ? 13 : 12; css: 1.55
            weight: root.described && !root.plain ? Theme.weightSemibold : Font.Normal
        }
        Item { width: 1; height: root.described && root.text !== "" ? 8 : 0 }
        Label {
            visible: root.described && root.text !== ""
            width: parent.width
            wrap: true
            textFormat: root.rich ? Text.StyledText : Text.PlainText
            text: root.text
            color: root.plain ? Theme.label : Theme.labelSecondary
            size: root.plain ? 12 : 11.5; css: 1.55
        }
        Item {
            id: more
            width: parent.width
            height: childrenRect.height
            visible: children.length > 0
        }
    }
}
