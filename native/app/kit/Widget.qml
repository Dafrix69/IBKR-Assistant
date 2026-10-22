import QtQuick

// 小组件瓦片(graphics.tsx 的 Widget + .widget):卡片面、卡片影、20 圆角、内边距 14 × 16;左上一枚 30 的淡图标瓦片(灰底着色线稿),
// 下面一个大数(26px 750 行高 1.1)和它的名字(11.5px 二级色);竖排间距 2,图标那一行下 8
Glass {
    id: root
    property string icon: ""
    property string tint: "blue"
    property string value: ""
    property string label: ""
    radius: Theme.radiusCard
    fill: Theme.bgElevated
    edge: Theme.edgeCard
    implicitHeight: 14 + 30 + 8 + 2 + num.implicitHeight + 2 + sub.implicitHeight + 14
    Rectangle {
        x: 16; y: 14
        width: 30; height: 30; radius: Math.round(30 * 0.29)
        color: Theme.bgFill
        Icon { anchors.centerIn: parent; name: root.icon; size: Math.round(30 * 0.62); color: Theme.tintOf(root.tint) }
    }
    Label { id: num; x: 16; y: 14 + 30 + 8 + 2; text: root.value; size: 26; weight: Theme.weightHeavy; family: Theme.fontDisplay; css: 1.1; tnum: true; letterSpacing: -0.52 }
    Label { id: sub; x: 16; y: num.y + num.implicitHeight + 2; text: root.label; size: 11.5; color: Theme.labelSecondary; tnum: true }
}
