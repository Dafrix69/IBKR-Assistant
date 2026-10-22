import QtQuick
import QtQuick.Shapes
import Dafri.Kit

// 蝴蝶测算的盈亏曲线(lib/FlyPlanChart.tsx):横轴标的点位,纵轴每份净价;三条线——现在就到(橙虚线)、目标时刻到(蓝粗线)、到期时停在那儿(三级色)。
// 几何由 C++ 算(shell/fly_rules 的 chartModel,600 × 190 的坐标),横向拉伸、高固定 190;标签用 Text 叠上去不跟着拉伸。
// .fly-chart-plot:上 14 下 4;图例 11px 二级色、间距 4 × 14、下 6
Column {
    id: root
    property var m: null
    width: parent ? parent.width : 400
    readonly property real sx: m ? width / m.width : 1
    function pts(key) { return m ? m.points.map(function (p) { return Qt.point(p.x * root.sx, p[key]) }) : [] }
    function area() {
        if (!m) return []
        var a = pts("target")
        a.push(Qt.point(width, m.costY)); a.push(Qt.point(0, m.costY))
        return a
    }
    Item { width: 1; height: 14 }
    Item {
        id: plot
        width: root.width
        height: 190
        Item {
            width: parent.width; height: root.m ? root.m.costY : 0; clip: true
            Shape { preferredRendererType: Shape.CurveRenderer; width: plot.width; height: plot.height; ShapePath { strokeWidth: 0; fillColor: Theme.tint(Theme.up, 0.16); PathPolyline { path: root.area() } } }
        }
        Item {
            y: root.m ? root.m.costY : 0
            width: parent.width; height: parent.height - y; clip: true
            Shape { preferredRendererType: Shape.CurveRenderer; y: -parent.y; width: plot.width; height: plot.height; ShapePath { strokeWidth: 0; fillColor: Theme.tint(Theme.down, 0.12); PathPolyline { path: root.area() } } }
        }
        Shape {
            // 曲线渲染器:边缘抗锯齿(原版 SVG 是抗锯齿的);软件渲染下退回默认的
            preferredRendererType: Shape.CurveRenderer
            anchors.fill: parent
            ShapePath {
                strokeWidth: 1; strokeColor: Theme.labelTertiary; strokeStyle: ShapePath.DashLine; dashPattern: [3, 4]; fillColor: "transparent"
                startX: 0; startY: root.m ? root.m.costY : 0
                PathLine { x: root.width; y: root.m ? root.m.costY : 0 }
            }
            ShapePath { strokeWidth: 1.3; strokeColor: Theme.labelTertiary; fillColor: "transparent"; joinStyle: ShapePath.RoundJoin; PathPolyline { path: root.pts("expiry") } }
            ShapePath {
                strokeWidth: 1.5; strokeColor: Theme.orange; strokeStyle: ShapePath.DashLine; dashPattern: [5 / 1.5, 4 / 1.5]; fillColor: "transparent"; joinStyle: ShapePath.RoundJoin
                PathPolyline { path: root.pts("now") }
            }
            ShapePath { strokeWidth: 2.4; strokeColor: Theme.blue; fillColor: "transparent"; joinStyle: ShapePath.RoundJoin; PathPolyline { path: root.pts("target") } }
        }
        Repeater {
            model: root.m ? root.m.strikes : []
            Rectangle { required property var modelData; x: modelData.x * root.sx - 0.5; y: root.m.strikeY1; width: 1; height: root.m.strikeY2 - root.m.strikeY1; color: Theme.separator }
        }
        Rectangle {
            visible: !!(root.m && root.m.spot)
            x: root.m && root.m.spot ? root.m.spot.x * root.sx - 0.6 : 0
            y: root.m ? root.m.markY1 : 0
            width: 1.2; height: root.m ? root.m.markY2 - root.m.markY1 : 0
            color: Theme.labelSecondary
        }
        Rectangle {
            visible: !!(root.m && root.m.target)
            x: root.m && root.m.target ? root.m.target.x * root.sx - 0.8 : 0
            y: root.m ? root.m.markY1 : 0
            width: 1.6; height: root.m ? root.m.markY2 - root.m.markY1 : 0
            color: Theme.blue
        }
        // 标签(.fly-chart-labels:10.5px 数字等宽二级色)
        Repeater {
            model: root.m ? root.m.strikes : []
            Label { required property var modelData; x: modelData.left * root.width - contentWidth / 2; y: plot.height - height; text: modelData.label; size: 10.5; family: Theme.fontMono; tnum: true; color: Theme.labelSecondary }
        }
        Mark { visible: !!(root.m && root.m.spot); spec: root.m ? root.m.spot : null; fill: Theme.labelSecondary }
        Mark { visible: !!(root.m && root.m.target); spec: root.m ? root.m.target : null; fill: Theme.blue; topY: -4 }
        Label {
            visible: !!root.m
            x: plot.width - 2 - contentWidth
            y: root.m ? root.m.cost.topFrac * plot.height - height * 1.15 : 0
            text: root.m ? root.m.cost.label : ""
            size: 10.5; tnum: true; color: Theme.labelTertiary
        }
    }
    Item { width: 1; height: 4 }
    Flow {
        width: parent.width
        spacing: 14
        bottomPadding: 6
        Repeater {
            model: root.m ? root.m.legend : []
            Row {
                required property var modelData
                required property int index
                spacing: 5
                Shape {
                    // 曲线渲染器:边缘抗锯齿(原版 SVG 是抗锯齿的);软件渲染下退回默认的
                    preferredRendererType: Shape.CurveRenderer
                    width: 18; height: 2; anchors.verticalCenter: parent.verticalCenter
                    ShapePath {
                        strokeWidth: index === 2 ? 1.5 : 2
                        strokeColor: index === 0 ? Theme.blue : index === 1 ? Theme.orange : Theme.labelTertiary
                        strokeStyle: index === 1 ? ShapePath.DashLine : ShapePath.SolidLine
                        dashPattern: [2, 2]
                        startX: 0; startY: 1
                        PathLine { x: 18; y: 1 }
                    }
                }
                Label { text: modelData; size: 11; color: Theme.labelSecondary }
            }
        }
        Label { text: "纵轴:每份净价(点);虚线以上是赚"; size: 11; color: Theme.labelSecondary }
    }

    // 现价 / 目标的胶囊(.mark:上 -4、1 × 7、整圆、590 白字;现价离目标近于 70 时现价那颗往下挪到 16)
    component Mark: Rectangle {
        property var spec: null
        property color fill
        property real topY: spec && spec.top !== undefined ? spec.top : -4
        x: spec ? spec.left * plot.width - width / 2 : 0
        y: topY
        width: markL.implicitWidth + 14; height: markL.implicitHeight + 2
        radius: height / 2
        color: fill
        Label { id: markL; x: 7; y: 1; text: parent.spec ? parent.spec.label : ""; size: 10.5; weight: Theme.weightSemibold; tnum: true; color: "#ffffff" }
    }
}
