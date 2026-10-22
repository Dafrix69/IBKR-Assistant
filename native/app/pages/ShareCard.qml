import QtQuick
import Dafri.Kit

// 绩效体检的「分享卡片」(lib/ShareCard.tsx + lib/shareCardDraw.ts + ui/AppMark.tsx 的 paintAppMark):按当前范围把核心数字画成一张 1080×1350 的 PNG,
// 拷贝或另存(controller.exportImage,写剪贴板与存盘都在壳里;保存路径由对话框定)。口径同原版:
//   · 默认不带金额,要自己拨开「显示金额」;账本里有模拟盘的副标题写明,不到 20 笔页脚注明样本偏少;
//   · 权益曲线只画形状、不标坐标轴;不含账号、标的、持仓;全在本机画,不上传。
// 画法逐行照 shareCardDraw.ts:底、光、应用图标、曲线的面板与曲线画在 Canvas 上(Qt 的 Context2D 没有 Path2D 与 roundRect,路径现画;
// 「#RRGGBBAA」在 Qt 里读成 #AARRGGBB,带透明度的颜色一律写 rgba());字不用 fillText:Qt 的画布填字时把字形里互相叠着的笔画挖成空心
// (系统字体的「+」「4」),所以字是一层普通的 Text,摆在 fillText 会摆的位置(同一条基线、同样的对齐、同样的收字号),导出时整张 grabToImage。
// 涨跌配色:设置页搬过来之前按绿涨红跌(Theme.upText 也是)
Modal {
    id: root
    property var controller: null
    property bool showAmounts: false
    property string busy: ""
    readonly property bool redUp: false
    title: "分享卡片"
    panelWidth: 460
    parent: Window.window ? Window.window.contentItem : null

    function openCard() { showAmounts = false; open(); refresh() }
    onShowAmountsChanged: refresh()
    /// 字的摆法(layoutTexts 算的,Repeater 摆成 Text)
    property var texts: []
    function refresh() { texts = layoutTexts(); canvas.requestPaint() }
    FontMetrics { id: fm }
    // 开着时结果换了(范围、品种、天数刚换完,回包才到)就重画,同原版 useMemo 跟着 data / scope / kind / days 变
    Connections {
        target: root.controller
        ignoreUnknownSignals: true
        function onPageChanged() { if (root.visible) root.refresh() }
    }

    function run(action) {
        if (!controller || busy !== "") return
        busy = action
        const d = new Date()
        const name = "交易体检-" + d.toISOString().slice(0, 10)
        // 整张卡片(画布 + 字)按原尺寸抓成图,写到壳给的那个临时文件,再交给壳拷贝或另存(路径界面递不进去)
        card.grabToImage(function (result) {
            if (root.controller && result.saveToFile(root.controller.cardImagePath())) root.controller.exportCard(action, name)
            root.busy = ""
        }, Qt.size(1080, 1350))
    }

    Column {
        width: parent.width
        spacing: 12
        // .share-card-preview:宽 100%、4 : 5、卡片圆角(只是预览裁圆角,导出的 PNG 是整张方图)。
        // 圆角用弹层底色盖住四个角(弹层是实底):把画好的卡片再套一层遮罩时,不显示的那张画布根本不画
        Item {
            width: parent.width
            height: width * 1.25
            clip: true
            // 画在原尺寸上,缩着显示;缩 2.6 倍要 mipmap(直接缩字会发毛,浏览器的 <img> 是平滑缩的),所以套一层带 mipmap 的 layer
            Item {
                width: 1080; height: 1350
                scale: parent.width / 1080
                transformOrigin: Item.TopLeft
                layer.enabled: true; layer.mipmap: true; layer.smooth: true
                Item {
                    id: card
                    width: 1080; height: 1350
                    Canvas {
                        id: canvas
                        anchors.fill: parent
                        renderTarget: Canvas.Image
                        onPaint: root.drawShapes(getContext("2d"))
                    }
                    Repeater {
                        model: root.texts
                        Text {
                            required property var modelData
                            text: modelData.text
                            textFormat: Text.PlainText
                            color: modelData.color
                            font.family: Theme.fontFamily
                            font.pixelSize: modelData.size
                            font.weight: modelData.weight
                            font.variableAxes: ({ "wght": modelData.weight })
                            // fillText 的对齐:left / right / center 对着 x;基线 alphabetic 是字的基线、middle 是字身的正中
                            x: modelData.align === "right" ? modelData.x - implicitWidth : modelData.align === "center" ? modelData.x - implicitWidth / 2 : modelData.x
                            // em 方框的正中在基线上方约 0.3em(字身上 0.8、下 0.2)
                            y: (modelData.base === "middle" ? modelData.y + 0.3 * modelData.size : modelData.y) - baselineOffset
                        }
                    }
                }
            }
            Canvas {
                id: corners
                anchors.fill: parent
                onWidthChanged: requestPaint()
                readonly property bool dark: Theme.dark
                onDarkChanged: requestPaint()
                onPaint: {
                    const ctx = getContext("2d"), w = width, h = height, r = Theme.radiusCard
                    ctx.reset()
                    ctx.fillStyle = Theme.bgPopup
                    ctx.fillRule = Qt.OddEvenFill
                    ctx.beginPath()
                    ctx.rect(0, 0, w, h)
                    root.roundRectPath(ctx, 0, 0, w, h, r)
                    ctx.fill()
                }
            }
        }
        // .share-card-toggle:小号开关 + 12.5px 的字,间距 8
        Row {
            spacing: 8
            Switch { small: true; checked: root.showAmounts; anchors.verticalCenter: parent.verticalCenter; onToggled: root.showAmounts = !root.showAmounts }
            Label { anchors.verticalCenter: parent.verticalCenter; text: "显示金额(净盈亏与最大回撤)"; size: 12.5 }
        }
        Label {
            width: parent.width; wrap: true; size: 11.5; color: Theme.labelSecondary; css: 1.5
            text: "默认只有比例,不含金额、账户与持仓明细;账本里有模拟盘交易会写明,笔数不到 20 会注明样本偏少。图在本机生成,不上传。"
        }
        Row {
            anchors.right: parent.right
            spacing: 8
            Button { text: "存为 PNG"; busy: root.busy === "save"; onClicked: root.run("save") }
            Button { kind: "primary"; text: "拷贝图片"; busy: root.busy === "copy"; onClicked: root.run("copy") }
        }
    }

    // ---- 画法(shareCardDraw.ts)
    readonly property var c: ({
        bg0: "#0f1218", bg1: "#07080b", panel: "rgba(255,255,255,0.055)", panelEdge: "rgba(255,255,255,0.08)",
        label: "#f5f5f7", secondary: "rgba(235,235,245,0.62)", tertiary: "rgba(235,235,245,0.36)", accent: "#0a84ff", green: "#30d158", red: "#ff453a"
    })

    function isNum(v) { return v !== null && v !== undefined && isFinite(v) }
    function num(v, digits) {
        if (!isNum(v)) return "—"
        return Number(v).toFixed(digits === undefined ? 2 : digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")
    }
    function pct(v) { return isNum(v) ? num(v, 1) + "%" : "—" }
    function usd(v) {
        const sign = v > 0 ? "+" : v < 0 ? "−" : ""
        const parts = Math.abs(v).toFixed(2).split(".")
        return sign + "$" + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + parts[1]
    }
    function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") }
    // "#30d158" + 透明度 → rgba(…)
    function alpha(hex, a) {
        const n = parseInt(hex.slice(1), 16)
        return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")"
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath()
        roundRectPath(ctx, x, y, w, h, r)
    }
    /// 接在当前路径上(一根蜡烛的影线与实体是同一条路径,落影只投一次,同 Path2D)
    function roundRectPath(ctx, x, y, w, h, r) {
        ctx.moveTo(x + r, y)
        ctx.arcTo(x + w, y, x + w, y + h, r)
        ctx.arcTo(x + w, y + h, x, y + h, r)
        ctx.arcTo(x, y + h, x, y, r)
        ctx.arcTo(x, y, x + w, y, r)
        ctx.closePath()
    }
    function panel(ctx, x, y, w, h) {
        roundRect(ctx, x, y, w, h, 36)
        ctx.fillStyle = c.panel
        ctx.fill()
        ctx.strokeStyle = c.panelEdge
        ctx.lineWidth = 2
        ctx.stroke()
    }
    // 字的颜色(Text 的 color 不认 CSS 的 rgba() 字符串,画布那份 c 才认)
    readonly property var tc: ({ label: "#f5f5f7", secondary: Qt.rgba(235 / 255, 235 / 255, 245 / 255, 0.62), tertiary: Qt.rgba(235 / 255, 235 / 255, 245 / 255, 0.36) })
    /// 标签在上、数在下;数字按格宽收字号(量字用同一份字体),基线按原字号放:同一排的数不管缩没缩,底边都对齐
    function stat(out, x, y, label, value, size, maxWidth, color) {
        out.push({ text: label, x: x, y: y, size: 28, weight: 500, color: tc.secondary })
        let px = size
        const width = function (p) { fm.font = Qt.font({ family: Theme.fontFamily, pixelSize: p, weight: 600 }); return fm.advanceWidth(value) }
        while (px > 24 && width(px) > maxWidth) px -= 2
        out.push({ text: value, x: x, y: y + size + 6, size: px, weight: 600, color: color || tc.label })
    }
    function equityCurve(ctx, r, x, y, w, h, up, down) {
        const pts = [0].concat((r.equity || []).map(function (p) { return p.equity }))
        if (pts.length < 3) return  // 「笔数太少,画不出曲线」那句在 layoutTexts 里
        const lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts)
        const span = hi - lo || 1
        const px = function (i) { return x + (i / (pts.length - 1)) * w }
        const py = function (v) { return y + h - ((v - lo) / span) * h }
        const last = pts[pts.length - 1]
        const color = last >= 0 ? up : down
        if (lo < 0 && hi > 0) {
            ctx.save()
            ctx.setLineDash([10, 12])
            ctx.strokeStyle = c.tertiary
            ctx.lineWidth = 2
            ctx.beginPath()
            ctx.moveTo(x, py(0))
            ctx.lineTo(x + w, py(0))
            ctx.stroke()
            ctx.restore()
        }
        ctx.beginPath()
        pts.forEach(function (v, i) { if (i === 0) ctx.moveTo(px(i), py(v)); else ctx.lineTo(px(i), py(v)) })
        ctx.lineTo(px(pts.length - 1), y + h)
        ctx.lineTo(px(0), y + h)
        ctx.closePath()
        const fill = ctx.createLinearGradient(0, y, 0, y + h)
        fill.addColorStop(0, alpha(color, 0x55 / 255))
        fill.addColorStop(1, alpha(color, 0))
        ctx.fillStyle = fill
        ctx.fill()
        ctx.beginPath()
        pts.forEach(function (v, i) { if (i === 0) ctx.moveTo(px(i), py(v)); else ctx.lineTo(px(i), py(v)) })
        ctx.strokeStyle = color
        ctx.lineWidth = 5
        ctx.lineJoin = "round"
        ctx.lineCap = "round"
        ctx.stroke()
    }

    // ---- 应用图标(ui/AppMark.tsx 的 paintAppMark,同一份几何)
    // 卡片上的角标大于 32px,用大尺寸那套:D 的笔画 0.083、三根柱子
    readonly property var markD: ({ left: 0.238, top: 0.218, bottom: 0.782, right: 0.762, stroke: 0.083 })
    readonly property real barBase: 0.684
    readonly property var bars: [
        { x: 0.342, width: 0.070, height: 0.136, gold: false, alpha: 0.58 },
        { x: 0.449, width: 0.070, height: 0.226, gold: false, alpha: 0.85 },
        { x: 0.556, width: 0.070, height: 0.325, gold: true, alpha: 1.00 }
    ]
    /// 超椭圆(n = 5)的轮廓点
    readonly property var squircle: {
        const n = 5, steps = 180, out = []
        for (let i = 0; i < steps; i++) {
            const t = (i / steps) * 2 * Math.PI, co = Math.cos(t), si = Math.sin(t)
            out.push([0.5 + 0.5 * Math.sign(co) * Math.pow(Math.abs(co), 2 / n), 0.5 + 0.5 * Math.sign(si) * Math.pow(Math.abs(si), 2 / n)])
        }
        return out
    }
    function paintAppMark(ctx, x, y, size) {
        const ux = function (p) { return x + p * size }, uy = function (p) { return y + p * size }
        const shape = function () {
            ctx.beginPath()
            squircle.forEach(function (p, i) { if (i === 0) ctx.moveTo(ux(p[0]), uy(p[1])); else ctx.lineTo(ux(p[0]), uy(p[1])) })
            ctx.closePath()
        }
        const pill = function (rx, ry, w, h, r) { roundRectPath(ctx, rx, ry, w, h, Math.min(r, w / 2, h / 2)) }
        ctx.save()
        shape()
        ctx.clip()
        const bg = ctx.createLinearGradient(ux(0.15), uy(0), ux(0.85), uy(1))
        bg.addColorStop(0, "#4A95FF"); bg.addColorStop(0.48, "#1A5BDB"); bg.addColorStop(1, "#0B2566")
        ctx.fillStyle = bg
        shape()
        ctx.fill()
        const glow = ctx.createRadialGradient(ux(0.22), uy(0.1), 0, ux(0.22), uy(0.1), size * 0.75)
        glow.addColorStop(0, "rgba(255,255,255,0.22)"); glow.addColorStop(1, "rgba(255,255,255,0)")
        ctx.fillStyle = glow
        ctx.fillRect(x, y, size, size)
        const dusk = ctx.createLinearGradient(ux(0.5), uy(0.55), ux(0.5), uy(1))
        dusk.addColorStop(0, "rgba(2,10,36,0)"); dusk.addColorStop(1, "rgba(2,10,36,0.3)")
        ctx.fillStyle = dusk
        ctx.fillRect(x, y, size, size)
        const dr = (markD.bottom - markD.top) / 2, dcx = markD.right - dr
        ctx.save()
        ctx.shadowColor = "rgba(2,10,36,0.35)"
        ctx.shadowBlur = size * 0.03
        ctx.shadowOffsetY = size * 0.012
        ctx.strokeStyle = "#ffffff"
        ctx.lineWidth = markD.stroke * size
        ctx.lineJoin = "round"
        ctx.beginPath()
        ctx.moveTo(ux(markD.left), uy(markD.top))
        ctx.lineTo(ux(dcx), uy(markD.top))
        ctx.arc(ux(dcx), uy((markD.top + markD.bottom) / 2), dr * size, -Math.PI / 2, Math.PI / 2, false)
        ctx.lineTo(ux(markD.left), uy(markD.bottom))
        ctx.closePath()
        ctx.stroke()
        ctx.restore()
        for (let k = 0; k < bars.length; ++k) {
            const b = bars[k], bx = ux(b.x), by = uy(barBase - b.height)
            ctx.save()
            if (b.gold) {
                const gold = ctx.createLinearGradient(bx, by, bx, by + b.height * size)
                gold.addColorStop(0, "#FFF4CF"); gold.addColorStop(0.45, "#FFD063"); gold.addColorStop(1, "#F5A524")
                ctx.shadowColor = "rgba(255,211,107,0.45)"
                ctx.shadowBlur = size * 0.035
                ctx.fillStyle = gold
            } else {
                ctx.fillStyle = "rgba(255,255,255," + b.alpha + ")"
            }
            ctx.beginPath()
            pill(bx, by, b.width * size, b.height * size, b.width * size * 0.3)
            ctx.fill()
            ctx.restore()
        }
        const rim = ctx.createLinearGradient(ux(0.5), uy(0), ux(0.5), uy(1))
        rim.addColorStop(0, "rgba(255,255,255,0.55)"); rim.addColorStop(0.6, "rgba(255,255,255,0.08)"); rim.addColorStop(1, "rgba(255,255,255,0.18)")
        ctx.strokeStyle = rim
        ctx.lineWidth = size * 0.015
        shape()
        ctx.stroke()
        ctx.restore()
    }

    function drawShapes(ctx) {
        const W = 1080, H = 1350, P = 80
        ctx.reset()
        const r = controller ? controller.data() : null
        if (!r || !r.stats) return
        const up = redUp ? c.red : c.green, down = redUp ? c.green : c.red
        const bg = ctx.createLinearGradient(0, 0, W, H)
        bg.addColorStop(0, c.bg0); bg.addColorStop(1, c.bg1)
        ctx.fillStyle = bg
        ctx.fillRect(0, 0, W, H)
        const glow = ctx.createRadialGradient(W - 120, 80, 10, W - 120, 80, 620)
        glow.addColorStop(0, "rgba(10,132,255,0.30)"); glow.addColorStop(1, "rgba(10,132,255,0)")
        ctx.fillStyle = glow
        ctx.fillRect(0, 0, W, H)
        paintAppMark(ctx, P, 72, 56)
        const cy = 590, ch = 380
        panel(ctx, P, cy, W - 2 * P, ch)
        equityCurve(ctx, r, P + 40, cy + 100, W - 2 * P - 80, ch - 140, up, down)
    }

    /// 卡片上的字:每一条是 { text, x, y, size, weight, color, align?, base? },位置与 shareCardDraw.ts 里 fillText 的一模一样
    function layoutTexts() {
        const W = 1080, H = 1350, P = 80, out = []
        const r = controller ? controller.data() : null
        if (!r || !r.stats) return out
        const up = redUp ? c.red : c.green, down = redUp ? c.green : c.red
        const s = r.stats
        // 顶:品牌 + 日期(textBaseline middle)
        out.push({ text: "Datrix", x: P + 76, y: 100, size: 32, weight: 600, color: tc.label, base: "middle" })
        out.push({ text: ymd(new Date()), x: W - P, y: 100, size: 28, weight: 500, color: tc.tertiary, align: "right", base: "middle" })
        // 标题
        out.push({ text: "交易体检", x: P, y: 250, size: 72, weight: 700, color: tc.label })
        out.push({ text: controller.cardSubtitle(), x: P, y: 304, size: 32, weight: 500, color: tc.secondary })
        // 三个大数:胜率 / 盈亏比 / 每笔期望(有 R 用 R,没有用利润因子)
        const col = (W - 2 * P) / 3, fit = col - 32, heroY = 400
        stat(out, P, heroY, "胜率", pct(s.win_rate), 96, fit)
        stat(out, P + col, heroY, "盈亏比", num(s.payoff_ratio), 96, fit)
        const rs = r.r_stats || {}
        if (rs.expectancy_r !== null && rs.expectancy_r !== undefined && rs.trades > 0) {
            const e = rs.expectancy_r, ci = rs.expectancy_ci
            // 区间跨着 0(正负还没分清)的不上色,和页面上同一条规矩
            const clear = ci !== null && ci !== undefined && (ci.lo > 0 || ci.hi < 0)
            stat(out, P + 2 * col, heroY, "每笔期望", (e > 0 ? "+" : "") + num(e) + "R", 96, fit, !clear ? c.label : e > 0 ? up : down)
        } else {
            const pf = s.profit_factor
            stat(out, P + 2 * col, heroY, "利润因子", num(pf), 96, fit, pf === null || pf === undefined ? c.label : pf >= 1 ? up : down)
        }
        // 权益曲线的面板上:标题、(拨开时)净盈亏;笔数太少时中间一句
        const cy = 590, ch = 380
        out.push({ text: "平仓权益曲线", x: P + 40, y: cy + 60, size: 28, weight: 500, color: tc.secondary })
        if (showAmounts) out.push({ text: usd(s.net_pnl), x: W - P - 40, y: cy + 60, size: 32, weight: 600, color: s.net_pnl >= 0 ? up : down, align: "right" })
        if ((r.equity || []).length + 1 < 3)
            out.push({ text: "笔数太少,画不出曲线", x: P + 40 + (W - 2 * P - 80) / 2, y: cy + 100 + (ch - 140) / 2, size: 28, weight: 500, color: tc.tertiary, align: "center" })
        // 六个小格
        const gy = 1030
        const sqn = rs.sqn
        const pd = r.per_day || {}, dd = r.drawdown || {}
        const cells = [
            ["已了结", s.trades + " 笔"],
            ["利润因子", num(s.profit_factor)],
            sqn !== null && sqn !== undefined ? ["SQN", num(sqn) + (rs.sqn_label ? " " + rs.sqn_label : "")]
                                              : ["盈利日", pd.days ? pd.green_days + "/" + pd.days : "—"],
            ["最长连胜", String(s.max_consecutive_wins)],
            ["最长连亏", String(s.max_consecutive_losses)],
            showAmounts ? ["最大回撤", dd.max > 0 ? usd(-dd.max) : "0"] : ["恢复因子", num(dd.recovery_factor)]
        ]
        for (let i = 0; i < cells.length; ++i)
            stat(out, P + (i % 3) * col, gy + Math.floor(i / 3) * 120, cells[i][0], cells[i][1], 52, fit)
        // 页脚
        out.push({ text: controller.cardFootnote(), x: P, y: H - 64, size: 24, weight: 500, color: tc.tertiary })
        return out
    }
}
