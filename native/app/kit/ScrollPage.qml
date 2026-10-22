import QtQuick
import QtQuick.Effects

// 内容区(.content):上 6、左右 28、下 40 的留白,竖向滚动。页面往 content 里放一列东西。
// 页面大标题(PageHead)吸在顶上(.page-head 的 position: sticky; top: -6px):它把自己的那一条挪到这里的 stickyLayer 上——
// 那一层不跟着内容滚,所以背后那块玻璃能拿内容现画模糊,不会把标题自己也拍进去
Flickable {
    id: root
    default property alias content: col.data
    property alias column: col
    /// 内容最宽多少(设置、关于、接入三页是 880:#page-settings, #page-about, #page-access { max-width: 880px })
    property real maxWidth: Infinity
    /// 吸顶的那一条放在这里(PageHead 自己找过来)
    readonly property Item stickyLayer: layer
    clip: true
    contentWidth: width
    contentHeight: col.implicitHeight + 6 + 40
    boundsBehavior: Flickable.StopAtBounds
    Column {
        id: col
        x: 28; y: 6
        width: Math.min(root.width - 56, root.maxWidth)
    }
    Item {
        id: layer
        parent: root
        z: 10
        width: root.width
        height: childrenRect.height
    }
    /// 把某个子项滚到视线中间(scrollIntoView({ block: "center" }))
    function reveal(item) {
        if (!item) return
        var p = item.mapToItem(col, 0, 0)
        var target = p.y + 6 + item.height / 2 - height / 2
        contentY = Math.max(0, Math.min(target, contentHeight - height))
    }
}
