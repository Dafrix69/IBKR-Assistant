import QtQuick
import QtQuick.Layouts
import Dafri.Kit

// 条款同意页。两种出场:还没同意现行条款:挡住整个界面,同意才能用,不同意就退出;从「关于 → 查看条款」点开重看:只有「关闭」。
// 为什么挡住整个界面而不是只挡发单:风险揭示要在人开始依赖这个软件之前看到。钱路径 Bridge 另外挡着。
Rectangle {
    id: root
    property var model: null
    property var seen: ({ risk: true })
    property string tab: "risk"
    property bool read: false
    readonly property bool must: model ? !model.accepted : false
    visible: model !== null && (must || model.viewing)
    color: Theme.tint("#000000", 0.32)
    MouseArea { anchors.fill: parent }   // 挡住底下的点击

    readonly property bool allSeen: model ? model.docs.every(function (d) { return !!seen[d.key] }) : false

    Rectangle {
        anchors.centerIn: parent
        width: Math.min(760, root.width - 40)
        height: Math.min(640, root.height - 40)
        radius: Theme.radiusCard
        color: Theme.bgPopup
        border.width: 1; border.color: Theme.separator
        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 20
            spacing: 12
            Text { text: root.must ? "开始之前:请阅读并确认" : "条款"; font.pixelSize: Theme.fontLarge; font.weight: Font.DemiBold; color: Theme.label; font.family: Theme.fontFamily }
            Text {
                visible: root.must
                Layout.fillWidth: true; wrapMode: Text.Wrap
                text: "这个软件会把你的指令变成真实的订单。用它之前,有三份不长的文本需要你看一遍:它会在什么情况下出错、责任怎么划分、你的数据去了哪里。"
                color: Theme.labelSecondary; font.pixelSize: Theme.fontBody; font.family: Theme.fontFamily
            }
            Segmented {
                options: root.model ? root.model.docs.map(function (d) { return { value: d.key, label: d.title } }) : []
                value: root.tab
                onActivated: function (v) { root.tab = v; var s = Object.assign({}, root.seen); s[v] = true; root.seen = s }
            }
            Flickable {
                id: flick
                Layout.fillWidth: true
                Layout.fillHeight: true
                contentHeight: doc.implicitHeight
                clip: true
                // 正文是 C++ 照 Electron 的 docParse 切块拼好的富文本(shell/doc_parse):文字都转义过,标签只有那几种
                Text {
                    id: doc
                    width: flick.width - 12
                    wrapMode: Text.Wrap
                    textFormat: Text.RichText
                    lineHeight: 1.3
                    color: Theme.label; font.pixelSize: Theme.fontBody; font.family: Theme.fontFamily
                    text: { if (!root.model) return ""; var d = root.model.docs.filter(function (x) { return x.key === root.tab })[0]; return d ? d.html : "" }
                    onTextChanged: flick.contentY = 0
                }
            }
            Text {
                text: "条款版本 " + (root.model && root.model.version ? root.model.version : "读不出来")
                    + (root.model && root.model.acceptedAt ? " · 已于 " + root.model.acceptedAt + " 同意" : "")
                color: Theme.labelTertiary; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily
            }
            Row {
                spacing: 10
                visible: root.must
                Switch { checked: root.read; enabled: root.allSeen; onToggled: function (c) { root.read = c } }
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: root.allSeen ? "我已阅读并理解风险揭示、使用条款与隐私说明" : "三份文本都点开看过之后才能勾选"
                    color: Theme.label; font.pixelSize: Theme.fontBody; font.family: Theme.fontFamily
                }
            }
            Row {
                spacing: 8
                layoutDirection: Qt.RightToLeft
                Layout.fillWidth: true
                Button { visible: root.must; kind: "primary"; text: "同意并继续"; enabled: root.read && !!root.model && root.model.version !== ""; onClicked: root.model.accept() }
                Button { visible: root.must; text: "不同意,退出"; onClicked: root.model.decline() }
                Button { visible: !root.must; kind: "primary"; text: "关闭"; onClicked: root.model.hideTerms() }
                Text { visible: !!root.model && root.model.error !== ""; text: root.model ? root.model.error : ""; color: Theme.red; anchors.verticalCenter: parent.verticalCenter; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily }
            }
        }
    }
}
