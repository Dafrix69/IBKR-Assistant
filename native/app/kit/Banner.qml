import QtQuick

// 横幅(AntD 的 Alert):警告面只有 8–10% 的淡染;空文字时不占地方
Rectangle {
    id: root
    property alias text: label.text
    property color tone: Theme.orange
    visible: label.text !== ""
    implicitHeight: visible ? label.implicitHeight + 16 : 0
    color: Theme.tint(tone, 0.1)
    Text {
        id: label
        anchors.fill: parent
        anchors.margins: 8
        wrapMode: Text.Wrap
        color: Theme.dark ? root.tone : Theme.orangeText
        font.pixelSize: Theme.fontBody
        font.family: Theme.fontFamily
    }
}
