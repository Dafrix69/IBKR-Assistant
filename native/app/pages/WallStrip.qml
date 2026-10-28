import QtQuick
import Dafri.Kit

// 下单页上的 SPX / QQQ 期权墙(shell/wall_store):一个标的一段——标的、到期、现价,各道墙离现价多远,最后一行灰字是取于几点、取了哪一段。
// 只看不拦单;挂上 / 卸下告诉 store,只在这一页挂着时刷新。贴着现价(0.25% 以内)的墙是橙字。
Column {
    id: root
    property var store: null
    readonly property var rows: store ? store.rows : []
    width: parent ? parent.width : 0
    spacing: 6
    bottomPadding: 12
    Component.onCompleted: if (store) store.setVisible(true)
    Component.onDestruction: if (store) store.setVisible(false)

    Repeater {
        model: root.rows
        Column {
            id: block
            required property var modelData
            width: root.width
            spacing: 2
            WrapRow {
                width: parent.width
                columnSpacing: 14
                rowSpacing: 2
                Label { text: block.modelData.symbol; size: 12; weight: Theme.weightHeavy; color: Theme.labelSecondary }
                Label { visible: !!block.modelData.expiry; text: "到期 " + block.modelData.expiry; size: 12; tnum: true; color: Theme.labelSecondary }
                Label { text: block.modelData.spot; size: 12; tnum: true; weight: Theme.weightMedium }
                Repeater {
                    model: block.modelData.items
                    Label {
                        required property var modelData
                        text: modelData.text; size: 12; tnum: true
                        color: modelData.tone === "near" ? Theme.orangeText : Theme.label
                        Tip { text: modelData.tip || "" }
                    }
                }
                Label { visible: !block.modelData.items.length && !!block.modelData.note; text: block.modelData.note; size: 12; color: Theme.labelSecondary }
            }
            Label {
                visible: !!block.modelData.items.length && !!block.modelData.note
                width: parent.width; wrap: true
                text: block.modelData.note; size: 11; color: Theme.labelSecondary
            }
            Label {
                visible: !!block.modelData.failure
                width: parent.width; wrap: true
                text: block.modelData.failure; size: 11; color: Theme.orangeText
            }
        }
    }
    Rectangle { width: parent.width; height: 0.5; color: Theme.separator }
}
