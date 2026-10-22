import QtQuick

// 照 CSS 排的一段字:浏览器给每行一个 line-height 高的行框,字的上下各留一半多出来的空(half-leading);
// Qt 的 Text 默认按字体自己的行高排,同样 11px 的字,一行高出一截,几行下来位置就对不上 React 版。
// 这里每行固定 lineHeight 高(css:1.55 这样的倍数;px:直接给像素),字往下挪半个多出来的空,整块的高就是 行数 × 行高。
// size 可以是小数像素(11.5);tnum = font-variant-numeric: tabular-nums(数字等宽,表格里的数对得齐)。
// 小数像素:Qt 的字体引擎只认整数像素(11.5px 的字在 macOS 的窗口里按 12 画、无窗口平台按 11 画,字宽差 4%,一行下来位置就漂了)。
// 这里按往上取整的那个整数像素排字,整段再按 size / 取整 缩回去(默认的距离场渲染缩放不糊);对外的宽高、行框、基线都是缩回去之后的真像素。
Item {
    id: root
    property alias text: t.text
    property real size: Theme.fontBody
    property int weight: Font.Normal
    property color color: Theme.label
    property string family: Theme.fontFamily
    /// CSS 的 line-height:倍数(< 4 当倍数)或像素;0 = normal(按字体自己的行高)。默认 1.47:theme/antd.ts 给全局定的,不另写就继承它
    property real css: 1.47
    property bool tnum: false
    property bool italic: false
    property bool wrap: false
    property int maxLines: 0
    property alias elide: t.elide
    property alias textFormat: t.textFormat
    property alias horizontalAlignment: t.horizontalAlignment
    property real letterSpacing: 0
    /// CSS 的上下外边距:整块的高含它们,字往下挪 topPadding
    property real topPadding: 0
    property real bottomPadding: 0
    /// 排字用的整数像素与缩放(整数 size 时 k = 1)
    readonly property real basePx: Math.ceil(size - 0.001)
    readonly property real k: size / basePx
    readonly property real contentWidth: t.contentWidth * k
    readonly property alias lineCount: t.lineCount
    /// 省略了(elide 起作用了)
    readonly property alias truncated: t.truncated
    readonly property real lineBox: css <= 0 ? metrics.height * k : css < 4 ? css * size : css
    readonly property real halfLeading: (lineBox - (metrics.ascent + metrics.descent) * k) / 2
    FontMetrics { id: metrics; font: t.font }
    // anchors.baseline 对的是字的基线(不给的话 Item 的基线是顶边:11px 的小字和 13px 的正文顶对齐,比 CSS 的 inline 基线对齐高几像素)
    baselineOffset: t.y + t.baselineOffset * k
    implicitWidth: t.implicitWidth * k
    implicitHeight: topPadding + bottomPadding + (css <= 0 ? t.implicitHeight * k : Math.max(1, t.lineCount) * lineBox)
    Text {
        id: t
        y: root.topPadding + (root.css <= 0 ? 0 : root.halfLeading)
        scale: root.k
        transformOrigin: Item.TopLeft
        // 折行、省略、右 / 居中对齐都要一个宽;不然按字自己的宽
        width: (root.wrap || root.elide !== Text.ElideNone || root.horizontalAlignment !== Text.AlignLeft) && root.width > 0 ? root.width / root.k : undefined
        // 默认纯文本:引擎给的字与用户起的名字(「IRA<旧>」)不当标签解析;要粗体的地方显式写 StyledText(Hint 就是)
        textFormat: Text.PlainText
        wrapMode: root.wrap ? Text.Wrap : Text.NoWrap
        maximumLineCount: root.maxLines > 0 ? root.maxLines : 100000
        lineHeightMode: root.css <= 0 ? Text.ProportionalHeight : Text.FixedHeight
        lineHeight: root.css <= 0 ? 1 : root.lineBox / root.k
        color: root.color
        font.pointSize: Theme.px(root.basePx)
        font.weight: root.weight
        font.family: root.family
        font.italic: root.italic
        // CSS 的字距 + 字宽校正(Theme.trackFix;只对系统字体)。富文本先去掉标签再数字形
        font.letterSpacing: root.letterSpacing / root.k
                            + (root.family === Theme.fontFamily ? Theme.trackFix(root.basePx, t.textFormat === Text.PlainText ? t.text : t.text.replace(/<[^>]*>/g, "")) : 0)
        // 系统字体是可变字体:不给 wght 轴时 Qt 只取最近的那一档(650 → 590、750 → 700),Chromium 按轴取准
        font.variableAxes: root.family === Theme.fontFamily ? ({ "wght": root.weight }) : ({})
        font.features: root.tnum ? ({ "tnum": 1 }) : ({})
    }
}
