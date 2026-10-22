import QtQuick

// 骨架屏(ui/kit 的 LoadingBlock:AntD Skeleton 不带头像与标题):几行填充底的圆角条,宽度错落;上 6 下 14,每行 16 高、行距 16
Column {
    property int rows: 2
    topPadding: 6; bottomPadding: 14
    spacing: 16
    Repeater {
        model: [0.62, 0.48, 0.54, 0.40, 0.58].slice(0, parent.rows)
        Rectangle { required property real modelData; width: parent.width * modelData; height: 16; radius: 4; color: Theme.bgFill }
    }
}
