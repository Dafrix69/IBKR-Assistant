import QtQuick
import Dafri.Kit

// 关于(pages/About.tsx):版本信息、更新(lib/UpdatePanel)、支持(lib/SupportPanel)、键盘快捷键、引擎日志、重启交易引擎。内容最宽 880。
// 读与动作都在 C++(shell/about_controller),摆什么在 shell/settings_rules 的 aboutModel
ScrollPage {
    id: page
    property var controller: null
    readonly property var m: controller ? controller.model : ({})
    readonly property var u: m.update || ({})
    maxWidth: 880
    Component.onCompleted: if (controller) controller.setVisible(true)
    Component.onDestruction: if (controller) controller.setVisible(false)

    PageHead { width: parent.width; title: "关于" }

    // 版本信息(.about 里的 Descriptions:一列、小号、没有冒号;名字 96 宽二级色,内容等宽可选中)
    EmptyState { visible: !!page.m.error; width: parent.width; text: page.m.error || "" }
    LoadingBlock { visible: !!page.m.loading; width: parent.width; rows: 5 }
    Column {
        visible: (page.m.rows || []).length > 0
        width: parent.width
        Repeater {
            model: page.m.rows || []
            // 每行:上 1、下 8(最后一行没有下),名字从 1 起
            Item {
                required property var modelData
                required property int index
                width: parent.width
                height: 1 + valueText.implicitHeight + (index < (page.m.rows || []).length - 1 ? 8 : 0)
                Label { x: 1; y: 1; width: 96; text: modelData.label; size: 13; color: Theme.labelSecondary }
                Row {
                    x: 97; y: 1
                    width: parent.width - 97
                    Label {
                        id: valueText
                        width: Math.min(implicitWidth, parent.width - (linkText.visible ? linkText.implicitWidth : 0))
                        wrap: true
                        text: modelData.value + (modelData.link ? " " : "")
                        size: 13; family: Theme.fontMono
                    }
                    Label {
                        id: linkText
                        visible: !!modelData.link
                        text: modelData.link || ""
                        size: 13; family: Theme.fontMono; color: Theme.blue
                        TapHandler { onTapped: page.controller.openLink(modelData.link) }
                        HoverHandler { cursorShape: Qt.PointingHandCursor }
                    }
                }
            }
        }
    }

    SectionTitle { text: "更新" }
    Group {
        width: parent.width
        hint: "只读取 GitHub 上公开的发布信息;不下载、不安装、不上传任何数据。下载的安装包装上去会替换旧版,配置与交易记录都在用户目录里,不受影响。"
        GroupRow {
            width: parent.width
            label: page.u.label || ""; sub: page.u.sub || ""
            Row {
                spacing: 8
                Repeater {
                    model: page.u.buttons || []
                    Button {
                        required property var modelData
                        small: true
                        kind: modelData.primary ? "primary" : modelData.kind === "dismiss" ? "text" : "default"
                        text: modelData.text
                        busy: !!modelData.loading
                        onClicked: {
                            if (modelData.kind === "check") page.controller.checkUpdate()
                            else if (modelData.kind === "dismiss") page.controller.dismissUpdate(modelData.version)
                            else page.controller.openLink(modelData.url)
                        }
                    }
                }
            }
        }
        SwitchRow {
            width: parent.width
            label: "自动检查更新"; sub: "启动后查一次,之后每 12 小时一次"
            checked: !!page.u.auto
            onToggled: function (on) { page.controller.setAutoUpdate(on) }
        }
    }
    // 组下 14;发布说明下 8 与下一节标题的上 24 合并
    Item { visible: !!page.u.notes; width: 1; height: 14 }
    LogBlock { visible: !!page.u.notes; width: parent.width; text: page.u.notes || ""; maxHeight: 160 }

    SectionTitle { text: "支持" }
    Group {
        width: parent.width
        hint: "诊断信息里有版本与系统、引擎状态、脱敏后的配置、最近的日志;没有交易记录、成交、持仓与 API Key,真实账号已打码。"
        GroupRow {
            width: parent.width
            label: "诊断信息"; sub: "遇到问题时导出一份,连同问题描述一起发给支持"
            Row {
                spacing: 8
                Button { small: true; kind: "primary"; text: "导出诊断信息…"; busy: !!page.m.supportBusy; onClicked: page.controller.exportDiagnostics() }
                Button { small: true; text: "拷贝概要"; onClicked: page.controller.copyDiagnostics() }
            }
        }
        GroupRow {
            width: parent.width
            label: "文件位置"; sub: "日志、配置文件所在的文件夹"
            Row {
                spacing: 8
                Button { small: true; text: "打开日志所在位置"; onClicked: page.controller.reveal("logs") }
                Button { small: true; text: "打开配置文件所在位置"; onClicked: page.controller.reveal("config") }
            }
        }
        GroupRow {
            width: parent.width
            label: "条款与许可"; sub: "风险揭示、使用条款、隐私说明;本软件用到的开源组件及其许可"
            Row {
                spacing: 8
                Button { small: true; text: "查看条款"; onClicked: page.controller.showTerms() }
                Button { small: true; text: "第三方许可声明"; onClicked: page.controller.reveal("notices") }
            }
        }
    }

    SectionTitle { text: "键盘快捷键" }
    // .keys:名字 150 宽(一排键帽,间距 4),内容 12px 二级色;每行下 6
    Column {
        width: parent.width
        Repeater {
            model: page.m.shortcuts || []
            // 每行:上 1、下 6(最后一行没有下,AntD 的 :last-child);键帽 21.6 高(1 + 17.6 + 1,上 0.5、下 1.5 的边)
            Item {
                required property var modelData
                required property int index
                width: parent.width
                height: 1 + 21.6 + (index < (page.m.shortcuts || []).length - 1 ? 6 : 0)
                Row {
                    x: 1; y: 1
                    spacing: 4
                    Repeater {
                        model: modelData.keys
                        // kbd:1 × 6 的内边距、最窄 20、填充底、0.5 的边(下边 1.5)、4 圆角,等宽 11px 行高 1.6
                        Rectangle {
                            required property string modelData
                            width: Math.max(20, keyText.implicitWidth + 12 + 1)
                            height: 21.6
                            radius: 4
                            color: Theme.bgFill
                            border.width: 0.5; border.color: Theme.separator
                            Rectangle { anchors.bottom: parent.bottom; x: 2; width: parent.width - 4; height: 1; color: Theme.separator }
                            Label { id: keyText; anchors.centerIn: parent; text: modelData; size: 11; css: 1.6; family: Theme.fontMono }
                        }
                    }
                }
                Label { x: 151; y: 1; text: modelData.what; size: 12; css: 17.64; color: Theme.labelSecondary }
            }
        }
    }

    SectionTitle { text: "引擎日志" }
    LogBlock { width: parent.width; text: page.m.log || "" }
    Item { width: 1; height: 8 }
    Button { small: true; text: "重启交易引擎"; onClicked: page.controller.restartEngine() }
    Item { width: 1; height: 14 }

    // .log:填充底、卡片圆角、9 的内边距,等宽 10.5px 二级色,保留换行;最高 210(发布说明 160),再多就在里面滚。
    // 下 8 由调用的地方给(后面是分节标题时并进它的上 24);空的只有上下内边距
    component LogBlock: Item {
        id: lb
        property string text: ""
        property real maxHeight: 210
        implicitHeight: Math.min(maxHeight, (lb.text === "" ? 0 : body.implicitHeight) + 18)
        Rectangle {
            width: parent.width; height: parent.height
            radius: Theme.radiusCard
            color: Theme.bgFill
            clip: true
            Flickable {
                anchors.fill: parent
                anchors.margins: 9
                contentHeight: body.implicitHeight
                boundsBehavior: Flickable.StopAtBounds
                Label { id: body; width: parent.width; wrap: true; text: lb.text; size: 10.5; css: 15.435; family: Theme.fontMono; color: Theme.labelSecondary }
            }
        }
    }
}
