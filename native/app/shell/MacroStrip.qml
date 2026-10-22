import QtQuick
import Dafri.Kit

// 全局宏观行情带(React 版 shell/MacroStrip.tsx + styles.css 的 .macro-strip / .macro-item):公开数据,只读展示,不参与定价。
// 一排小玻璃瓦片(14 圆角、小号玻璃边),上面名字 + 读的是哪条行情,下面读数 + 着色的涨跌;有了 3 个读数之后右边多一根迷你走势。
// 一个数都没有时整条收起。每格写什么在 C++ 算好(shell/macro_store)。
Item {
    id: root
    property var store: null
    visible: !!store && !store.hidden
    implicitHeight: visible ? 2 + 46 + 10 : 0

    Flickable {
        anchors.fill: parent
        anchors.topMargin: 2
        anchors.bottomMargin: 10
        contentWidth: row.implicitWidth + 24
        flickableDirection: Flickable.HorizontalFlick
        boundsBehavior: Flickable.StopAtBounds
        clip: true
        Row {
            id: row
            x: 12
            spacing: 8
            Repeater {
                model: root.store ? root.store.rows : []
                delegate: Glass {
                    id: tile
                    readonly property var c: modelData
                    width: cells.implicitWidth + 22
                    height: 46
                    radius: Theme.radiusTile
                    edge: Theme.edgeSmall
                    Row {
                        id: cells
                        x: 11
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.verticalCenterOffset: -0.5
                        spacing: 8
                        Column {
                            anchors.verticalCenter: parent.verticalCenter
                            spacing: 0
                            Row {
                                spacing: 4
                                Label { css: 0;
                                    id: label
                                    text: tile.c.label
                                    color: Theme.labelSecondary
                                    size: 10.5; weight: Theme.weightMedium; family: Theme.fontFamily
                                }
                                Text {
                                    visible: tile.c.inst !== ""
                                    anchors.baseline: label.baseline
                                    text: tile.c.inst
                                    color: Theme.labelTertiary
                                    font.pixelSize: 9; font.family: Theme.fontMono
                                }
                                Label { css: 0;
                                    visible: tile.c.stale
                                    anchors.baseline: label.baseline
                                    text: "旧"
                                    color: Theme.labelSecondary
                                    size: 9.5; italic: true; family: Theme.fontFamily
                                }
                            }
                            Row {
                                spacing: 6
                                Row {
                                    anchors.verticalCenter: parent.verticalCenter
                                    spacing: 4
                                    Label { css: 0;
                                        text: tile.c.value
                                        color: Theme.label
                                        size: 13.5; weight: Font.Bold; letterSpacing: -0.135
                                        family: Theme.fontFamily; tnum: true
                                    }
                                    // 走 TWS 流式的那几格:读数后面一个 4px 的绿点
                                    Rectangle { visible: tile.c.live; anchors.verticalCenter: parent.verticalCenter; width: 4; height: 4; radius: 2; color: Theme.green }
                                }
                                Row {
                                    visible: tile.c.dir !== ""
                                    anchors.verticalCenter: parent.verticalCenter
                                    spacing: 3
                                    readonly property color tone: tile.c.dir === "up" ? Theme.upText : tile.c.dir === "down" ? Theme.downText : Theme.labelSecondary
                                    // 涨是朝上的小三角、跌朝下,平的没有
                                    Canvas {
                                        visible: tile.c.dir !== "flat"
                                        anchors.verticalCenter: parent.verticalCenter
                                        width: 7; height: 5
                                        property color tone: parent.tone
                                        property bool up: tile.c.dir === "up"
                                        onToneChanged: requestPaint()
                                        onUpChanged: requestPaint()
                                        onPaint: {
                                            var ctx = getContext("2d"); ctx.reset(); ctx.beginPath()
                                            if (up) { ctx.moveTo(0, 5); ctx.lineTo(3.5, 0); ctx.lineTo(7, 5) } else { ctx.moveTo(0, 0); ctx.lineTo(3.5, 5); ctx.lineTo(7, 0) }
                                            ctx.closePath(); ctx.fillStyle = tone; ctx.fill()
                                        }
                                    }
                                    Text {
                                        text: tile.c.chg
                                        color: parent.tone
                                        font.pixelSize: Theme.fontSmall; font.weight: Theme.weightSemibold; font.family: Theme.fontFamily
                                        font.features: { "tnum": 1 }
                                    }
                                }
                            }
                        }
                        Sparkline {
                            visible: tile.c.trail.length >= 3
                            anchors.verticalCenter: parent.verticalCenter
                            width: visible ? 44 : 0; height: 20
                            values: tile.c.trail
                            tint: tile.c.tint === "down" ? Theme.down : tile.c.tint === "up" ? Theme.up : Theme.gray
                        }
                    }
                    Tip { text: tile.c.tip }
                }
            }
        }
    }
}
