import QtQuick

// 悬停提示(AntD Tooltip + theme/antd.ts):深灰底 #3a3a3c、白字 11px、6 圆角、弹层投影,最宽 320。
// 放进要提示的那个元素里(铺满它),停 0.5 秒出现在它下方;气泡挂到窗口的根上,不被父级裁掉。
Item {
    id: root
    property string text: ""
    anchors.fill: parent
    HoverHandler { id: hover; enabled: root.text !== "" }
    Timer { id: delay; interval: 500; running: hover.hovered; onTriggered: bubble.show() }

    Glass {
        id: bubble
        parent: root.Window.window ? root.Window.window.contentItem : root
        z: 1000
        visible: false
        opacity: visible ? 1 : 0
        width: Math.min(320, label.implicitWidth + 16)
        height: label.implicitHeight + 10
        radius: 6
        fill: Theme.dark ? "#3a3a3e" : "#3a3a3c"
        edge: Theme.edgePopup
        function show() {
            if (!hover.hovered || root.text === "") return
            var p = root.mapToItem(parent, root.width / 2, root.height)
            x = Math.max(4, Math.min(parent.width - width - 4, p.x - width / 2))
            y = p.y + 6
            visible = true
        }
        Text {
            id: label
            x: 8; y: 5
            width: Math.min(implicitWidth, 304)
            text: root.text
            textFormat: Text.PlainText  // 提示里常是引擎或用户的字(账户名、报错):不当标签解析
            wrapMode: Text.Wrap
            color: "#ffffff"
            font.pixelSize: Theme.fontSmall
            font.family: Theme.fontFamily
        }
    }
    Connections { target: hover; function onHoveredChanged() { if (!hover.hovered) bubble.visible = false } }
}
