import QtQuick

// 代码徽章(graphics.tsx 的 SymBadge):38 方、11 圆角、灰底,代码取前 5 个字符;超过 4 个的小一号
// small(.sym-badge.sm):30 方、9 圆角、字一律 10px(交易记录的表里)
Rectangle {
    property string symbol: ""
    property bool small: false
    readonly property string shown: symbol.slice(0, 5)
    width: small ? 30 : 38; height: width; radius: small ? 9 : 11
    color: Theme.bgFill
    Label {
        css: 0
        anchors.centerIn: parent
        text: parent.shown
        color: Theme.labelSecondary
        size: parent.small || parent.shown.length > 4 ? 10 : 11.5
        weight: Theme.weightHeavy; family: Theme.fontDisplay
        letterSpacing: -0.02 * size
    }
}
