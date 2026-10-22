import QtQuick

// 卡片(AntD Card + theme/antd.ts):卡片面(--bg-elevated)+ 1px 发丝边 + --shadow-card,20 圆角,内边距 16。
// 卡片是内容,不是玻璃:没有高光
Glass {
    padding: 16
    implicitWidth: contentItem.childrenRect.width + 2 * padding
    implicitHeight: contentItem.childrenRect.height + 2 * padding
    radius: Theme.radiusCard
    fill: Theme.bgElevated
    edge: Theme.edgeCard
    border: Theme.separator
}
