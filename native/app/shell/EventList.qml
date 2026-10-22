import QtQuick
import Dafri.Kit

// 「全部」(React 版 lib/EventList.tsx + styles.css 的 .event-list):从昨天到两周后的重要事件,按天分组;
// 自己记的事件在这里加、删(CRWV 发债、某只股财报这种日历源上没有的)。口径在「设置 → 重要事件」。
Drawer {
    id: root
    property var store: null
    property var status: null       // StatusStore:showInfo / showError
    signal openSettings()
    title: "重要事件"
    readonly property var all: store ? store.all : ({ status: "", enabled: true, loaded: false, days: [] })
    property bool busy: false

    Connections {
        target: root.store
        ignoreUnknownSignals: true
        function onCustomDone(problem) {
            if (!root.busy && !root.removing) return
            if (root.busy) {
                root.busy = false
                if (problem) { if (root.status) root.status.showError("没记上:" + problem); return }
                nameField.text = ""; noteField.text = ""
                if (root.status) root.status.showInfo("记上了。到时候和官方日程一样挂在顶上、提前提醒。")
            } else {
                root.removing = false
                if (problem && root.status) root.status.showError("没删掉:" + problem)
            }
        }
    }
    property bool removing: false

    Column {
        width: parent.width
        spacing: 14

        // 公开日历的状态 + 刷新 / 口径…
        Flow {
            width: parent.width
            spacing: 4
            Text {
                height: 24; verticalAlignment: Text.AlignVCenter
                text: root.all.status
                color: Theme.labelSecondary; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily
                width: Math.min(implicitWidth, parent.width)
                wrapMode: Text.Wrap
            }
            Item { width: 4; height: 24 }
            Button { small: true; text: "刷新"; onClicked: if (root.store) root.store.load(true) }
            Button { small: true; text: "口径…"; onClicked: { root.close(); root.openSettings() } }
        }
        Alert {
            visible: !root.all.enabled
            width: parent.width
            tone: "warn"
            text: "「重要事件」已关(设置 → 重要事件),顶上不挂、不提醒。"
        }
        Text {
            visible: root.all.days.length === 0
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            topPadding: 8; bottomPadding: 8
            text: "两周内没有登记的事件。"
            color: Theme.labelTertiary; font.pixelSize: Theme.fontCaption; font.family: Theme.fontFamily
        }
        Repeater {
            model: root.all.days
            delegate: Column {
                width: parent.width
                spacing: 0
                Text {
                    bottomPadding: 6
                    text: modelData.day + "(美东)"
                    color: Theme.labelSecondary; font.pixelSize: Theme.fontCaption; font.weight: Theme.weightSemibold; font.family: Theme.fontFamily
                }
                Repeater {
                    model: modelData.events
                    delegate: Item {
                        id: row
                        readonly property var e: modelData
                        width: parent.width
                        height: grid.implicitHeight + 12
                        opacity: e.phase === "expired" ? 0.55 : 1
                        Rectangle { width: parent.width; height: 1; color: Theme.separator }
                        // 三列:何时 96 | 标题(星级、来源) | 倒计时;下面缩进 16 的分项与备注,自定义的右边一个删除
                        Column {
                            id: grid
                            y: 6
                            width: parent.width
                            spacing: 2
                            Item {
                                width: parent.width
                                height: Math.max(when.implicitHeight, titleText.implicitHeight)
                                Label { css: 0;
                                    id: when
                                    width: 96
                                    text: row.e.when
                                    color: Theme.labelSecondary; size: 12.5; family: Theme.fontFamily; tnum: true
                                }
                                // 富文本里内联的 9.5px / 11px 也只能按整数像素画(Label 的整段缩放救不了内联的那几段):这一行留 Text
                                Text {
                                    id: titleText
                                    x: 106
                                    width: count.x - 10 - x
                                    wrapMode: Text.Wrap
                                    textFormat: Text.RichText
                                    // 星级 9.5px 橙(可访问变体)、字距 -0.06em;来源 11px 二级色(同 React 版的 .event-stars / .muted)
                                    text: esc(row.e.title)
                                          + (row.e.stars ? "<span style='color:" + Theme.orangeText + ";font-size:9.5px;letter-spacing:-0.57px'> " + row.e.stars + "</span>" : "")
                                          + "<span style='color:" + Theme.labelSecondary + ";font-size:11px'> " + esc(row.e.source) + "</span>"
                                    color: Theme.label; font.pointSize: Theme.px(12.5); font.weight: Theme.weightSemibold; font.family: Theme.fontFamily
                                }
                                Text {
                                    id: count
                                    x: parent.width - width
                                    text: row.e.count
                                    color: Theme.labelSecondary; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily
                                    anchors.verticalCenter: when.verticalCenter
                                }
                            }
                            Repeater {
                                model: row.e.items
                                delegate: Label { css: 0;
                                    x: 106 + 16
                                    width: row.width - x
                                    wrap: true
                                    text: "•  " + modelData
                                    color: Theme.labelSecondary; size: 11.5; family: Theme.fontFamily
                                }
                            }
                            Label { css: 0;
                                visible: row.e.note !== ""
                                x: 106 + 16
                                width: row.width - x
                                wrap: true
                                text: row.e.note
                                color: Theme.labelSecondary; size: 11.5; family: Theme.fontFamily
                            }
                            Item {
                                visible: row.e.custom
                                width: parent.width; height: visible ? 24 : 0
                                Button {
                                    anchors.right: parent.right
                                    small: true; kind: "danger"; text: "删除"
                                    onClicked: { root.removing = true; root.store.removeCustom(row.e.id) }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 自己记一条
        Column {
            width: parent.width
            spacing: 6
            Text { text: "自己记一条"; color: Theme.labelSecondary; font.pixelSize: Theme.fontCaption; font.weight: Theme.weightSemibold; font.family: Theme.fontFamily }
            Text {
                width: parent.width; wrapMode: Text.Wrap
                text: "日历源上没有的:某只股发债、财报、听证会。时间写美东的。"
                color: Theme.labelSecondary; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily
            }
            Row {
                spacing: 10
                Field { label: "名字"; Input { id: nameField; small: true; width: 160; placeholder: "CRWV 发债" } }
                Field { label: "日期"; Input { id: dateField; small: true; width: 116; placeholder: "2026-10-14" } }
                Field { label: "美东钟点"; Input { id: timeField; small: true; width: 72; text: "08:30" } }
            }
            Item {
                width: parent.width
                height: noteBox.height
                Field { id: noteBox; label: "备注"; width: parent.width - addButton.width - 10
                    Input { id: noteField; small: true; width: noteBox.width; placeholder: "数据中心板块都要看" } }
                Button {
                    id: addButton
                    anchors.right: parent.right; anchors.bottom: parent.bottom
                    small: true; kind: "primary"; text: "记上"; busy: root.busy
                    enabled: nameField.text.trim() !== "" && dateField.text.trim() !== ""
                    onClicked: { root.busy = true; root.store.addCustom(nameField.text, dateField.text, timeField.text, noteField.text) }
                }
            }
        }
    }

    function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }

    // 表单里的一格:11px 二级色的名字在上,控件在下,间距 3
    component Field: Column {
        property string label
        spacing: 3
        Text { text: parent.label; color: Theme.labelSecondary; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily }
    }
}
