import QtQuick

// 阶段路径(graphics.tsx 的 StagePath):一排圆点 + 段名,中间 18 × 2 的连线(左右各 6,连线是后一段的 ::before,后面还有 5 的间距);走过的点与线着色,当前那一步再加一圈 3.5 的淡色晕、字正文色 590;
// 没走到的点与线是深一档的填充色、字三级色;走过的字二级色。11px
Row {
    id: root
    property var stages: []
    property int current: 0
    property color tone: Theme.blue
    spacing: 0
    Repeater {
        model: root.stages
        Row {
            required property var modelData
            required property int index
            readonly property bool done: index < root.current
            readonly property bool now: index === root.current
            spacing: 0
            // 前一段的连线:前一步走过了才着色
            Item {
                visible: index > 0
                width: 35; height: 16
                Rectangle { x: 6; y: 7; width: 18; height: 2; radius: 1; color: index - 1 < root.current ? root.tone : Theme.bgFillStrong }
            }
            Item {
                width: 8; height: 16
                Rectangle { visible: now; anchors.centerIn: parent; width: 15; height: 15; radius: 7.5; color: Theme.tint(root.tone, 0.25) }
                Rectangle { anchors.centerIn: parent; width: 8; height: 8; radius: 4; color: done || now ? root.tone : Theme.bgFillStrong }
            }
            Item { width: 5; height: 1 }
            Label {
                text: modelData; size: 11
                weight: now ? Theme.weightSemibold : Font.Normal
                color: now ? Theme.label : done ? Theme.labelSecondary : Theme.labelTertiary
                anchors.verticalCenter: parent.verticalCenter
            }
        }
    }
}
