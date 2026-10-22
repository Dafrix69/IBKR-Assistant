import QtQuick

// 开关(AntD Switch + theme/antd.ts):轨道 46 × 26、把手 22、内边距 2;开是系统绿
Rectangle {
    id: root
    property bool checked: false
    /// AntD 的 small:轨道 28 × 16、把手 12
    property bool small: false
    /// 自己接点击;整行可点的那种(SwitchRow)关掉它,点一下只翻一次
    property bool tappable: true
    signal toggled(bool checked)
    implicitWidth: small ? 28 : 46; implicitHeight: small ? 16 : 26; radius: height / 2
    opacity: enabled ? 1 : 0.4
    color: checked ? Theme.green : Theme.bgFillStrong
    Behavior on color { ColorAnimation { duration: Theme.durationMid } }
    Rectangle {
        width: root.small ? 12 : 22; height: width; radius: width / 2; y: 2
        x: root.checked ? parent.width - width - 2 : 2
        color: "#ffffff"
        Behavior on x { NumberAnimation { duration: Theme.durationMid; easing.type: Easing.OutCubic } }
    }
    // 按下就把焦点拿过来:输入框先失焦、先跑完它的 editingFinished(打完的数夹好、发出去),点击才执行——同浏览器里按下按钮先让输入框失焦
    TapHandler { enabled: root.enabled && root.tappable; onPressedChanged: if (pressed) root.forceActiveFocus(); onTapped: root.toggled(!root.checked) }
}
