import QtQuick
import Dafri.Kit

// 提醒小窗(desktop/popup/popup.html + popup.css + popup.js):价位提醒、异动提醒、重要事件共用的那扇置顶小窗。
// 置顶、不抢焦点(用户很可能正在 TWS 里敲数量)、列表式;不点掉就一直在。窗口的摆放与显隐在 C++(app/popup_controller)。
// 配色是 popup.css 自己的那一份(实底、不是玻璃):小窗压在别的应用上面,半透明会透出底下的字。
Window {
    id: win
    property var queue: null          // shell::PopupQueue
    property var controller: null     // app::PopupController
    readonly property var items: queue ? queue.items : []
    readonly property bool redUp: queue ? queue.updown === "red-up" : false

    width: 360
    height: 96
    visible: false
    title: "异动提醒"
    flags: Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus
    color: c.bgWindow

    // popup.css 的 :root 与深色那一份
    QtObject {
        id: c
        readonly property bool dark: Theme.dark
        readonly property color blue: dark ? "#0a84ff" : "#007aff"
        readonly property color green: dark ? "#32d74b" : "#28cd41"
        readonly property color orange: dark ? "#ff9f0a" : "#ff9500"
        readonly property color red: dark ? "#ff453a" : "#ff3b30"
        readonly property color greenText: dark ? green : "#248a3d"
        readonly property color redText: dark ? red : "#d70015"
        readonly property color blueText: dark ? "#409cff" : "#0062d6"
        readonly property color up: win.redUp ? red : green
        readonly property color down: win.redUp ? green : red
        readonly property color upText: win.redUp ? redText : greenText
        readonly property color downText: win.redUp ? greenText : redText
        readonly property color label: dark ? "#f5f5f7" : "#1d1d1f"
        readonly property color labelSecondary: dark ? Qt.rgba(235/255, 235/255, 245/255, 0.7) : Qt.rgba(60/255, 60/255, 67/255, 0.74)
        readonly property color labelTertiary: dark ? Qt.rgba(235/255, 235/255, 245/255, 0.45) : Qt.rgba(60/255, 60/255, 67/255, 0.5)
        readonly property color bgWindow: dark ? "#232325" : "#f2f2f4"
        readonly property color bgCard: dark ? "#313134" : "#ffffff"
        readonly property color bgControl: dark ? "#48484c" : "#ffffff"
        readonly property color bgControlHover: dark ? "#545458" : "#f5f5f7"
        readonly property color bgFill: dark ? Qt.rgba(120/255, 120/255, 128/255, 0.24) : Qt.rgba(120/255, 120/255, 128/255, 0.12)
        readonly property color bgFillStrong: dark ? Qt.rgba(120/255, 120/255, 128/255, 0.36) : Qt.rgba(120/255, 120/255, 128/255, 0.2)
        readonly property color separator: dark ? Qt.rgba(84/255, 84/255, 88/255, 0.65) : Qt.rgba(60/255, 60/255, 67/255, 0.18)
        readonly property color cardEdge: dark ? Qt.rgba(1, 1, 1, 0.08) : Qt.rgba(0, 0, 0, 0.08)
    }

    // ---- 点击护窗(popup.js):列表刚换过顺序 / 条数,这一小会儿的点击不认 ----
    // 新提醒插进来护 300ms;只是少了几条(用户自己关的)护 150ms,只为吞掉手滑双击的第二下(只延不缩)
    property var seen: ({})
    property real guardUntil: 0
    property string lastOrder: ""
    onItemsChanged: {
        var next = {}, order = [], grew = false
        for (var i = 0; i < items.length; ++i) {
            next[items[i].id] = true
            order.push(items[i].id)
            if (!seen[items[i].id]) grew = true
        }
        var key = order.join("\n")
        if (key !== lastOrder) guardUntil = Math.max(guardUntil, Date.now() + (grew ? 300 : 150))
        lastOrder = key
        fresh = Object.keys(next).filter(function (id) { return !seen[id] })
        seen = next
    }
    property var fresh: []
    function guarded() { return Date.now() < guardUntil }

    readonly property real contentHeight: 38 + list.implicitHeight
    onContentHeightChanged: if (controller) controller.setContentHeight(contentHeight)

    // ---- 头:圆点 + 「异动提醒 · N 条」+ 全部关闭 ----
    Rectangle {
        id: head
        z: 1
        width: parent.width
        height: 38
        color: c.bgWindow
        Row {
            x: 14
            anchors.verticalCenter: parent.verticalCenter
            spacing: 7
            Rectangle { anchors.verticalCenter: parent.verticalCenter; width: 7; height: 7; radius: 3.5; color: c.orange }
            Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.StyledText
                text: "异动提醒<font color='" + c.labelSecondary + "'><span style='font-weight:400'> · " + win.items.length + " 条</span></font>"
                color: c.label
                font.pixelSize: 13; font.weight: Theme.weightSemibold; font.letterSpacing: -0.065; font.family: Theme.fontFamily
            }
        }
        Rectangle {
            anchors.right: parent.right; anchors.rightMargin: 8
            anchors.verticalCenter: parent.verticalCenter
            width: clearText.implicitWidth + 16; height: 24; radius: 6
            color: clearTap.pressed ? c.bgFillStrong : clearHover.hovered ? c.bgFill : "transparent"
            Text { id: clearText; anchors.centerIn: parent; text: "全部关闭"; color: c.blueText; font.pixelSize: 12; font.family: Theme.fontFamily }
            HoverHandler { id: clearHover }
            TapHandler { id: clearTap; onTapped: if (win.queue) win.queue.clear() }
        }
        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 0.5; color: c.separator }
    }

    Flickable {
        y: 38
        width: parent.width
        height: parent.height - 38
        contentHeight: list.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        Column {
            id: list
            width: parent.width
            padding: 8
            spacing: 6
            Repeater {
                model: win.items
                delegate: Card { item: modelData; width: list.width - 16; isNew: win.fresh.indexOf(modelData.id) >= 0 }
            }
        }
    }

    // ---- 一条:代码(加粗)+ 类型胶囊 + 时刻 + ×;下面说明 + 查看 ----
    component Card: Rectangle {
        id: card
        property var item
        property bool isNew: false
        readonly property string tone: item.tone === "up" || item.tone === "down" ? item.tone : "info"
        readonly property color hl: tone === "up" ? c.up : tone === "down" ? c.down : c.blue
        height: col.implicitHeight + 18
        radius: 10
        color: c.bgCard
        border.width: 0.5
        border.color: c.cardEdge
        // 投影:0 0.5px 1px .08、0 1px 3px .06
        Rectangle { z: -1; anchors.fill: parent; anchors.topMargin: 1; radius: 10; color: Qt.rgba(0, 0, 0, c.dark ? 0.3 : 0.06) }

        // 新进来的闪一下:先下落 4px、半透明进场,背景与边染上方向色,1.8 秒里淡回去
        Component.onCompleted: if (isNew) arrive.start()
        ParallelAnimation {
            id: arrive
            SequentialAnimation {
                PropertyAction { target: card; property: "opacity"; value: 0.4 }
                PropertyAction { target: shift; property: "y"; value: -4 }
                ParallelAnimation {
                    NumberAnimation { target: card; property: "opacity"; to: 1; duration: 216; easing.type: Easing.OutQuad }
                    NumberAnimation { target: shift; property: "y"; to: 0; duration: 216; easing.type: Easing.OutQuad }
                }
            }
            SequentialAnimation {
                PropertyAction { target: card; property: "color"; value: Theme.mix(card.hl, c.bgCard, 0.18) }
                PropertyAction { target: card; property: "border.color"; value: Theme.tint(card.hl, 0.5) }
                PauseAnimation { duration: 720 }
                ParallelAnimation {
                    ColorAnimation { target: card; property: "color"; to: c.bgCard; duration: 1080; easing.type: Easing.OutQuad }
                    ColorAnimation { target: card; property: "border.color"; to: c.cardEdge; duration: 1080; easing.type: Easing.OutQuad }
                }
            }
        }
        transform: Translate { id: shift }

        Column {
            id: col
            x: 12; y: 9
            width: card.width - 12 - 8
            spacing: 4
            Item {
                width: parent.width
                height: 20
                Row {
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 6
                    Text {
                        visible: card.item.symbol !== ""
                        anchors.verticalCenter: parent.verticalCenter
                        width: Math.min(implicitWidth, col.width * 0.45)
                        elide: Text.ElideRight
                        text: card.item.symbol
                        color: c.label
                        font.pixelSize: 14; font.weight: Theme.weightBold; font.letterSpacing: -0.14; font.family: Theme.fontFamily
                    }
                    Rectangle {
                        readonly property string tag: {
                            // 标题形如「RKLB 5分钟放量 6.3×」:代码已经单独加粗,胶囊里只放后半截
                            var t = String(card.item.title || ""), s = String(card.item.symbol || "")
                            return s && t.indexOf(s + " ") === 0 ? t.slice(s.length + 1) : (t === s ? "" : t)
                        }
                        visible: tag !== ""
                        anchors.verticalCenter: parent.verticalCenter
                        width: Math.min(tagText.implicitWidth + 14, col.width - 150)
                        height: tagText.implicitHeight + 2
                        radius: 5
                        color: card.tone === "info" ? Theme.tint(c.blue, 0.12) : Theme.tint(card.tone === "up" ? c.up : c.down, 0.15)
                        Label { css: 0;
                            id: tagText
                            x: 7
                            width: parent.width - 14
                            anchors.verticalCenter: parent.verticalCenter
                            elide: Text.ElideRight
                            text: parent.tag
                            color: card.tone === "info" ? c.blueText : card.tone === "up" ? c.upText : c.downText
                            size: 11.5; weight: Theme.weightSemibold; family: Theme.fontFamily; tnum: true
                        }
                    }
                }
                Row {
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 6
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: {
                            var d = new Date(typeof card.item.at === "number" ? card.item.at : Date.now())
                            function p(n) { return (n < 10 ? "0" : "") + n }
                            return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
                        }
                        color: c.labelTertiary
                        font.pixelSize: 11; font.family: Theme.fontFamily; font.features: { "tnum": 1 }
                    }
                    Rectangle {
                        width: 20; height: 20; radius: 10
                        color: closeHover.hovered || closeTap.pressed ? c.bgFillStrong : "transparent"
                        Text { anchors.centerIn: parent; text: "×"; color: closeHover.hovered ? c.label : c.labelSecondary; font.pixelSize: 15; font.family: Theme.fontFamily }
                        HoverHandler { id: closeHover }
                        TapHandler { id: closeTap; onTapped: if (!win.guarded() && win.queue) win.queue.dismiss(card.item.id) }
                        Tip { text: "关闭这条提醒" }
                    }
                }
            }
            Item {
                width: parent.width
                height: Math.max(body.implicitHeight, 22)
                Text {
                    id: body
                    width: parent.width - view.width - 10 - 4
                    anchors.bottom: parent.bottom
                    text: card.item.body
                    wrapMode: Text.Wrap  // 按词换,放不下才劈(CSS 的 overflow-wrap: anywhere)
                    lineHeight: 1.45
                    color: c.labelSecondary
                    font.pixelSize: 12; font.family: Theme.fontFamily
                }
                Rectangle {
                    id: view
                    anchors.right: parent.right; anchors.rightMargin: 4
                    anchors.bottom: parent.bottom
                    width: viewText.implicitWidth + 20; height: 22; radius: 6
                    color: viewTap.pressed ? c.bgFillStrong : viewHover.hovered ? c.bgControlHover : c.bgControl
                    border.width: 0.5; border.color: c.separator
                    Text { id: viewText; anchors.centerIn: parent; text: "查看"; color: c.label; font.pixelSize: 12; font.family: Theme.fontFamily }
                    HoverHandler { id: viewHover }
                    // 「查看」双击的第二下不认:第一下已经把这张卡关掉,后面的整体上移,第二下会把主窗口带到别的股票上
                    TapHandler { id: viewTap; onTapped: function (point) { if (!win.guarded() && tapCount === 1 && win.queue) win.queue.open(card.item.id) } }
                    Tip {
                        text: "回主窗口的" + (card.item.page === "sectors" ? "板块页" : card.item.page === "trade" ? "蝴蝶测算" : card.item.page === "intel" ? "情报页" : "优质股页") + "查看"
                    }
                }
            }
        }
    }
}
