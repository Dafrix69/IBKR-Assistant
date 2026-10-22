import QtQuick

// 按钮(theme/antd.ts 的 Button token):整圆的胶囊;默认是控件面 + 发丝边 + 控件投影,悬停换成更深的填充;
// primary 实心强调色、字重 590;danger 红字红边(实心的红用 kind: "dangerSolid");text 是强调色的"可点的词"。
// 不可用时同 AntD:填充色的底、三级色的字、发丝边,没有投影。
// glass: 工具栏里的那种(玻璃面 + 小号玻璃边,36 高)。按下缩 3%、不出水波纹。
Item {
    id: root
    property alias text: label.text
    property string kind: "default"   // default | primary | danger | dangerSolid | text
    property bool busy: false
    property bool small: false
    property bool glass: false
    /// 句子里的文字按钮(.ant-btn.inline-link):不留内边距、不画底,11.5px,高 = 行(11.5 × 1.47)+ 透明的上下边各 1
    property bool inline: false
    property color textColor: !enabled ? Theme.labelTertiary
                            : kind === "primary" || kind === "dangerSolid" ? "#ffffff"
                            : kind === "danger" ? Theme.red
                            : kind === "text" ? Theme.blue : Theme.label
    signal clicked()
    readonly property bool active: enabled && !busy
    /// 左右内边距(可改:盘口墙卡片上的小按钮是 6,.sector-card .ant-btn-sm)
    property int padding: inline ? 0 : glass ? 16 : small ? 10 : 14
    /// 字号(情报时间线上「写进指令框」那颗是 11px)
    property real fontSize: inline ? 11.5 : small ? Theme.fontCaption : Theme.fontBody
    // AntD 的按钮都带 1px 的边(primary / text / 句子里的文字按钮都是透明的),算在宽高里:字 + 两边内边距 + 2
    implicitWidth: label.implicitWidth + 2 * padding + 2 + (busy ? 18 : 0)
    implicitHeight: inline ? Math.round(11.5 * 1.47 * 10) / 10 + 2 : glass ? 36 : small ? Theme.controlHeightSmall : Theme.controlHeight
    scale: mouse.pressed ? 0.97 : 1
    Behavior on scale { NumberAnimation { duration: 180; easing.type: Easing.OutBack } }

    Glass {
        visible: !root.inline
        anchors.fill: parent
        radius: height / 2
        edge: !root.enabled ? Theme.edgeNone : root.glass ? Theme.edgeSmall
            : (root.kind === "default" || root.kind === "danger") ? Theme.edgeControl : Theme.edgeNone
        border: !root.enabled ? Theme.separator : root.kind === "danger" ? Theme.red
              : (!root.glass && root.kind === "default") ? Theme.separator : "transparent"
        fill: !root.enabled ? Theme.bgFill
            : root.kind === "primary" ? (mouse.pressed ? Qt.darker(Theme.blue, 1.12) : Theme.blue)
            : root.kind === "dangerSolid" ? Theme.red
            : root.kind === "text" ? (mouse.containsMouse ? Theme.bgFill : "transparent")
            : root.glass ? (mouse.containsMouse ? Theme.bgControl : Theme.glassBg)
            : (mouse.pressed || mouse.containsMouse ? Theme.bgFillStrong : Theme.bgControl)
    }
    Row {
        anchors.centerIn: parent
        spacing: 6
        Spinner { visible: root.busy; anchors.verticalCenter: parent.verticalCenter; color: root.textColor }
        Label { css: 0;
            id: label
            anchors.verticalCenter: parent.verticalCenter
            size: root.fontSize
            family: Theme.fontFamily
            weight: root.kind === "primary" && root.enabled ? Theme.weightSemibold : Theme.weightMedium
            color: root.textColor
        }
    }
    MouseArea {
        id: mouse
        anchors.fill: parent
        hoverEnabled: true
        enabled: root.active
        // 按下就把焦点拿过来:输入框先失焦、先跑完它的 editingFinished(打完的数夹好、发出去),点击才执行——同浏览器里按下按钮先让输入框失焦
        onPressed: root.forceActiveFocus()
        onClicked: root.clicked()
    }

    component Spinner: Item {
        property color color
        width: 12; height: 12
        Rectangle {
            anchors.fill: parent
            radius: 6
            color: "transparent"
            border.width: 1.5
            border.color: Theme.tint(parent.color, 0.25)
        }
        Rectangle { width: 3; height: 3; radius: 1.5; x: 4.5; y: 0; color: parent.color }
        RotationAnimation on rotation { from: 0; to: 360; duration: 800; loops: Animation.Infinite; running: parent.visible }
    }
}
