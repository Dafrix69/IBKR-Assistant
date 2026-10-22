import QtQuick
import Dafri.Kit

// 设置(pages/Settings.tsx):外观、执行闸门、风控限额(含按账户覆盖)、保护规则、单笔风险预算、重要事件的口径、数据与备份。内容最宽 880。
// 表单、保存、确认框、备份都在 C++(shell/settings_controller),每一行摆什么在 shell/settings_rules 的模型里(行是数据:开关 / 数字 / 分段);
// 外观三项直接读写 Theme(记在本机,同 React 版的 store/appearance)
ScrollPage {
    id: page
    property var controller: null
    readonly property var m: controller ? controller.model : ({})
    maxWidth: 880
    // 表单的一格改了:两个执行闸门走 setGate(关是当场生效的),别的只改表单
    function edit(key, kind, v) {
        if (!controller) return
        if (key === "autoExecute" || key === "allowLive") controller.setGate(key, v)
        else controller.setField(key, v)
    }
    Component.onCompleted: if (controller) controller.setVisible(true)
    Component.onDestruction: if (controller) controller.setVisible(false)

    PageHead {
        width: parent.width
        title: "设置"
        // .unsaved:二级色一句 + 小号主按钮,间距 10
        Row {
            visible: !!page.m.dirty
            spacing: 10
            Label { anchors.verticalCenter: parent.verticalCenter; text: "有未保存的修改"; size: 11; color: Theme.labelSecondary }  // .muted
            Button { anchors.verticalCenter: parent.verticalCenter; small: true; kind: "primary"; text: "保存设置"; busy: !!page.m.saving; onClicked: page.controller.save() }
        }
    }

    SectionTitle { text: "外观"; topGap: 10 }
    Group {
        width: parent.width
        GroupRow {
            width: parent.width
            icon: "sf-sun"; tint: "indigo"
            label: "深浅色"; sub: "跟随系统,或固定一种"
            Segmented {
                small: true
                options: [{ value: "system", label: "跟随系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" }]
                value: Theme.themeMode
                onActivated: function (v) { Theme.setThemeMode(v) }
            }
        }
        GroupRow {
            width: parent.width
            icon: "sf-drop"; tint: "teal"
            label: "Liquid Glass"; sub: "侧栏、工具栏这些玻璃面有多透:左边通透,右边着色(更好读)"
            // .glass-slider:260 宽,两头各一枚 20 的色块(灰底上盖一层玻璃底色:左 25%、右 90%),中间滑杆,间距 10
            Row {
                width: 260; height: 20
                spacing: 10
                Swatch { cover: 0.25 }
                Slider {
                    anchors.verticalCenter: parent.verticalCenter
                    width: 260 - 40 - 20
                    from: 0; to: 100; stepSize: 5
                    value: Math.round(Math.round(Theme.glassTint * 100) / 5) * 5
                    onMoved: function (v) { Theme.setGlassTint(v / 100) }
                }
                Swatch { cover: 0.9 }
            }
        }
        GroupRow {
            width: parent.width
            icon: "sf-updown"; tint: "green"
            label: "涨跌配色"; sub: "K 线、行情带、盈亏数字统一跟随;默认美股习惯"
            Segmented {
                small: true
                options: [{ value: "green-up", label: "绿涨红跌" }, { value: "red-up", label: "红涨绿跌" }]
                value: Theme.upDown
                onActivated: function (v) { Theme.setUpDown(v) }
            }
        }
    }

    // 数据到位前不画控件(原版:先画一排禁用的开关再翻成启用会闪一下)
    LoadingBlock { visible: !!page.m.loading; width: parent.width; rows: 4 }
    Column {
        visible: !page.m.loading
        width: parent.width

        SectionTitle { text: "执行闸门" }
        Group {
            width: parent.width
            RowList { rows: page.m.gates || []; onEdited: function (key, kind, v) { page.edit(key, kind, v) } }
        }

        SectionTitle { text: "风控限额" }
        Group {
            width: parent.width
            RowList { rows: page.m.limits || []; onEdited: function (key, kind, v) { page.edit(key, kind, v) } }
        }
        Item { visible: (page.m.accounts || []).length > 0; width: 1; height: 14 }
        Group {
            visible: (page.m.accounts || []).length > 0
            width: parent.width
            hint: "只填要和上面不一样的那几项,空着的用上面的;往松了改同样要确认。"
            // 模型只放别名 / 字段键(同 RowList:每改一格模型整份重建,对象数组会把正在打字的框换掉)
            Repeater {
                model: (page.m.accounts || []).map(function (a) { return a.alias })
                GroupRow {
                    id: acc
                    required property int index
                    readonly property var a: (page.m.accounts || [])[index] || ({})
                    width: parent ? parent.width : 0
                    icon: "sf-layers"; tint: acc.a.tint || "red"
                    label: acc.a.alias || ""; sub: acc.a.sub || ""
                    // .account-limits:每格一个 11px 的名字在上(间距 2)、104 宽的小号数字框;格与格间距 10,靠右
                    Row {
                        spacing: 10
                        Repeater {
                            model: (acc.a.fields || []).map(function (f) { return f.key })
                            Column {
                                id: cellCol
                                required property int index
                                readonly property var f: (acc.a.fields || [])[index] || ({})
                                spacing: 2
                                Label { text: cellCol.f.label || ""; size: 11; color: Theme.labelSecondary }
                                InputNumber {
                                    width: 104; small: true
                                    min: cellCol.f.min === undefined ? -Infinity : cellCol.f.min
                                    step: cellCol.f.step === undefined ? 1 : cellCol.f.step
                                    placeholder: "同全局"
                                    value: cellCol.f.value === undefined ? null : cellCol.f.value
                                    onValueEdited: function (v) { if (page.controller) page.controller.setAccountLimit(acc.a.alias, cellCol.f.key, v) }
                                }
                            }
                        }
                    }
                }
            }
        }

        SectionTitle { text: "保护规则" }
        // p.hint(11px 二级色、行高 1.55、最宽 760);中间一句加粗正文色。上 7 并进标题的下 9,下面紧贴着组
        Label {
            width: Math.min(parent.width, 760)
            wrap: true; size: 11; css: 1.55; color: Theme.labelSecondary
            // .hint b 是正文色、字重 600;StyledText 的 <b> 只有 700(RichText 能写 600,但不认 Label 的行高,整段矮一截),差这一档
            textFormat: Text.StyledText
            text: "比熔断细一档:接连止损、盈亏回撤过大、当天亏到上限、同一只刚平过仓,就先停一会儿自动执行。到点自己解除,不用人工。"
                  + "<b><font color=\"" + Theme.label + "\">只挡新单,永远不挡平仓。</font></b>被挡下的单停在「仅校验未发送」,保护期过了还能再发。"
        }
        Group {
            width: parent.width
            RowList { rows: page.m.protections || []; onEdited: function (key, kind, v) { page.edit(key, kind, v) } }
        }

        SectionTitle { text: "单笔风险预算" }
        Group {
            width: parent.width
            hint: "一单占账户权益太多时,在订单卡片上多一句提醒;只提醒,不拦单,平仓单不受影响。权益填了就用填的;空着的 IBKR 美元账户用券商报的净值。"
            RowList { rows: page.m.budget || []; onEdited: function (key, kind, v) { page.edit(key, kind, v) } }
        }
        Item { width: 1; height: 14 }

        Column {
            visible: (page.m.problems || []).length > 0
            width: parent.width
            Alert {
                width: parent.width
                tone: "warn"; title: "还不能保存"
                // .hint-list:上 4、左 16 的圆点列表,11px 二级色、行高 1.6、每条上下 2
                Column {
                    width: parent.width
                    topPadding: 4
                    Repeater {
                        model: page.m.problems || []
                        Item {
                            required property string modelData
                            width: parent.width
                            height: li.implicitHeight + 4
                            Label { x: 4; y: 2; text: "•"; size: 11; css: 1.6; color: Theme.labelSecondary }
                            Label { id: li; x: 16; y: 2; width: parent.width - 16; wrap: true; text: modelData; size: 11; css: 1.6; color: Theme.labelSecondary }
                        }
                    }
                }
            }
            Item { width: 1; height: 14 }
        }
        Button { kind: "primary"; text: "保存设置"; busy: !!page.m.saving; onClicked: page.controller.save() }
        Row {
            topPadding: 7
            width: Math.min(parent.width, 760)
            Label {
                width: Math.min(implicitWidth, parent.width - linkBtn.width)
                wrap: true; size: 11; css: 1.55; color: Theme.labelSecondary
                text: "账户在「接入 → 账户」里配。连接(端口、client id)只能手动编辑配置文件,改完重启交易引擎生效。 "
            }
            Button { id: linkBtn; small: true; kind: "text"; text: "打开配置文件所在位置"; onClicked: page.controller.reveal("config") }
        }
    }

    SectionTitle { text: "重要事件" }
    EmptyState { visible: !Array.isArray(page.m.events); compact: true; width: parent.width; text: "设置还没读到。" }
    Group {
        visible: Array.isArray(page.m.events)
        width: parent.width
        hint: "今天要公布的数(CPI、非农、FOMC…)一直挂在顶栏下面,直到公布过了一阵;公布前弹窗提醒,「应对」能把一句对冲指令写进指令框。板块联动:一个板块里多数成分股同向走出一大截时也挂上去。"
        RowList { rows: Array.isArray(page.m.events) ? page.m.events : []; onEdited: function (key, kind, v) { if (page.controller) page.controller.setEvent(key, v) } }
    }

    SectionTitle { text: "数据与备份" }
    readonly property var d: m.data || ({})
    LoadingBlock { visible: page.d.state === "loading"; width: parent.width; rows: 3 }
    Group {
        visible: page.d.state === "error"
        width: parent.width
        hint: "交易引擎起来之后这里才读得到。"
        GroupRow {
            width: parent.width
            label: "读不到备份清单"; sub: page.d.error || ""
            Button { small: true; text: "重试"; onClicked: page.controller.loadBackups() }
        }
    }
    Group {
        visible: page.d.state === "ready"
        width: parent.width
        hint: "每天第一次打开、每次升级之前,软件会自动给交易库留一份备份(每日 7 份、升级前 3 份、手动 5 份,旧的自动清掉)。备份和交易库在同一块盘上:换电脑、防硬盘损坏,请把备份目录另拷一份到别处。"
        GroupRow {
            width: parent.width
            label: "交易库"
            // .data-panel .mono:等宽 11px、可以选中拷走
            labelItem: Component {
                Column {
                    Label { text: "交易库"; size: 13 }
                    Label { topPadding: 1; text: page.d.dbPath || ""; size: 11; family: Theme.fontMono; color: Theme.labelSecondary }
                }
            }
            Row {
                spacing: 8
                Button { small: true; text: "立即备份"; busy: !!page.d.backupLoading; onClicked: page.controller.backupNow() }
                Button { small: true; text: "打开备份目录"; onClicked: page.controller.reveal("backups") }
            }
        }
        GroupRow {
            visible: !!page.d.empty
            width: parent.width
            label: "还没有备份"; sub: "第一份会在下一次启动时自动留下,也可以现在点「立即备份」"
        }
        Repeater {
            model: page.d.rows || []
            GroupRow {
                required property var modelData
                width: parent ? parent.width : 0
                label: modelData.label; sub: modelData.sub
                Button {
                    small: true; text: "恢复到这一份…"
                    busy: !!modelData.loading; enabled: !modelData.disabled
                    onClicked: page.controller.restoreBackup(modelData.name)
                }
            }
        }
    }
    Item { width: 1; height: 14 }

    // .glass-swatch:20 方、7 圆角、灰底,上面盖一层玻璃底色(cover 是那层的不透明度),外面一圈小号玻璃边
    component Swatch: Glass {
        id: sw
        property real cover: 0.25
        width: 20; height: 20
        radius: 7
        edge: Theme.edgeSmall
        fill: Theme.gray
        Rectangle { anchors.fill: parent; radius: 7; color: Theme.glassBase; opacity: sw.cover }
    }
}
