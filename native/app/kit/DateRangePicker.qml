import QtQuick
import QtQuick.Templates as T

// 日期区间(AntD DatePicker.RangePicker,默认大小,带 presets 与 maxDate,locale zh_CN 但 dayjs 没切中文——照原样):
//   · 框:控件面、发丝边、12 圆角、32 高;左右各一个日期(YYYY-MM-DD,13px,内边距 11),中间一枚 → 箭头(SwapRight),右边日历图标;
//     点开时正在选的那一头下面一条 2px 强调色;两头都能直接敲日期,敲完(回车 / 失焦)认得出、不晚于今天才算数;
//   · 弹层:左边一列预设(近一年 / 近半年 / 近一季 / 近三年,120 宽,右边 1px 线);右边两个月并排(各 288:头 40 + 下边 1px,身 8 × 18,
//     七列 36,表头 Su Mo … Sa,星期日开头;月份写成「2025年Oct」——zh_CN 的年份写法拼上 dayjs 英文的月份缩写,原版就是这样);
//     左边的月份只给 « ‹,右边的只给 › »,两个月一起翻;
//   · 格子:不在这个月的三级色;今天外圈 1px 强调色;起止两天实心强调色白字(起点左圆、终点右圆),中间一条 24 高的 12% 强调色;
//     晚于今天的点不动(填充底、三级色);
//   · 点第一下定起点、转去选终点,第二下定终点(早于起点就对调)、收起、交出去;点预设直接交出去。
// 受控:start / end 只由外面给;选好了只发 activated(start, end)。
Item {
    id: root
    property string start: ""
    property string end: ""
    /// 今天(YYYY-MM-DD,本机日期);晚于它的日子不能选(maxDate = dayjs())。每次点开都重取(页面开着跨过午夜也对);测试可以钉住它
    property string today: Qt.formatDate(new Date(), "yyyy-MM-dd")
    property bool pinToday: false
    signal activated(string start, string end)
    implicitWidth: 300
    implicitHeight: Theme.controlHeight

    // ---- 日期运算(按 年 / 月 / 日 的整数算,不经时区)
    function parse(s) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "")
        if (!m) return null
        var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
        if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null
        return { y: y, m: mo, d: d }
    }
    function fmt(o) { return o.y + "-" + (o.m < 10 ? "0" : "") + o.m + "-" + (o.d < 10 ? "0" : "") + o.d }
    function daysIn(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate() }
    /// dayjs 的 subtract(n, 'month'):月份往前挪,日子超出那个月的天数就落到月底
    function addMonths(o, n) {
        var t = o.y * 12 + (o.m - 1) + n
        var y = Math.floor(t / 12), m = t - y * 12 + 1
        return { y: y, m: m, d: Math.min(o.d, daysIn(y, m)) }
    }
    function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0 }
    readonly property var monthAbbr: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    // ---- 弹层的状态
    property string active: ""          // 正在选哪一头:start / end;收着是空
    property string pendingStart: ""    // 点了起点、还没点终点
    property int viewY: 0
    property int viewM: 1               // 左边那个月
    function openAt(which) {
        if (!pinToday) today = Qt.formatDate(new Date(), "yyyy-MM-dd")
        active = which
        pendingStart = ""
        var s = parse(which === "end" && end ? end : start) || parse(today)
        // 原版左边是起点所在的月;从终点那头点开时终点落在右边那个月
        var left = which === "end" && end ? addMonths(s, -1) : s
        viewY = left.y; viewM = left.m
        popup.open()
    }
    /// 在日历上选了、点了预设:框里敲到一半的字作废,以选的为准(同 AntD)
    function dropTyping() {
        startField.dirty = false
        endField.dirty = false
        startField.text = start
        endField.text = end
    }
    function pick(day) {
        if (cmp(day, today) > 0) return
        if (active === "start" || pendingStart === "" && active !== "end") {
            pendingStart = day
            active = "end"
            return
        }
        var a = pendingStart !== "" ? pendingStart : start
        var b = day
        if (cmp(b, a) < 0) { var t = a; a = b; b = t }
        popup.close()
        dropTyping()
        root.activated(a, b)
    }
    function preset(months) {
        if (!pinToday) today = Qt.formatDate(new Date(), "yyyy-MM-dd")
        var t = parse(today)
        popup.close()
        dropTyping()
        root.activated(fmt(addMonths(t, -months)), today)
    }
    /// 这一格眼下算选中区间里的哪一段(点了起点还没点终点时,区间就是那一天)
    readonly property string rangeStart: pendingStart !== "" ? pendingStart : start
    readonly property string rangeEnd: pendingStart !== "" ? pendingStart : end

    Rectangle {
        anchors.fill: parent
        radius: Theme.radiusControl
        color: root.enabled ? Theme.bgControl : Theme.bgFill
        border.width: 1
        border.color: popup.visible ? Theme.blue : Theme.separator
    }
    DateField { id: startField; x: 12; width: 114; which: "start"; value: root.start; placeholder: "开始日期" }
    Icon { x: 12 + 114 + 8; anchors.verticalCenter: parent.verticalCenter; name: "ad-swap-right"; size: 15; color: Theme.labelTertiary }
    DateField { id: endField; x: 12 + 114 + 31; width: 114; which: "end"; value: root.end; placeholder: "结束日期" }
    Icon { anchors.right: parent.right; anchors.rightMargin: 12; anchors.verticalCenter: parent.verticalCenter; name: "ad-calendar"; size: 13; color: Theme.labelTertiary }
    // 正在选的那一头下面一条 2px 强调色
    Rectangle {
        visible: popup.visible
        x: root.active === "end" ? endField.x : startField.x
        y: parent.height - 1 - 2
        width: 114; height: 2
        color: Theme.blue
        Behavior on x { NumberAnimation { duration: 150 } }
    }

    component DateField: TextInput {
        id: field
        property string which: ""
        property string value: ""
        property string placeholder: ""
        anchors.verticalCenter: parent.verticalCenter
        text: value
        font.pixelSize: Theme.fontBody; font.family: Theme.fontFamily
        color: Theme.label
        selectByMouse: true
        clip: true
        // dirty:人在框里敲过字。没敲过时外面的值变了(点日历、点预设)就照着改写,失焦也不拿框里的旧字回发
        property bool dirty: false
        onTextEdited: dirty = true
        onValueChanged: if (!dirty) text = value
        Text {
            visible: field.text === ""
            text: field.placeholder
            font: field.font
            color: Theme.labelTertiary
        }
        TapHandler { onTapped: { field.forceActiveFocus(); if (!popup.visible || root.active !== field.which) root.openAt(field.which) } }
        // 敲完:认得出、不晚于今天才算数;不然退回原来的值。没敲过字就什么都不发
        onEditingFinished: {
            if (!dirty) return
            dirty = false
            var d = root.parse(text.trim())
            if (d && root.cmp(root.fmt(d), root.today) <= 0) {
                var s = field.which === "start" ? root.fmt(d) : root.start
                var e = field.which === "end" ? root.fmt(d) : root.end
                if (root.cmp(s, e) > 0) { var t = s; s = e; e = t }
                if (s !== root.start || e !== root.end) root.activated(s, e)
            }
            text = value
        }
    }

    T.Popup {
        id: popup
        // 原版靠右对齐框的右边(左边放不下时),在框下面空 14
        x: root.width - width
        y: root.height + 14
        width: 696
        height: 309
        padding: 0
        closePolicy: T.Popup.CloseOnEscape | T.Popup.CloseOnPressOutsideParent
        onClosed: { root.active = ""; root.pendingStart = "" }
        background: Rectangle {
            radius: 20
            color: Theme.bgPopup
            border.width: 0.5
            border.color: Qt.rgba(0, 0, 0, 0.12)
        }
        contentItem: Item {
            // 预设
            Column {
                x: 8; y: 8
                spacing: 8
                Repeater {
                    model: [["近一年", 12], ["近半年", 6], ["近一季", 3], ["近三年", 36]]
                    Rectangle {
                        required property var modelData
                        width: 103; height: 22.1
                        radius: 9
                        color: presetHover.hovered ? Theme.bgFill : "transparent"
                        Label { x: 8; anchors.verticalCenter: parent.verticalCenter; text: parent.modelData[0]; size: 13 }
                        HoverHandler { id: presetHover; cursorShape: Qt.PointingHandCursor }
                        TapHandler { onTapped: root.preset(parent.modelData[1]) }
                    }
                }
            }
            Rectangle { x: 119; width: 1; height: parent.height; color: Theme.separator }
            MonthPanel { x: 120; offset: 0 }
            MonthPanel { x: 408; offset: 1 }
        }
    }

    component MonthPanel: Item {
        id: panel
        property int offset: 0
        readonly property var ym: root.addMonths({ y: root.viewY, m: root.viewM, d: 1 }, offset)
        width: 288; height: 309
        // 头:« ‹ 「2025年Oct」 › »(左边的月份只给往前,右边的只给往后)
        Item {
            width: parent.width; height: 40
            NavButton { x: 8; visible: panel.offset === 0; icon: "ad-double-left"; onClicked: { var t = root.addMonths({ y: root.viewY, m: root.viewM, d: 1 }, -12); root.viewY = t.y; root.viewM = t.m } }
            NavButton { x: 28.8; visible: panel.offset === 0; icon: "ad-left"; onClicked: { var t = root.addMonths({ y: root.viewY, m: root.viewM, d: 1 }, -1); root.viewY = t.y; root.viewM = t.m } }
            Label {
                anchors.centerIn: parent
                text: panel.ym.y + "年" + root.monthAbbr[panel.ym.m - 1]
                size: 13; weight: Theme.weightSemibold
            }
            NavButton { x: 238.4; visible: panel.offset === 1; icon: "ad-right"; onClicked: { var t = root.addMonths({ y: root.viewY, m: root.viewM, d: 1 }, 1); root.viewY = t.y; root.viewM = t.m } }
            NavButton { x: 259.2; visible: panel.offset === 1; icon: "ad-double-right"; onClicked: { var t = root.addMonths({ y: root.viewY, m: root.viewM, d: 1 }, 12); root.viewY = t.y; root.viewM = t.m } }
        }
        Rectangle { y: 40; width: parent.width; height: 1; color: Theme.separator }
        // 表头
        Row {
            x: 18; y: 49
            Repeater {
                model: ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
                Item {
                    required property var modelData
                    width: 36; height: 36
                    Label { anchors.centerIn: parent; text: parent.modelData; size: 13 }
                }
            }
        }
        // 六周 × 七天:第一格是这个月 1 号所在那一周的星期日
        Grid {
            x: 18; y: 85
            columns: 7
            Repeater {
                model: 42
                Item {
                    id: cell
                    required property int index
                    readonly property int first: new Date(Date.UTC(panel.ym.y, panel.ym.m - 1, 1)).getUTCDay()
                    readonly property var date: { var t = new Date(Date.UTC(panel.ym.y, panel.ym.m - 1, 1 + index - first)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() } }
                    readonly property string iso: root.fmt(date)
                    readonly property bool inView: date.m === panel.ym.m
                    readonly property bool disabled: root.cmp(iso, root.today) > 0
                    readonly property bool isStart: inView && root.rangeStart !== "" && iso === root.rangeStart
                    readonly property bool isEnd: inView && root.rangeEnd !== "" && iso === root.rangeEnd
                    readonly property bool inRange: inView && root.rangeStart !== "" && root.rangeEnd !== "" && root.cmp(iso, root.rangeStart) > 0 && root.cmp(iso, root.rangeEnd) < 0
                    width: 36; height: 36
                    // 区间那一条:中间的格子铺满,起点只铺右半、终点只铺左半(起止同一天不铺)
                    Rectangle {
                        visible: cell.inRange || (cell.isStart !== cell.isEnd && root.rangeStart !== root.rangeEnd)
                        x: cell.isStart ? 18 : 0
                        width: cell.isStart || cell.isEnd ? 18 : 36
                        y: 6; height: 24
                        color: Theme.tint(Theme.blue, 0.12)
                    }
                    Rectangle {
                        visible: cell.disabled && cell.inView
                        y: 6; width: 36; height: 24
                        color: Theme.bgFill
                    }
                    Rectangle {
                        x: 6; y: 6; width: 24; height: 24
                        topLeftRadius: cell.isEnd && !cell.isStart ? 0 : 9; bottomLeftRadius: topLeftRadius
                        topRightRadius: cell.isStart && !cell.isEnd ? 0 : 9; bottomRightRadius: topRightRadius
                        color: cell.isStart || cell.isEnd ? Theme.blue : cellHover.hovered && !cell.disabled && cell.inView ? Theme.bgFill : "transparent"
                        border.width: cell.iso === root.today && !(cell.isStart || cell.isEnd) && cell.inView ? 1 : 0
                        border.color: Theme.blue
                    }
                    Label {
                        anchors.centerIn: parent
                        text: String(cell.date.d)
                        size: 13
                        color: cell.isStart || cell.isEnd ? "#ffffff" : !cell.inView || cell.disabled ? Theme.labelTertiary : Theme.label
                    }
                    HoverHandler { id: cellHover; cursorShape: cell.disabled ? Qt.ForbiddenCursor : Qt.PointingHandCursor }
                    TapHandler { enabled: !cell.disabled; onTapped: root.pick(cell.iso) }
                }
            }
        }
    }

    component NavButton: Item {
        id: nav
        property string icon: ""
        signal clicked()
        width: 20.8; height: 40
        Icon { anchors.centerIn: parent; name: nav.icon; size: 12; color: navHover.hovered ? Theme.label : Theme.labelSecondary }
        HoverHandler { id: navHover; cursorShape: Qt.PointingHandCursor }
        TapHandler { onTapped: nav.clicked() }
    }
}
