import QtQuick
import QtCore

// 参考资料(ui/kit 的 Primer):一行三级色 11.5px 的字 + 折叠箭头,不是一个盒子;点开下面是说明。
// 手动点过一次就记住(React 版 localStorage 的 dafri-primer-<id>,这里是 Settings 的 primer/<id>)。
// intro: false 是另一种(连接指引、蝴蝶测算的「更多」、日内剧本的说明):一颗填充底的小按钮(5 × 10、发丝边、控件圆角、二级色 510),
// 点开的说明离它 10;上边距 16 由调用的地方给(各页覆盖的不一样)
Column {
    id: root
    property string id_: ""
    property string summary: ""
    property bool intro: true
    /// 没手动点过时开不开(盘口墙的「读盘常识」:还没关注任何标的时默认展开)
    property bool defaultOpen: false
    readonly property string saved: store.value("primer/" + id_, "")
    property bool open: saved === "" ? defaultOpen : saved === "1"
    default property alias content: body.data
    topPadding: 4
    bottomPadding: 12
    spacing: 0
    Settings { id: store }
    Rectangle {
        // intro:没有框,上下各 2;不是 intro:按钮(内边距 5 × 10 + 0.5 的边)
        readonly property real padX: root.intro ? 0 : 10.5
        readonly property real padY: root.intro ? 2 : 5.5
        width: row.implicitWidth + 2 * padX; height: padY + summaryText.implicitHeight + padY
        radius: Theme.radiusControl
        color: root.intro ? "transparent" : hover.hovered ? Theme.bgFillStrong : Theme.bgFill
        border.width: root.intro ? 0 : 0.5
        border.color: Theme.separator
        // AntD 折叠头:箭头那一格 12 宽、右边再空 8(量的 React 版:标题从 20 起)
        Row {
            id: row
            x: parent.padX
            y: parent.padY
            spacing: 0
            // 箭头那一格:intro 量的是字从 20 起;按钮里量的是从 20(0.5 的边 + 10 的内边距之后)
            Item {
                width: 20; height: summaryText.implicitHeight
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "›"
                    rotation: root.open ? 90 : 0
                    color: summaryText.color
                    font.pixelSize: 12; font.family: Theme.fontFamily
                    Behavior on rotation { NumberAnimation { duration: 150 } }
                }
            }
            Label {
                id: summaryText
                text: root.summary
                size: 11.5
                weight: root.intro ? Font.Normal : Theme.weightMedium
                color: root.intro ? (hover.hovered ? Theme.labelSecondary : Theme.labelTertiary) : (hover.hovered ? Theme.label : Theme.labelSecondary)
            }
        }
        HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
        TapHandler {
            onTapped: { root.open = !root.open; store.setValue("primer/" + root.id_, root.open ? "1" : "0") }
        }
    }
    Column {
        id: body
        visible: root.open
        width: parent.width
        topPadding: root.intro ? 6 : 10
    }
}
