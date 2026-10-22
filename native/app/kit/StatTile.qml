import QtQuick

// 数字瓦片(ui/kit 的 StatTile + .stat-tile):填充底、瓦片圆角、内边距 10 × 12;名 10.5px 二级色一行省略、下 2;数 17px 700 行高 1.3 数字等宽。
// mono:数用等宽字 15px 500(K 线读盘的子分)。tone:pos 涨色 / neg 跌色 / 空正文色。数放不下就折行(同浏览器;名那一行才省略)
Rectangle {
    id: root
    property string label: ""
    property string value: ""
    property string tone: ""
    property string tip: ""
    /// .stat-tile.mono:数用等宽字、15px、500
    property bool mono: false
    implicitHeight: 10 + labelL.implicitHeight + 2 + valueL.implicitHeight + 10
    radius: Theme.radiusTile
    color: Theme.bgFill
    Label { id: labelL; x: 12; y: 10; width: parent.width - 24; text: root.label; size: 10.5; color: Theme.labelSecondary; elide: Text.ElideRight }
    Label {
        id: valueL
        x: 12; y: 10 + labelL.implicitHeight + 2
        width: parent.width - 24
        // 正负号与「$」之间不让折行(Chromium 不在那里断;Qt 会,负号就单独留在上一行):中间夹一个 U+2060。.stat-tile 的数是 700
        text: root.value.replace(/([+−-])\$/g, "$1\u2060$"); size: root.mono ? 15 : 17; weight: root.mono ? 500 : 700; family: root.mono ? Theme.fontMono : Theme.fontDisplay
        css: 1.3; tnum: true; letterSpacing: root.mono ? -0.225 : -0.26; wrap: true
        color: root.tone === "pos" ? Theme.upText : root.tone === "neg" ? Theme.downText : Theme.label
    }
    Tip { text: root.tip }
}
