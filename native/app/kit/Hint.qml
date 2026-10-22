import QtQuick

// 说明文字(.hint):11px 二级色,行高 1.55,最宽 760;上边 7。warn:橙字(.warn-text)。<b>…</b> 是正文色加粗
Item {
    id: root
    property alias text: label.text
    property bool warn: false
    property real topPadding: 7
    property alias textFormat: label.textFormat
    width: Math.min(parent ? parent.width : 760, 760)
    implicitHeight: visible ? topPadding + label.implicitHeight : 0
    height: implicitHeight
    Label {
        id: label
        y: root.topPadding
        width: root.width
        wrap: true
        size: 11
        css: 1.55
        color: root.warn ? Theme.orangeText : Theme.labelSecondary
        textFormat: Text.StyledText
    }
}
