import QtQuick
import QtQuick.Shapes
import Dafri.Kit

// 期权到期损益图(ui/graphics.tsx 的 PayoffChart + PayoffAxis):盈利区绿、亏损区红,零线虚线,行权价刻度,现价一根竖线。
// 几何由 C++ 算(shell/trade_rules 的 payoffChart,600 × 120 的坐标),这里只按宽度拉伸(SVG preserveAspectRatio=none:高 = 宽 / 5);
// 刻度字用 HTML 叠在下面(10.5px 等宽二级色),不跟着拉伸
Item {
    id: root
    property var m: null
    width: parent ? parent.width : 300
    readonly property real sx: m ? width / m.width : 1
    readonly property real sy: m ? (height - bottomPad) / m.height : 1
    /// .payoff-wrap 的 padding-bottom 2:刻度字贴着它的底,比 SVG 低 2
    property real bottomPad: 2
    implicitHeight: width / 5 + bottomPad
    function px(x) { return x * sx }
    function py(y) { return y * sy }
    function poly(close) {
        if (!m) return []
        var pts = m.points.map(function (p) { return Qt.point(px(p.x), py(p.y)) })
        if (close) { pts.push(Qt.point(width, py(m.zeroY))); pts.push(Qt.point(0, py(m.zeroY))) }
        return pts
    }
    // 上半截(零线以上)裁绿,下半截裁红
    Item {
        id: upHalf
        width: parent.width; height: root.m ? root.py(root.m.zeroY) : 0
        clip: true
        Shape {
            // 曲线渲染器:边缘抗锯齿(原版 SVG 是抗锯齿的);软件渲染下退回默认的
            preferredRendererType: Shape.CurveRenderer
            width: root.width; height: root.height - root.bottomPad
            ShapePath { strokeWidth: 0; fillColor: Theme.tint(Theme.up, 0.2); PathPolyline { path: root.poly(true) } }
            ShapePath { strokeWidth: 2.2; strokeColor: Theme.up; fillColor: "transparent"; joinStyle: ShapePath.RoundJoin; PathPolyline { path: root.poly(false) } }
        }
    }
    Item {
        y: upHalf.height
        width: parent.width; height: parent.height - root.bottomPad - upHalf.height
        clip: true
        Shape {
            // 曲线渲染器:边缘抗锯齿(原版 SVG 是抗锯齿的);软件渲染下退回默认的
            preferredRendererType: Shape.CurveRenderer
            y: -upHalf.height
            width: root.width; height: root.height - root.bottomPad
            ShapePath { strokeWidth: 0; fillColor: Theme.tint(Theme.down, 0.16); PathPolyline { path: root.poly(true) } }
            ShapePath { strokeWidth: 2.2; strokeColor: Theme.down; fillColor: "transparent"; joinStyle: ShapePath.RoundJoin; PathPolyline { path: root.poly(false) } }
        }
    }
    Shape {
        // 曲线渲染器:边缘抗锯齿(原版 SVG 是抗锯齿的);软件渲染下退回默认的
        preferredRendererType: Shape.CurveRenderer
        anchors.fill: parent
        ShapePath {
            strokeWidth: 1; strokeColor: Theme.labelTertiary; strokeStyle: ShapePath.DashLine; dashPattern: [3, 4]; fillColor: "transparent"
            startX: 0; startY: root.m ? root.py(root.m.zeroY) : 0
            PathLine { x: root.width; y: root.m ? root.py(root.m.zeroY) : 0 }
        }
    }
    Repeater {
        model: root.m ? root.m.ticks : []
        Rectangle { required property var modelData; x: root.px(modelData) - 0.5; y: root.py(root.m.tickY1); width: 1; height: root.py(root.m.tickY2) - root.py(root.m.tickY1); color: Theme.labelTertiary }
    }
    Rectangle {
        visible: !!(root.m && root.m.spotX !== null)
        x: root.m && root.m.spotX !== null ? root.px(root.m.spotX) - 0.8 : 0
        y: root.m ? root.py(root.m.spotY1) : 0
        width: 1.6; height: root.m ? root.py(root.m.spotY2) - root.py(root.m.spotY1) : 0
        color: Theme.blue
    }
    Repeater {
        model: root.m ? root.m.axis : []
        Label {
            required property var modelData
            x: modelData.left * root.width - contentWidth / 2
            y: root.height - height
            text: modelData.text
            size: 10.5; family: Theme.fontMono; tnum: true
            color: modelData.spot ? Theme.blue : Theme.labelSecondary
            weight: modelData.spot ? Theme.weightSemibold : Font.Normal
        }
    }
}
