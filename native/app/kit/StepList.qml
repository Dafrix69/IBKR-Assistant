import QtQuick

// 步骤列表(ui/kit 的 StepList,.guide 那一种:「连不上时照着做」、跟单的几步):左 4;每一步左边一颗 8 的三级色圆点(上 8),
// 离正文 16;步与步之间一条 1px 的竖线(从圆点下 14 到这一步底上 8,最后一步没有);标题 12.5px 510 行高 18,
// 说明 11.5px 正文色行高 1.55、下 12;每一步最矮 48。items:[{ title, detail }]
Column {
    id: root
    property var items: []
    Repeater {
        model: root.items
        Item {
            id: step
            required property var modelData
            required property int index
            readonly property bool last: index === root.items.length - 1
            width: root.width
            height: Math.max(48, body.implicitHeight)
            Rectangle { visible: !step.last; x: 4 + 2.5; y: 9 + 14; width: 1; height: Math.max(0, step.height - 9 - 14 - 8); radius: 0.5; color: Theme.separator }
            Rectangle { x: 3; y: 8 - 0.5; width: 8; height: 8; radius: 4; color: Theme.labelTertiary }
            Column {
                id: body
                x: 4 + 8 + 16
                width: step.width - x
                Label { width: Math.min(implicitWidth + 12, parent.width); wrap: true; text: step.modelData.title || ""; size: 12.5; weight: Theme.weightMedium; css: 18 }
                Label {
                    visible: step.modelData.detail !== undefined && step.modelData.detail !== null
                    width: parent.width; wrap: true; bottomPadding: 12
                    text: step.modelData.detail || ""; size: 11.5; css: 1.55
                }
            }
        }
    }
}
