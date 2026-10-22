pragma Singleton
import QtQuick
import QtCore

// 主题 token:逐项取自 desktop/renderer-react/src/styles.css 的 :root 与深色那一份、theme/antd.ts 的组件 token。
// 跟系统深浅色走(Qt.styleHints.colorScheme)。
//
// 玻璃(Liquid Glass):styles.css 里是"按 --glass-tint 着色的面 + 背后的模糊 + 一圈压暗的边 + 顶上一道高光 + 投影"。
// 这里只搬着色的面、边、高光与投影,不做实时模糊:--glass-tint 0.72 时面有七成多不透明,底下是几乎纯色的窗口底,
// 模糊出来和不模糊看不出差别(styles.css 自己也只让浮在内容上面的那一层用模糊)。
QtObject {
    /// "light" / "dark":不跟系统(main.cpp 的 --color-scheme,截图对比用);空串跟系统
    property string forcedScheme: ""
    readonly property bool dark: forcedScheme !== "" ? forcedScheme === "dark" : Application.styleHints.colorScheme === Qt.ColorScheme.Dark

    // --- 外观偏好(「设置 → 外观」,store/appearance.ts):记在本机(同 React 版的 localStorage dafri-theme / dafri-updown / dafri-glass)---
    /// system / light / dark:固定一种时连标题栏、系统控件一起换(QStyleHints.colorScheme,同 Electron 的 nativeTheme.themeSource)
    readonly property string themeMode: prefs.theme === "light" || prefs.theme === "dark" ? prefs.theme : "system"
    /// green-up(默认,美股习惯)/ red-up。只有一份记在本机:提醒小窗也要它,存在 Alerter 的 alerts/updown(qt-settings.ini);
    /// Main.qml 启动时从那里读进来、这里一变就写回去
    property string upDown: "green-up"
    /// Liquid Glass 的着色程度:0 通透,1 完全着色
    readonly property real glassTint: Math.max(0, Math.min(1, Number(prefs.glass)))
    function setThemeMode(mode) {
        prefs.theme = mode === "light" || mode === "dark" ? mode : "system"
        applyScheme()
    }
    function setUpDown(mode) { upDown = mode === "red-up" ? "red-up" : "green-up" }
    function setGlassTint(v) { prefs.glass = Math.max(0, Math.min(1, Number(v))) }
    function applyScheme() {
        if (themeMode === "light") Application.styleHints.colorScheme = Qt.ColorScheme.Light
        else if (themeMode === "dark") Application.styleHints.colorScheme = Qt.ColorScheme.Dark
        else Application.styleHints.colorScheme = Qt.ColorScheme.Unknown  // 交还给系统
    }
    property Settings prefs: Settings {
        category: "appearance"
        property string theme: "system"
        property real glass: 0.72
    }
    Component.onCompleted: if (themeMode !== "system") applyScheme()

    // --- 系统语义色 ---
    readonly property color blue: dark ? "#0a84ff" : "#007aff"
    readonly property color green: dark ? "#30d158" : "#34c759"
    readonly property color orange: dark ? "#ff9f0a" : "#ff9500"
    readonly property color red: dark ? "#ff453a" : "#ff3b30"
    readonly property color yellow: dark ? "#ffd60a" : "#ffcc00"
    readonly property color purple: dark ? "#bf5af2" : "#af52de"
    readonly property color teal: dark ? "#40c8e0" : "#30b0c7"
    readonly property color indigo: dark ? "#5e5ce6" : "#5856d6"
    readonly property color gray: "#8e8e93"
    readonly property color accent: blue
    // 涨跌:红涨绿跌还是绿涨红跌由设置定,默认同 styles.css(涨绿跌红)
    readonly property color up: upDown === "red-up" ? red : green
    readonly property color down: upDown === "red-up" ? green : red
    // 蜡烛与量能柱(styles.css 的 --chart-up / --chart-down):青绿 / 珊瑚红,不用系统绿红(几百根挤在一起会发光);
    // 红涨绿跌时两个对调(同 up / down、styles.css 的 :root[data-updown="red-up"])。图区底色:浅色白、深色近黑(--chart-bg)
    readonly property color chartUp: upDown === "red-up" ? "#ef5350" : "#26a69a"
    readonly property color chartDown: upDown === "red-up" ? "#26a69a" : "#ef5350"
    readonly property color chartBg: dark ? "#0b0b0d" : "#ffffff"
    // 文字用的"可访问"变体:系统绿红橙直接当小字放在白底上对比度不够
    readonly property color greenText: dark ? green : "#248a3d"
    readonly property color redText: dark ? red : "#d70015"
    readonly property color orangeText: dark ? orange : "#c93400"
    readonly property color upText: upDown === "red-up" ? redText : greenText
    readonly property color downText: upDown === "red-up" ? greenText : redText

    // --- 文字 ---
    readonly property color label: dark ? "#ffffff" : "#000000"
    readonly property color labelSecondary: dark ? Qt.rgba(235/255, 235/255, 245/255, 0.62) : Qt.rgba(60/255, 60/255, 67/255, 0.62)
    readonly property color labelTertiary: dark ? Qt.rgba(235/255, 235/255, 245/255, 0.32) : Qt.rgba(60/255, 60/255, 67/255, 0.34)

    // --- 面 ---
    readonly property color glassBase: dark ? "#2a2a30" : "#ffffff"
    readonly property color glassBg: tint(glassBase, 0.30 + glassTint * 0.62)
    readonly property color glassBgClear: tint(glassBase, 0.12 + glassTint * 0.55)
    readonly property color bgWindow: dark ? "#000000" : "#f2f2f7"
    readonly property color bgControl: dark ? tint("#3a3a40", 0.50 + glassTint * 0.45) : tint("#ffffff", 0.55 + glassTint * 0.42)
    readonly property color bgFill: dark ? Qt.rgba(120/255, 120/255, 128/255, 0.24) : Qt.rgba(120/255, 120/255, 128/255, 0.12)
    readonly property color bgFillStrong: dark ? Qt.rgba(120/255, 120/255, 128/255, 0.36) : Qt.rgba(120/255, 120/255, 128/255, 0.2)
    /// 卡片面:比页面底高一层
    readonly property color bgElevated: dark ? tint("#1c1c1e", 0.45 + glassTint * 0.5) : tint("#ffffff", 0.50 + glassTint * 0.46)
    readonly property color bgPopup: dark ? "#2a2a2e" : "#ffffff"
    readonly property color separator: dark ? Qt.rgba(84/255, 84/255, 88/255, 0.55) : Qt.rgba(60/255, 60/255, 67/255, 0.14)
    readonly property color separatorOpaque: dark ? Qt.rgba(1, 1, 1, 0.1) : Qt.rgba(0, 0, 0, 0.1)
    /// 窗口底的两抹冷色(--ambient):左上一团蓝、右下一团靛
    readonly property color ambientA: dark ? Qt.rgba(10/255, 132/255, 1, 0.09) : Qt.rgba(0, 122/255, 1, 0.055)
    readonly property color ambientB: dark ? Qt.rgba(94/255, 92/255, 230/255, 0.06) : Qt.rgba(88/255, 86/255, 214/255, 0.04)

    // --- 边与投影(--glass-edge / --glass-edge-small / --shadow-card / --shadow-control / 弹层)---
    // 每一份:highlight 顶上一道 1px 高光、innerRing 内圈、ring 外圈 0.5px、drops 投影 [{ y, blur, color }]
    readonly property var edgePanel: dark
        ? { highlight: Qt.rgba(1, 1, 1, 0.22), innerRing: Qt.rgba(1, 1, 1, 0.10), ring: Qt.rgba(0, 0, 0, 0.6), drops: [{ y: 10, blur: 32, color: Qt.rgba(0, 0, 0, 0.45) }] }
        : { highlight: Qt.rgba(1, 1, 1, 0.9), innerRing: Qt.rgba(1, 1, 1, 0.5), ring: Qt.rgba(0, 0, 0, 0.10), drops: [{ y: 8, blur: 28, color: Qt.rgba(15/255, 23/255, 60/255, 0.10) }] }
    readonly property var edgeSmall: dark
        ? { highlight: Qt.rgba(1, 1, 1, 0.2), innerRing: "transparent", ring: Qt.rgba(0, 0, 0, 0.6), drops: [{ y: 2, blur: 8, color: Qt.rgba(0, 0, 0, 0.35) }] }
        : { highlight: Qt.rgba(1, 1, 1, 0.9), innerRing: "transparent", ring: Qt.rgba(0, 0, 0, 0.10), drops: [{ y: 2, blur: 8, color: Qt.rgba(15/255, 23/255, 60/255, 0.08) }] }
    readonly property var edgeCard: dark
        ? { highlight: "transparent", innerRing: "transparent", ring: Qt.rgba(1, 1, 1, 0.07), drops: [{ y: 6, blur: 20, color: Qt.rgba(0, 0, 0, 0.35) }] }
        : { highlight: "transparent", innerRing: "transparent", ring: Qt.rgba(0, 0, 0, 0.05), drops: [{ y: 1, blur: 2, color: Qt.rgba(15/255, 23/255, 60/255, 0.04) }, { y: 6, blur: 20, color: Qt.rgba(15/255, 23/255, 60/255, 0.05) }] }
    readonly property var edgeControl: dark
        ? { highlight: "transparent", innerRing: "transparent", ring: "transparent", drops: [{ y: 0.5, blur: 1, color: Qt.rgba(0, 0, 0, 0.35) }] }
        : { highlight: "transparent", innerRing: "transparent", ring: "transparent", drops: [{ y: 0.5, blur: 1, color: Qt.rgba(0, 0, 0, 0.08) }, { y: 1, blur: 3, color: Qt.rgba(0, 0, 0, 0.05) }] }
    readonly property var edgePopup: dark
        ? { highlight: "transparent", innerRing: "transparent", ring: Qt.rgba(1, 1, 1, 0.14), drops: [{ y: 10, blur: 32, color: Qt.rgba(0, 0, 0, 0.55) }] }
        : { highlight: "transparent", innerRing: "transparent", ring: Qt.rgba(0, 0, 0, 0.12), drops: [{ y: 10, blur: 32, color: Qt.rgba(0, 0, 0, 0.16) }] }
    readonly property var edgeNone: ({ highlight: "transparent", innerRing: "transparent", ring: "transparent", drops: [] })

    // --- 圆角同心:窗口级面板 22 → 卡片 20 → 卡内瓦片 14 → 控件 12;按钮与胶囊是整圆 ---
    readonly property int radiusPanel: 22
    readonly property int radiusCard: 20
    readonly property int radiusTile: 14
    readonly property int radiusControl: 12
    readonly property int radiusSmall: 9
    readonly property int radiusXS: 6

    // --- 字:系统字体,macOS 的字号层级(正文 13 / 说明 11),字重照 CSS 的 510 / 590 / 650 / 750 ---
    readonly property int fontSmall: 11
    readonly property int fontCaption: 12
    readonly property int fontBody: 13
    readonly property int fontLarge: 15
    readonly property int fontTitle: 20
    readonly property int fontLargeTitle: 28
    readonly property string fontFamily: Qt.platform.os === "osx" ? ".AppleSystemUIFont" : "Segoe UI"
    // --font-mono 的 ui-monospace 在 macOS 上是 SF Mono:Qt 里叫 .AppleSystemUIFontMonospaced(fontInfo 报的名字是 Menlo,
    // 实际画的是 SF Mono——同一串字量出来 176.45,Chromium 的 ui-monospace 是 176.84,真 Menlo 是 183.7)
    readonly property string fontMono: Qt.platform.os === "osx" ? ".AppleSystemUIFontMonospaced" : "Consolas"
    // --font-display 写的 "SF Pro Rounded" 在 Chromium 里认不出来(量出来和不存在的字体一样宽),落到系统字体:同 fontFamily
    readonly property string fontDisplay: fontFamily
    readonly property int weightMedium: 510
    readonly property int weightSemibold: 590
    readonly property int weightBold: 650
    readonly property int weightHeavy: 750

    // --- 控件高度 ---
    readonly property int controlHeight: 32
    readonly property int controlHeightSmall: 24
    readonly property int controlHeightLarge: 40

    // --- 动效 ---
    readonly property int durationFast: 100
    readonly property int durationMid: 150
    readonly property int durationSlow: 200

    /// 小数像素的字号(10.5px 之类):pixelSize 只认整数,换成按屏幕逻辑 DPI 折算的磅数
    function px(p) { return p * 72 / (Screen.logicalPixelDensity * 25.4) }
    /// color-mix(in srgb, a t, b):按预乘透明度混(跨市场那条事件的红底 = 红 10% 混进玻璃面)
    function mix(a, b, t) {
        var x = Qt.color(a), y = Qt.color(b)
        var alpha = x.a * t + y.a * (1 - t)
        if (alpha <= 0) return Qt.rgba(0, 0, 0, 0)
        function ch(p, q) { return (p * x.a * t + q * y.a * (1 - t)) / alpha }
        return Qt.rgba(ch(x.r, y.r), ch(x.g, y.g), ch(x.b, y.b), alpha)
    }
    /// graphics.tsx 的 Tint 名 → 颜色(var(--blue) 之类;up / down 跟涨跌配色走)
    function tintOf(name) {
        switch (name) {
        case "green": return green
        case "orange": return orange
        case "red": return red
        case "yellow": return yellow
        case "purple": return purple
        case "teal": return teal
        case "indigo": return indigo
        case "gray": return gray
        case "up": return up
        case "down": return down
        default: return blue
        }
    }
    /// 同一个颜色换透明度(color-mix(in srgb, c x%, transparent))
    /// 一块界面最窄能窄到多少(CSS 的 min-content):会折行的字不算(能折到很窄),不折行的字按它的宽;Row 横着加起来(不折行),
    /// Flow 与别的取最宽的那个孩子,再加上它离左边的距离两倍(当成左右对称的内边距,最多 20:卡片 17、表单 12)。
    /// 有 minContentWidth 的项(不折行的表)用它自己算的。只看看得见的。
    /// 交易指令页的两栏按它定:两栏的基准都是 50%,谁的内容最窄也放不下就把它撑宽、另一栏让出来(同 AntD Splitter 的 flex 子项 min-width: auto)
    function minContentWidth(item) {
        if (!item || !item.visible) return 0
        if (item.minContentWidth !== undefined) return item.minContentWidth
        var type = String(item)
        if (type.indexOf("QQuickText") === 0) return item.wrapMode !== Text.NoWrap ? 0 : item.implicitWidth
        if (item.lineBox !== undefined) return item.wrap ? 0 : item.implicitWidth
        var kids = item.children || []
        var row = type.indexOf("QQuickRow") === 0
        var sum = 0, max = 0, n = 0
        for (var i = 0; i < kids.length; ++i) {
            var c = kids[i]
            if (!c.visible) continue
            var w = minContentWidth(c)
            if (w <= 0) continue
            n += 1
            sum += w
            max = Math.max(max, w + (row ? 0 : 2 * Math.min(Math.max(c.x, 0), 20)))
        }
        var pad = (item.leftPadding || 0) + (item.rightPadding || 0)
        if (row) return sum + Math.max(0, n - 1) * (item.spacing || 0) + pad
        return max + pad
    }
    // ---- 字宽校正(表与算法在 C++:kit/text_metrics,图表量轴宽也用同一份)
    /// 整数像素 px、这段字(纯文字)在 Qt 里该加的字距
    function trackFix(px, text) { return Metrics.trackFix(px, text) }
    function tint(c, alpha) { var k = Qt.color(c); return Qt.rgba(k.r, k.g, k.b, alpha) }
}
