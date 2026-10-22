import QtQuick

// 勾选框(AntD Checkbox):16 方、4 圆角;勾上是强调色底白勾。
// 受控:checked 只由外面给,点一下只发 toggled(自己赋值会冲掉外面的绑定,框上画的和状态里的会对不上)
Row {
    id: root
    property bool checked: false
    property string text: ""
    signal toggled(bool checked)
    spacing: 8
    Rectangle {
        width: 16; height: 16; radius: 4
        anchors.verticalCenter: parent.verticalCenter
        color: root.checked ? Theme.blue : Theme.bgControl
        border.width: root.checked ? 0 : 1
        border.color: Theme.separatorOpaque
        Text { anchors.centerIn: parent; visible: root.checked; text: "✓"; color: "#ffffff"; font.pixelSize: 11; font.weight: Theme.weightHeavy }
    }
    Text {
        text: root.text
        anchors.verticalCenter: parent.verticalCenter
        color: Theme.label; font.pixelSize: Theme.fontBody; font.family: Theme.fontFamily
    }
    // 按下就把焦点拿过来:输入框先失焦、先跑完它的 editingFinished(打完的数夹好、发出去),点击才执行——同浏览器里按下按钮先让输入框失焦
    TapHandler { enabled: root.enabled; onPressedChanged: if (pressed) root.forceActiveFocus(); onTapped: root.toggled(!root.checked) }
}
