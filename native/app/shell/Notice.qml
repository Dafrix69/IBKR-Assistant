import QtQuick
import Dafri.Kit

// 顶部通知(React 版 shell/Toasts.tsx:横幅改成 AntD notification,从窗口顶部中央落下来):
// 400 宽、实底(弹层不透明,字才压得住)、22 圆角、弹层投影、内边距 20 × 24、标题 13px 字重 510,左边 18 的状态图标,右上角关闭。
// 错误类留着等人看;关掉之后同一条下一轮还会再来(同 store/banner.ts)。
Item {
    id: root
    property string text: ""
    property bool info: false
    signal closed()
    width: 400
    height: card.height
    visible: text !== ""
    opacity: visible ? 1 : 0
    Behavior on opacity { NumberAnimation { duration: Theme.durationSlow } }

    Glass {
        id: card
        width: parent.width
        height: Math.max(58, body.implicitHeight + 40)
        radius: 22
        fill: Theme.bgPopup
        edge: Theme.edgePopup
        // 状态图标:红底白叉 / 蓝底白 i
        Rectangle {
            x: 24; y: 21
            width: 18; height: 18; radius: 9
            color: root.info ? Theme.blue : Theme.red
            Text {
                anchors.centerIn: parent
                text: root.info ? "i" : "✕"
                color: "#ffffff"
                font.pixelSize: root.info ? 12 : 10; font.weight: Theme.weightBold; font.family: Theme.fontFamily
            }
        }
        Text {
            id: body
            x: 24 + 18 + 12
            y: 20
            width: card.width - x - 48
            text: root.text
            textFormat: Text.PlainText  // 横幅常是引擎原样回的报错
            wrapMode: Text.Wrap
            color: Theme.label
            font.pixelSize: Theme.fontBody; font.weight: Theme.weightMedium; font.family: Theme.fontFamily
        }
        Text {
            id: close
            anchors.right: parent.right; anchors.rightMargin: 20
            y: 18
            text: "✕"
            color: closeHover.hovered ? Theme.label : Theme.labelSecondary
            font.pixelSize: 13; font.family: Theme.fontFamily
            HoverHandler { id: closeHover }
            TapHandler { onTapped: root.closed() }
        }
    }
}
