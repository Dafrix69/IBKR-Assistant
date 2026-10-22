import QtQuick

// 状态卡片(ui/kit 的 StatusCard + AntD 的小号 Card):卡片面 + 发丝边 + 卡片影,20 圆角;
// 头 14 × 16(标题 14px 字重 650,前面按状态一枚 16px 圆标,info 不加;右边 extra),身 6 / 16 / 16。
// flash:刚建好的那张外圈闪一下强调色(.just-added)
Card {
    id: root
    property string tone: "info"   // info | ok | warn | bad
    property string title: ""
    property bool flash: false
    /// 标题的字(想法卡片的标题是等宽 12px 590 的代码,.record-sym);行高还是 21
    property string titleFamily: Theme.fontFamily
    property real titleSize: 14
    property int titleWeight: Theme.weightBold
    default property alias body: bodyCol.data
    property alias extra: extraBox.data
    padding: 0
    // 量的(AntD 小号 Card):1px 边、头上 14、标题一行 21(头的下边 -1 压在身上)、身上 6 下 16、再 1px 边 → 高 = 41 + 内容 + 17。
    // 带状态圆标(ok / warn / bad)的那一行被 16px 的图标撑到 24 高(验收在浏览器里量的:头 38 对 35),身从 45 起
    // 右边 extra 比标题高(小号按钮 24)时头跟着撑高(量的:带「刷新」按钮的盘口卡片头 38,别的 35)
    readonly property real headH: Math.max(root.tone !== "info" ? 24 : 21, extraBox.childrenRect.height)
    readonly property real bodyY: root.title !== "" ? 20 + headH : 7
    implicitHeight: root.bodyY + bodyCol.implicitHeight + 17
    Item {
        id: head
        x: 17; y: 15
        width: root.width - 34
        height: root.headH
        visible: root.title !== ""
        Row {
            spacing: 6
            anchors.verticalCenter: parent.verticalCenter
            width: parent.width - extraBox.childrenRect.width - 8
            // 图标的格子 16(AntD 图标 1em),画出来的圆 14
            Item {
                visible: root.tone !== "info"
                width: 16; height: 16
                anchors.verticalCenter: parent.verticalCenter
                Rectangle {
                    anchors.centerIn: parent
                    width: 14; height: 14; radius: 7
                    color: root.tone === "ok" ? Theme.green : root.tone === "warn" ? Theme.orange : Theme.red
                    Text {
                        anchors.centerIn: parent
                        text: root.tone === "ok" ? "✓" : root.tone === "warn" ? "!" : "×"
                        color: "#ffffff"; font.pixelSize: 10; font.weight: Theme.weightHeavy; font.family: Theme.fontFamily
                    }
                }
            }
            Label {
                text: root.title
                width: parent.width - (root.tone !== "info" ? 22 : 0)
                elide: Text.ElideRight
                size: root.titleSize; weight: root.titleWeight; family: root.titleFamily; css: 21 / root.titleSize
            }
        }
        Item {
            id: extraBox
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            width: childrenRect.width; height: childrenRect.height
        }
    }
    Column {
        id: bodyCol
        x: 17
        y: root.bodyY
        width: root.width - 34
    }
    Rectangle {
        anchors.fill: parent
        radius: Theme.radiusCard
        color: "transparent"
        border.width: 2
        border.color: Theme.accent
        opacity: 0
        SequentialAnimation on opacity {
            running: root.flash
            NumberAnimation { to: 1; duration: 1 }
            NumberAnimation { to: 0; duration: 1600; easing.type: Easing.OutCubic }
        }
    }
}
