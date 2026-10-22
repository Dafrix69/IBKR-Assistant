import QtQuick

// 滑杆(AntD Slider + theme/antd.ts;量的「设置 → Liquid Glass」):12 高的一条,中间 4 高的轨道(填充底、6 圆角),
// 已选的那段是强调色的浅色(浅色 #7ac8ff、深色 #11365b);把手是 10 的圆(控件面白 / 深色 #2a2a2e)外面一圈 2 的同色环,圆心落在值上。
// 值落到最近的一格(stepSize)。受控:value 只由外面给,拖动 / 点轨道只发 moved(新值),外面改了状态绑定送回来
Item {
    id: root
    property real from: 0
    property real to: 100
    property real stepSize: 1
    property real value: 0
    signal moved(real value)
    implicitWidth: 200
    implicitHeight: 12

    readonly property color trackColor: Theme.dark ? "#11365b" : "#7ac8ff"
    readonly property real ratio: to > from ? Math.max(0, Math.min(1, (value - from) / (to - from))) : 0

    function valueAt(x) {
        const raw = from + Math.max(0, Math.min(1, x / Math.max(1, width))) * (to - from)
        const snapped = stepSize > 0 ? from + Math.round((raw - from) / stepSize) * stepSize : raw
        return Math.max(from, Math.min(to, snapped))
    }
    function emitAt(x) {
        const v = valueAt(x)
        if (v !== root.value) root.moved(v)
    }

    Rectangle {
        y: 4; width: parent.width; height: 4; radius: 6
        color: Theme.bgFill
    }
    Rectangle {
        y: 4; width: parent.width * root.ratio; height: 4; radius: 6
        color: root.trackColor
    }
    // 把手:10 的圆 + 2 的环(box-shadow 0 0 0 2px)
    Rectangle {
        x: parent.width * root.ratio - 7; y: -1
        width: 14; height: 14; radius: 7
        color: root.trackColor
        Rectangle {
            anchors.centerIn: parent
            width: 10; height: 10; radius: 5
            color: Theme.dark ? "#2a2a2e" : "#ffffff"
        }
    }
    MouseArea {
        anchors.fill: parent
        anchors.topMargin: -4; anchors.bottomMargin: -4
        cursorShape: Qt.PointingHandCursor
        onPressed: function (e) { root.forceActiveFocus(); root.emitAt(e.x) }
        onPositionChanged: function (e) { if (pressed) root.emitAt(e.x) }
    }
    activeFocusOnTab: true
    Keys.onLeftPressed: root.moved(Math.max(from, value - stepSize))
    Keys.onRightPressed: root.moved(Math.min(to, value + stepSize))
}
