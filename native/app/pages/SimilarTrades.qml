import QtQuick
import Dafri.Kit

// 历史相似交易(lib/SimilarTrades.tsx):只读展示——数胜负、按出场方式分开、列几笔、带相关复盘。s = shell/trade_rules 的 similarModel
Column {
    id: root
    property var s: ({})
    width: parent ? parent.width : 400
    Hint { visible: root.s.kind !== "list"; width: parent.width; text: root.s.hint || ""; textFormat: Text.PlainText }
    Column {
        visible: root.s.kind === "list"
        width: parent.width
        Row {
            width: parent.width
            Label { text: root.s.head ? root.s.head.strong : ""; weight: Theme.weightBold; size: 13 }
            Label { text: root.s.head ? root.s.head.tally : ""; size: 13 }
            Label { text: root.s.head ? root.s.head.basis : ""; size: 11; color: Theme.labelSecondary; anchors.baseline: parent.children[0].baseline }
        }
        Hint { visible: !!root.s.exits; width: parent.width; text: root.s.exits || ""; textFormat: Text.PlainText }
        Column {
            width: parent.width
            topPadding: 4
            Repeater {
                model: root.s.items || []
                Row {
                    required property var modelData
                    width: parent.width
                    leftPadding: 16
                    Label { text: "•  "; size: 13 }
                    Label { text: modelData.text; size: 13; width: parent.width - 16 - 14 - (asideL.visible ? asideL.implicitWidth : 0); wrap: true; tnum: true }
                    Label { id: asideL; visible: !!modelData.aside; text: modelData.aside || ""; size: 11; color: Theme.labelSecondary; anchors.baseline: parent.children[1].baseline }
                }
            }
        }
        Label { visible: !!(root.s.lessons && root.s.lessons.length); text: "相关复盘:"; size: 13 }
        Column {
            visible: !!(root.s.lessons && root.s.lessons.length)
            width: parent.width
            Repeater {
                model: root.s.lessons || []
                Row {
                    required property var modelData
                    width: parent.width
                    leftPadding: 16
                    Label { text: "•  "; size: 13 }
                    Label { text: modelData; size: 13; width: parent.width - 30; wrap: true }
                }
            }
        }
    }
}
