import QtQuick

// 标签(AntD 的 Tag):底色是 10% 的淡染,字用同色
Rectangle {
    id: root
    property alias text: label.text
    property color tone: Theme.gray
    implicitWidth: label.implicitWidth + 12
    implicitHeight: 20
    radius: Theme.radiusSmall - 3
    color: Theme.tint(tone, 0.12)
    Text {
        id: label
        anchors.centerIn: parent
        color: root.tone
        font.pixelSize: Theme.fontSmall
        font.family: Theme.fontFamily
    }
}
