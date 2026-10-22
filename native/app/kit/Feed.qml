import QtQuick

// 通知流(ui/kit 的 Feed + .feed;一条是 AntD List.Item:flex、竖直居中,折行时时刻在两行中间):最高 230、超出滚动;一条:5 × 9 内边距、间距 8、6 圆角、11.5px 二级色,单数行填充底;时刻三级色等宽。
// 空的时候是 AntD List 的空态(上下 16 的内边距)里一个小号空态(图 22、内 4;空态那一块离上下各 18)
Item {
    id: root
    property var model: null
    property string empty: ""
    readonly property int count: model ? (model.count !== undefined ? model.count : model.length) : 0
    // 空态:量的 React 版是空态那一块离上下各 18(列表空态的 16 + 小号空态外边距并进去的 2),整块 87.6
    implicitHeight: count === 0 ? 16 + emptyState.implicitHeight - 2 + 16 : Math.min(230, col.implicitHeight)
    clip: true
    EmptyState { id: emptyState; visible: root.count === 0; y: 16; width: parent.width; topMargin: 2; compact: true; text: root.empty }
    Flickable {
        visible: root.count > 0
        anchors.fill: parent
        contentHeight: col.implicitHeight
        boundsBehavior: Flickable.StopAtBounds
        Column {
            id: col
            width: parent.width
            Repeater {
                model: root.model
                Rectangle {
                    required property int index
                    required property var modelData
                    readonly property var item: modelData && modelData.at !== undefined ? modelData : ({ at: model.at, text: model.text })
                    width: col.width
                    height: 5 + Math.max(timeL.implicitHeight, textL.implicitHeight) + 5
                    radius: 6
                    color: index % 2 === 0 ? Theme.bgFill : "transparent"
                    Label { id: timeL; x: 9; y: (parent.height - implicitHeight) / 2; text: parent.item.at; size: 11.5; family: Theme.fontMono; color: Theme.labelTertiary }
                    Label { id: textL; x: 9 + timeL.implicitWidth + 8; y: 5; width: parent.width - x - 9; wrap: true; text: parent.item.text; size: 11.5; color: Theme.labelSecondary }
                }
            }
        }
    }
}
