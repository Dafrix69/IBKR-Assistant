import QtQuick
import Dafri.Kit

// 「应对」(React 版 lib/EventActions.tsx):事件公布之前先把一句对冲指令写好。只写进指令框——发不发、什么时候发,
// 还是「解析并校验」「发送」那两个按钮和那个确认框的事。三种结构都是解析器认得的写法(shell/event_rules 的 hedgeInstruction):
// 买 put 价差(借方)、卖 call 价差(贷方 bear call)、卖空正股 / ETF(跨市场那条用)。
// 现价:SPX 连着券商时两秒问一次引擎的 options.spot(常规时段是指数本身,之外按期货推算);别的标的自己填。
Modal {
    id: root
    property var store: null        // EventsStore
    property var bridge: null
    property bool connected: false
    signal write(string text)
    panelWidth: 560

    property string eventId: ""
    property var ev: ({})
    property var cross: null
    property string symbol: "SPX"
    property string kind: "put_spread"
    property var liveSpot: null
    property string liveSource: ""
    readonly property bool isSpx: symbol.trim().toUpperCase() === "SPX"
    readonly property bool stock: kind === "short_stock"
    readonly property var out: store ? store.hedge(spec()) : ({ text: "", legs: "", problem: "" })

    function num(s) { var t = String(s).trim(); return t === "" ? null : Number(t) }
    function spec() {
        var spot = spotField.text.trim() !== "" ? Number(spotField.text) : (isSpx ? liveSpot : null)
        return {
            symbol: symbol, spot: (spot !== null && isFinite(spot)) ? spot : null, kind: kind,
            width: num(widthField.text) === null ? 0 : num(widthField.text),
            qty: num(qtyField.text) === null ? 0 : num(qtyField.text),
            expiry: expiryField.text, todayEt: store ? store.etToday() : "", reason: reasonField.text,
            price: num(priceField.text), outside: store ? store.outsideRth() : true,
        }
    }

    /// 打开:跨市场那条默认做差距最大的那个市场、带杠杆的那只(韩股 KORU、A 股 YINN),卖空;别的默认 SPX 买 put 价差
    function openFor(id) {
        eventId = id
        ev = store.eventById(id)
        cross = ev.kind === "cross" && ev.cross ? ev.cross : null
        var worst = cross ? cross.markets.slice().sort(function (a, b) { return b.gap - a.gap })[0] : null
        var lev = worst ? (worst.instruments.filter(function (i) { return i.symbol === "KORU" || i.symbol === "YINN" })[0] || {}).symbol || worst.symbol : "KORU"
        symbol = cross ? lev : "SPX"
        symbolField.text = symbol
        kind = cross ? "short_stock" : "put_spread"
        spotField.text = ""
        widthField.text = "25"
        qtyField.text = cross ? "100" : "1"
        priceField.text = ""
        expiryField.text = store.hedgeExpiry(id)
        reasonField.text = cross && worst
            ? "美股 " + cross.us_pct + "% 而 " + worst.symbol + " 只 " + worst.etf_pct + "%," + worst.name + "开盘补" + (cross.direction === "down" ? "跌" : "涨")
            : ev.title + " 前对冲"
        title = "应对:" + ev.title
        refreshSpot()
        open()
    }
    // 换到别的标的:现价得自己填;SPX 的宽度按常见档距回到 25。点了跨市场那几只也要把框里的字换掉
    onSymbolChanged: {
        if (symbolField.text !== symbol) symbolField.text = symbol
        if (isSpx) widthField.text = "25"
    }

    function refreshSpot() {
        if (!visible && eventId === "") return
        if (!bridge || !connected) { liveSpot = null; return }
        bridge.call("options.spot", { symbol: "SPX" }, function (ok, result) {
            if (ok && result && (result.source === "quote" || result.source === "futures")) { liveSpot = result.price; liveSource = result.source }
            else liveSpot = null
        })
    }
    Timer { interval: 2000; repeat: true; running: root.visible && root.connected; onTriggered: root.refreshSpot() }

    Column {
        width: parent.width
        spacing: 0
        Text {
            width: parent.width; wrapMode: Text.Wrap
            bottomPadding: 8
            text: root.store && root.eventId ? root.store.actionsWhen(root.eventId) : ""
            color: Theme.label; font.pixelSize: Theme.fontBody; font.family: Theme.fontFamily
        }
        Repeater {
            model: (root.ev.items || []).filter(function (i) { return i.forecast || i.previous })
            delegate: Text {
                x: 18
                width: parent.width - 18; wrapMode: Text.Wrap
                text: "•  " + modelData.title + ":预期 " + (modelData.forecast || "—") + ",前值 " + (modelData.previous || "—")
                color: Theme.labelSecondary; font.pixelSize: Theme.fontCaption; font.family: Theme.fontFamily
            }
        }
        Item { width: 1; height: 8 }
        Alert {
            width: parent.width
            tone: "warn"
            title: root.cross ? "P0:ETF 的价还停在高处,开盘会补——但跟跌有时间差是经验,不是规律" : "公布前后指数常有跳空"
            text: root.cross
                ? (root.ev.note || "") + " 下面这句只写进指令框,不会自己发出去;卖空的限价自己看 TWS 的盘口填。"
                : "当日到期的蝶可能直接穿出翼;持仓追踪的止损按可成交价判也追不上一个跳空。要对冲、减仓或干脆不开,都趁公布之前。下面这句只写进指令框,不会自己发出去。"
            Flow {
                visible: !!root.cross
                width: parent.width
                topPadding: 8
                spacing: 6
                Repeater {
                    model: root.cross ? root.cross.markets.reduce(function (all, m) { return all.concat(m.instruments.map(function (i) { return { m: m, i: i } })) }, []) : []
                    delegate: Button {
                        small: true
                        kind: root.symbol.toUpperCase() === modelData.i.symbol ? "primary" : "default"
                        text: modelData.m.name + " " + modelData.i.symbol + (modelData.i.change_pct === null ? "" : " " + (modelData.i.change_pct > 0 ? "+" : "") + modelData.i.change_pct + "%")
                        onClicked: { root.symbol = modelData.i.symbol; root.kind = "short_stock" }
                    }
                }
            }
        }
        Item { width: 1; height: 12 }
        // 一排表单:标的、现价(卖空不要)、宽度 / 张数 / 到期日,或股数 / 限价
        Flow {
            width: parent.width
            spacing: 10
            Field { label: "标的"; Input { id: symbolField; small: true; width: 80; onEdited: function (t) { root.symbol = t } } }
            Field {
                visible: !root.stock
                label: "现价"
                Input {
                    id: spotField; small: true; width: 96; placeholder: root.isSpx && root.liveSpot !== null ? String(root.liveSpot) : "自己填"
                    Tip { text: root.isSpx && root.liveSpot !== null ? "实时(" + (root.liveSource === "futures" ? "期货推算" : "指数") + ")" : "没连券商或不是 SPX 时自己填" }
                }
            }
            Field { visible: !root.stock; label: "宽度(点)"; Input { id: widthField; small: true; width: 72 } }
            // 期权按张、正股按股:同一格
            Field { label: root.stock ? "股数" : "张数"; Input { id: qtyField; small: true; width: root.stock ? 80 : 64 } }
            Field {
                visible: root.stock
                label: "限价" + (root.store && root.store.outsideRth() ? "(盘外)" : "")
                Input {
                    id: priceField; small: true; width: 96; placeholder: "看 TWS 盘口"
                    Tip { text: root.store && root.store.outsideRth() ? "现在是常规时段之外:指令里会加「盘外」,必须限价" : "常规时段里;照样写限价,不写市价" }
                }
            }
            Field { visible: !root.stock; label: "到期日"; Input { id: expiryField; small: true; width: 116 } }
        }
        Item { width: 1; height: 8 }
        Item {
            width: parent.width
            height: Math.max(kinds.height, reasonBox.height)
            Segmented {
                id: kinds
                anchors.bottom: parent.bottom
                small: true
                options: [{ label: "买 put 价差(借方)", value: "put_spread" }, { label: "卖 call 价差(贷方)", value: "bear_call" }, { label: "卖空正股 / ETF", value: "short_stock" }]
                value: root.kind
                // 期权按张、正股按股:从价差切到卖空时 1 张变成 1 股没有意义,给个常见的起点
                onActivated: function (v) { root.kind = v; if (v === "short_stock" && (Number(qtyField.text) || 0) < 100) qtyField.text = "100" }
            }
            Field {
                id: reasonBox
                x: kinds.width + 10
                width: parent.width - x
                label: "理由"
                Input { id: reasonField; small: true; width: reasonBox.width }
            }
        }
        Item { width: 1; height: 8 }
        Text {
            visible: root.out.problem !== ""
            width: parent.width; wrapMode: Text.Wrap
            text: root.out.problem
            color: Theme.labelSecondary; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily
        }
        Text {
            visible: root.out.problem === ""
            width: parent.width; wrapMode: Text.Wrap
            bottomPadding: 8
            text: root.out.legs + "。" + (root.stock ? "" : "不写权利金,按下单时的盘口中间价(AUTO_MID)挂。")
            color: Theme.labelSecondary; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily
        }
        Glass {
            visible: root.out.problem === ""
            width: parent.width
            height: hedgeText.implicitHeight + 16
            radius: Theme.radiusTile
            edge: Theme.edgeSmall
            TextEdit {
                id: hedgeText
                x: 10; y: 8
                width: parent.width - 20
                readOnly: true; selectByMouse: true
                wrapMode: Text.Wrap
                text: root.out.text
                color: Theme.label; font.pointSize: Theme.px(12.5); font.family: Theme.fontMono
            }
        }
        Item {
            width: parent.width; height: 14 + 32
            Row {
                anchors.right: parent.right; anchors.bottom: parent.bottom
                spacing: 8
                Button { text: "关闭"; onClicked: root.close() }
                Button { kind: "primary"; text: "写进指令框"; enabled: root.out.problem === ""; onClicked: { root.write(root.out.text); root.close() } }
            }
        }
    }

    component Field: Column {
        property string label
        spacing: 3
        Text { text: parent.label; color: Theme.labelSecondary; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily }
    }
}
