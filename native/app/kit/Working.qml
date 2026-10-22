import QtQuick

// 行内的「正在做某事」(ui/kit 的 Working + .working):小圈(AntD 小号 Spin,14)+ 一句 12px 二级色的话,间距 7
Row {
    id: root
    property string text: ""
    spacing: 7
    Item {
        width: 14; height: 14
        anchors.verticalCenter: parent.verticalCenter
        Rectangle { anchors.fill: parent; radius: 7; color: "transparent"; border.width: 2; border.color: Theme.tint(Theme.accent, 0.2) }
        Rectangle { width: 4; height: 4; radius: 2; x: 5; y: 0; color: Theme.accent }
        RotationAnimation on rotation { from: 0; to: 360; duration: 1000; loops: Animation.Infinite; running: root.visible }
    }
    Label { text: root.text; size: 12; color: Theme.labelSecondary; anchors.verticalCenter: parent.verticalCenter }
}
