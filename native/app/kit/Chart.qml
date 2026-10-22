import QtQuick

// 图表(lib/Chart.tsx 的 CanvasChart + styles.css 的 .chart-host / .chart-legend / .chart-empty):
//   · 图区底色 --chart-bg、8 圆角;框、线、蜡烛由 ChartView(C++,shell/chart_scale 算帧)画;
//   · 轴上的刻度、轴上的价格标签、叠加层的字是子项 Label(同一套字宽,--dump-texts 量得到);
//   · 顶部读数(DOM):左 10、右 72、上 2,11px、行高 17,一行不折、项间 12、二级色、等宽数字;第一行 header(有的话),
//     第二行十字光标停着时是那一根的读数,不然是图例(字形着色、右边空 3);
//   · 太窄 / 数据不足:图与读数藏起来,中间一句 11px 三级色。
// source:页面 controller 给的 ChartSource;wheel:滚轮缩放(嵌在长页面里的小图别开)
Rectangle {
    id: root
    property alias source: view.source
    property alias wheel: view.wheel
    readonly property alias view: view
    radius: 8
    color: Theme.chartBg
    clip: true

    ChartView {
        id: view
        anchors.fill: parent
        visible: notice === ""
        colors: ({
            up: Theme.chartUp, down: Theme.chartDown, blue: Theme.blue, orange: Theme.orange, purple: Theme.purple,
            label: Theme.label, label2: Theme.labelSecondary, label3: Theme.labelTertiary, separator: Theme.separator
        })
    }

    // 轴上与图里的字:x 是对齐点、y 是字的竖直中心(画布的 textBaseline = middle)
    Item {
        anchors.fill: parent
        visible: view.notice === ""
        Repeater {
            model: view.texts
            delegate: axisText
        }
        // 十字光标的两个标签:单独一组,指针一动只重建这两个
        Repeater {
            model: view.crossTexts
            delegate: axisText
        }
        Component {
            id: axisText
            Label {
                required property var modelData
                css: 0
                text: modelData.text
                size: modelData.px
                weight: modelData.bold ? 700 : Font.Normal
                color: modelData.color
                x: modelData.align === "center" ? modelData.x - implicitWidth / 2 : modelData.align === "right" ? modelData.x - implicitWidth : modelData.x
                y: modelData.y - implicitHeight / 2
            }
        }
    }

    // 顶部读数(.chart-legend)
    Column {
        visible: view.notice === ""
        x: 10; y: 2
        width: parent.width - 10 - 72
        Row {
            visible: view.hasHeader
            width: parent.width
            height: 17
            clip: true
            spacing: 12
            Repeater {
                model: view.headerRow
                Label { required property var modelData; text: modelData.text; color: modelData.color; size: 11; css: 17; tnum: true }
            }
        }
        Row {
            width: parent.width
            height: 17
            clip: true
            spacing: 12
            Repeater {
                model: view.readoutRow
                Label { required property var modelData; text: modelData.text; color: modelData.color; size: 11; css: 17; tnum: true }
            }
            Repeater {
                model: view.readoutRow.length ? [] : view.legendRow
                Row {
                    required property var modelData
                    spacing: 3
                    Label { text: parent.modelData.glyph; color: parent.modelData.color; size: 11; css: 17 }
                    Label { text: parent.modelData.text; color: Theme.labelSecondary; size: 11; css: 17; tnum: true }
                }
            }
        }
    }

    Label {
        visible: view.notice !== ""
        anchors.centerIn: parent
        text: view.notice
        size: 11
        color: Theme.labelTertiary
    }
}
