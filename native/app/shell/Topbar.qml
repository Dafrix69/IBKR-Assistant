import QtQuick
import Dafri.Kit

// 统一工具栏(React 版 shell/Topbar.tsx + styles.css 的 .topbar):栏本身透明、可以拖动窗口,上面浮着几组玻璃胶囊。
//   品牌:应用标 + 右下角的引擎圆点 + 名字;
//   状态胶囊:券商 / 模式 / 实盘闸门 / 市场时段 / 模型,每一格写什么由 C++ 算(topbar_state.cpp),这里只摆;
//   右侧:新版本(有更新的正式版、且没被忽略时才有)、连接 / 断开、暂停自动执行 / 解除熔断。
// 尺寸照 styles.css:栏高 52、左右 12(macOS 左边让出 88 给红绿灯)、胶囊 36 高、格间 12、按钮 36 高左右 16。
Item {
    id: root
    property var topbarState: ({})   // StatusStore.topbar(不叫 state:那是 Item 自带的属性)
    property bool busy: false
    /// UpdateStore.badge:有更新的正式版、没忽略这一版时是那份检查结果,否则 null
    property var update: null
    /// macOS 上内容铺进了标题栏:左边让出红绿灯(全屏时红绿灯收起,不让)
    property int leadingInset: 12
    signal connectClicked()
    signal breakerClicked()
    signal updateClicked()
    height: 52

    function dotState(tone) { return tone === "bad" ? "bad" : tone === "warn" ? "warn" : tone === "ok" ? "ok" : "idle" }

    // 空白处拖动窗口、双击缩放(同 macOS 的标题栏)
    TapHandler {
        onDoubleTapped: { var w = root.Window.window; if (w) w.visibility = w.visibility === Window.Maximized ? Window.Windowed : Window.Maximized }
    }
    DragHandler {
        target: null
        onActiveChanged: if (active && root.Window.window) root.Window.window.startSystemMove()
    }

    Row {
        id: lead
        anchors.verticalCenter: parent.verticalCenter
        anchors.left: parent.left
        anchors.leftMargin: root.leadingInset
        spacing: 10

        // 品牌
        Row {
            anchors.verticalCenter: parent.verticalCenter
            spacing: 8
            Item {
                width: 24; height: 24
                anchors.verticalCenter: parent.verticalCenter
                Icon { name: "app-mark"; tinted: false; size: 24 }
                Rectangle {
                    readonly property string tone: (root.topbarState.engine || {}).tone || "idle"
                    x: 24 - 9 + 2; y: 24 - 9 + 2
                    width: 9; height: 9; radius: 4.5
                    border.width: 2
                    border.color: Theme.bgWindow
                    color: tone === "ok" ? Theme.green : tone === "bad" ? Theme.red : Theme.gray
                }
                Tip { text: (root.topbarState.engine || {}).tip || "" }
            }
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: "Datrix"
                font.pixelSize: Theme.fontBody; font.weight: Theme.weightBold; font.letterSpacing: -0.13
                font.family: Theme.fontFamily; color: Theme.label
            }
        }

        // 状态胶囊:窄窗口下按重要性整颗丢:模型(<1180)、时钟(<1020)
        Glass {
            id: capsule
            anchors.verticalCenter: parent.verticalCenter
            height: 36
            width: chips.implicitWidth + 28
            radius: 18
            edge: Theme.edgeSmall
            Row {
                id: chips
                x: 14
                anchors.verticalCenter: parent.verticalCenter
                spacing: 12
                Chip { key: "broker" }
                Chip { key: "mode" }
                Chip { key: "live"; strong: !!(root.topbarState.live || {}).on }
                Chip { key: "market"; visible: root.width > 1020 }
                Text {
                    visible: root.width > 1180
                    anchors.verticalCenter: parent.verticalCenter
                    text: (root.topbarState.model || {}).text || ""
                    color: modelHover.hovered ? Theme.labelSecondary : Theme.labelTertiary
                    font.pixelSize: Theme.fontCaption; font.family: Theme.fontFamily
                    HoverHandler { id: modelHover }
                    Tip { text: (root.topbarState.model || {}).tip || "" }
                }
            }
        }
    }

    Row {
        anchors.verticalCenter: parent.verticalCenter
        anchors.right: parent.right
        anchors.rightMargin: 12
        spacing: 8
        // 点进「关于」看说明、下载或忽略这一版。不用彩色填充——它不比熔断重要(shell.css 的 .update-pill:只是字着强调色)
        Button {
            visible: !!root.update
            glass: true
            textColor: Theme.accent
            text: root.update ? "新版本 " + root.update.latest : ""
            onClicked: root.updateClicked()
            Tip { text: root.update ? "新版本 " + root.update.latest + " 已发布,点开看更新内容" : "" }
        }
        Button {
            glass: true
            text: root.topbarState.connectLabel || "连接 TWS"
            busy: root.busy
            onClicked: root.connectClicked()
        }
        Button {
            glass: !root.topbarState.breakerEngaged
            kind: root.topbarState.breakerEngaged ? "dangerSolid" : "default"
            text: root.topbarState.breakerLabel || "暂停自动执行"
            enabled: !root.busy
            onClicked: root.breakerClicked()
            Tip { text: (Qt.platform.os === "osx" ? "⌘⇧H" : "Ctrl+Shift+H") }
        }
    }

    // 一格状态:圆点 + 12px 的字;实盘开着时字是红的、加粗(shell.css 的 .chip-live.on)
    component Chip: Item {
        id: chip
        property string key
        property bool strong: false
        readonly property var c: root.topbarState[key] || ({})
        anchors.verticalCenter: parent.verticalCenter
        width: visible ? row.implicitWidth : 0
        height: row.implicitHeight
        Row {
            id: row
            spacing: 6
            Dot { anchors.verticalCenter: parent.verticalCenter; state: root.dotState(chip.c.tone); idleColor: Theme.labelTertiary }
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: chip.c.text || ""
                color: chip.strong ? Theme.redText : Theme.label
                font.pixelSize: Theme.fontCaption; font.family: Theme.fontFamily
                font.weight: chip.strong ? Theme.weightBold : Font.Normal
                font.features: { "tnum": 1 }
            }
        }
        Tip { text: chip.c.tip || "" }
    }
}
