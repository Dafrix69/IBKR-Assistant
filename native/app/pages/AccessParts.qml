import QtQuick
import Dafri.Kit

// 「接入」的五节与共用的展示构件(lib/connectBits.tsx 的 InfoCard、AppsCards、PortsGrid、Diagnosis、ConnectRow、Guide)。
// 模型是 controller.model(shell/access_rules 的那一节);按钮都回到 controller(shell/access_controller)。
// 量的(浏览器 1360 宽):节与节之间是分节标题(上 24 下 9);提示条下 14;.row.tight 下 10;.cards 竖排间距 8;端口两列、间距 7
QtObject {
    // ---- 共用 --------------------------------------------------------------------------------

    // AntD Badge status:8 的圆点 + 8 + 字
    component StatusDot: Row {
        property string status: "default"   // success / warning / error / default
        property string text: ""
        property real size: 11
        spacing: 8
        Rectangle {
            anchors.verticalCenter: parent.verticalCenter
            width: 8; height: 8; radius: 4
            color: parent.status === "success" ? Theme.green : parent.status === "warning" ? Theme.orange : parent.status === "error" ? Theme.red : Theme.labelTertiary
        }
        Label { anchors.verticalCenter: parent.verticalCenter; text: parent.text; size: parent.size }
    }

    // AntD Tag(theme/antd.ts 的 Tag:整圆、填充底;量的):21.8 高(19.8 的行 + 上下 1 的透明边)、左右 7 + 1、11px;
    // 不带颜色的是填充底 + 二级色字;success / warning / error / processing 是 AntD 由系统色算出的淡底(实色,不是透明叠色)+ 系统色字。
    // closable:字后空 3 一枚 9px 的 ×(二级色),右边照样 8
    component AntTag: Rectangle {
        id: tag
        property string text: ""
        property string color_: ""
        property bool closable: false
        signal closed()
        // 浅色 / 深色各一套,取自浏览器里 AntD 算出来的值
        readonly property var tones: Theme.dark
            ? ({ success: ["#142519", "#2cb54e"], warning: ["#2c1f11", "#dc8a0c"], error: ["#2c1415", "#dc3e34"], processing: ["#111d2c", "#0c73dc"] })
            : ({ success: ["#f0fff1", "#34c759"], warning: ["#fff9e6", "#ff9500"], error: ["#fff3f0", "#ff3b30"], processing: ["#e6f6ff", "#007aff"] })
        readonly property var tone: tones[color_] || null
        readonly property color ink: tone ? tone[1] : Theme.labelSecondary
        implicitWidth: 8 + tagText.implicitWidth + (closable ? 3 + 9 : 0) + 8
        implicitHeight: 21.8
        radius: height / 2
        color: tone ? tone[0] : Theme.bgFill
        Label { id: tagText; x: 8; anchors.verticalCenter: parent.verticalCenter; css: 19.8; text: tag.text; size: 11; color: tag.ink }
        Text {
            visible: tag.closable
            x: tagText.x + tagText.implicitWidth + 3
            width: 9
            horizontalAlignment: Text.AlignHCenter
            anchors.verticalCenter: parent.verticalCenter
            text: "✕"; font.pixelSize: 9; color: Theme.labelSecondary
            TapHandler { onTapped: tag.closed() }
        }
    }

    // InfoCard:状态卡片;正文 13px、元数据、(可选)卡片里的按钮(上 8)、原因(11.5px 二级色、上 4)、说明(上 6)、账户对照、配置片段
    component InfoCard: StatusCard {
        id: ic
        property var c: ({})
        property var controller: null
        signal action(var a)
        tone: c.tone || "info"
        title: c.title || ""
        Label { visible: !!ic.c.body; width: parent.width; wrap: true; text: ic.c.body || ""; size: 13 }
        Meta { width: parent.width; items: ic.c.meta || [] }
        Column {
            visible: !!ic.c.snippet
            width: parent.width
            Label { topPadding: 8; width: parent.width; wrap: true; text: "尚未配置连接与账户。把下面这段并入 config/settings.json 后再切换:"; size: 13 }
            // .snippet:上 6、8 × 10、内容底、细边、卡片圆角、等宽 11px 行高 1.5、不折行
            Item { width: 1; height: 6 }
            Rectangle {
                width: parent.width
                height: snip.implicitHeight + 16
                radius: Theme.radiusCard
                color: Theme.bgContent
                border.width: 0.5; border.color: Theme.separator
                clip: true
                Label { id: snip; x: 10; y: 8; text: ic.c.snippet || ""; size: 11; family: Theme.fontMono; css: 1.5 }
            }
        }
        Item { visible: !!ic.c.action; width: 1; height: 8 }
        Button {
            visible: !!ic.c.action
            small: true
            text: ic.c.action ? ic.c.action.text : ""
            busy: !!(ic.c.action && ic.c.action.loading)
            onClicked: ic.action(ic.c.action)
        }
        Label { visible: !!ic.c.reason; topPadding: 4; width: parent.width; wrap: true; text: ic.c.reason || ""; size: 11.5; color: Theme.labelSecondary }
        Label { visible: !!ic.c.hint; topPadding: 6; width: parent.width; wrap: true; text: ic.c.hint || ""; size: 13 }
        // .acct-list:上 8,每行上下 4、11.5px,名在左、状态点在右
        Column {
            visible: (ic.c.rows || []).length > 0
            width: parent.width
            topPadding: 8
            Repeater {
                model: ic.c.rows || []
                Item {
                    required property var modelData
                    required property int index
                    width: parent.width
                    height: 4 + 16.9 + 4 + (index > 0 ? 1 : 0)
                    Rectangle { visible: parent.index > 0; width: parent.width; height: 1; color: Theme.separator }
                    Label { x: 0; y: (parent.index > 0 ? 1 : 0) + 4; text: parent.modelData.text; size: 11.5 }
                    StatusDot {
                        anchors.right: parent.right
                        y: (parent.index > 0 ? 1 : 0) + 4
                        size: 11.5
                        status: parent.modelData.resolved ? "success" : "error"
                        text: parent.modelData.state
                    }
                }
            }
        }
    }

    // .cards 那一格:读着(骨架)/ 空(卡片列表里的空态,外边距 10、内容最少 72)/ 握手着 / 一张张卡片
    component CardsBlock: Column {
        id: cb
        property var b: ({})
        property var controller: null
        property int skeletonRows: 2
        spacing: 8
        LoadingBlock { visible: !!cb.b.loading; width: parent.width; rows: cb.skeletonRows }
        Item {
            visible: cb.b.empty !== undefined
            width: parent.width
            height: visible ? 10 + Math.max(72, es.implicitHeight - 20) + 10 : 0
            EmptyState { id: es; y: 10 + (Math.max(72, implicitHeight - 20) - (implicitHeight - 20)) / 2 - 10; width: parent.width; text: cb.b.empty || "" }
        }
        Working { visible: !!cb.b.working; text: cb.b.working || "" }
        Repeater {
            model: cb.b.cards || []
            InfoCard {
                required property var modelData
                width: cb.width
                c: modelData
                controller: cb.controller
                onAction: function (a) {
                    if (!cb.controller) return
                    if (a.label !== undefined) cb.controller.switchBroker(a.key, a.label)
                    else cb.controller.launch(a.key, modelData.title)
                }
            }
        }
    }

    // .port-grid:两列、间距 7;每格是小号 Card(开着的边是绿 45%),内边距 8 × 10:端口(等宽 590 13px)、名字(11px 二级色)、状态点、「配置为…」小牌
    component PortsGrid: Grid {
        id: pg
        property var cells: []
        columns: 2
        columnSpacing: 7; rowSpacing: 7
        Repeater {
            model: pg.cells
            Rectangle {
                required property var modelData
                width: (pg.width - 7) / 2
                height: portCol.implicitHeight + 16 + 2
                radius: 16
                color: Theme.bgElevated
                border.width: 1
                border.color: modelData.open ? Theme.tint(Theme.green, 0.45) : Theme.separator
                Column {
                    id: portCol
                    x: 11; y: 9
                    width: parent.width - 22
                    Label { text: parent.parent.modelData.port; size: 13; weight: Theme.weightSemibold; family: Theme.fontMono; tnum: true }
                    Label { text: parent.parent.modelData.label; size: 11; color: Theme.labelSecondary }
                    Item {
                        width: parent.width; height: 3 + 19.11
                        StatusDot { y: 3 + (19.11 - height) / 2; status: parent.parent.parent.modelData.open ? "success" : "default"; text: parent.parent.parent.modelData.state }
                    }
                    Item {
                        visible: !!parent.parent.modelData.configured
                        width: parent.width; height: visible ? 4 + 14.7 : 0
                        Rectangle {
                            y: 4
                            width: badgeL.implicitWidth + 10; height: 14.7; radius: 4
                            color: Theme.bgFill
                            Label { id: badgeL; x: 5; anchors.verticalCenter: parent.verticalCenter; text: parent.parent.parent.parent.modelData.configured || ""; size: 10; family: Theme.fontMono; color: Theme.labelSecondary }
                        }
                    }
                }
            }
        }
    }

    // .row.tight:按钮一排,间距 8,下 10;下面紧跟分节标题(上 24)时两段外边距合并,只剩 24 → collapsed 时不留这 10
    component ButtonRow: Item {
        default property alias buttons: row.data
        property bool collapsed: false
        implicitHeight: 32 + (collapsed ? 0 : 10)
        Row { id: row; spacing: 8 }
    }

    // p.hint:11px 二级色、行高 1.55、上 7、最宽 760
    component HintP: Label {
        topPadding: 7
        width: Math.min(parent ? parent.width : 0, 760)
        wrap: true; size: 11; css: 1.55; color: Theme.labelSecondary
    }

    // ---- TWS / 富途 ---------------------------------------------------------------------------
    component BrokerPanel: Column {
        id: bp
        property var m: ({})
        property bool futu: false
        property var controller: null
        Repeater {
            model: bp.futu ? [] : bp.m.notices || []
            Column {
                required property var modelData
                width: bp.width
                Alert { width: parent.width; tone: parent.modelData.tone; title: parent.modelData.title; text: parent.modelData.text }
                Item { width: 1; height: 14 }
            }
        }
        Column {
            visible: bp.futu
            width: parent.width
            Alert {
                width: parent.width
                tone: "info"; title: "IBKR API 跑不起来时的备用通道。"; rich: true
                text: "同样不接触你的富途账号密码,登录在 OpenD 自己的窗口完成;这里只检测端口、诊断握手、核对账户别名。<br><b>不支持组合单</b>:价差 / 蝴蝶 / 铁鹰拆单有腿风险,引擎会直接拒绝,请切回 IBKR。"
                      + "<br><b>没有原生条件单</b>:条件单由本软件盯盘,<i>软件关掉就不会触发</i>(IBKR 的条件单挂在券商服务器,掉线仍有效)。"
            }
            SectionTitle { text: "0 · 当前券商接入" }
            CardsBlock { width: parent.width; b: bp.m.providers || ({}); controller: bp.controller }
            HintP { text: "同一时刻只连一家。切换会断开现有连接并写入配置;别名、限额、校验层不变。" }
        }
        ButtonRow {
            width: parent.width; collapsed: true
            Button { text: "重新检测"; onClicked: if (bp.controller) bp.controller.rescan() }
            Button { kind: "primary"; text: "检测连接"; busy: !!(bp.m.buttons && bp.m.buttons[1].loading); onClicked: if (bp.controller) bp.controller.diagnose() }
        }
        SectionTitle { text: "1 · 程序" }
        CardsBlock { width: parent.width; b: bp.m.apps || ({}); controller: bp.controller }
        SectionTitle { text: "2 · API 端口" }
        LoadingBlock { visible: !!(bp.m.ports && bp.m.ports.loading); width: parent.width }
        CardsBlock { visible: !!(bp.m.ports && bp.m.ports.empty !== undefined); width: parent.width; b: bp.m.ports && bp.m.ports.empty !== undefined ? bp.m.ports : ({}) }
        PortsGrid { visible: !!(bp.m.ports && bp.m.ports.cells); width: parent.width; cells: bp.m.ports && bp.m.ports.cells ? bp.m.ports.cells : [] }
        SectionTitle { text: "3 · 握手与账户" }
        CardsBlock { width: parent.width; b: bp.m.diag || ({}); controller: bp.controller }
        ConnectRow { width: parent.width; c: bp.m.connect || ({}); controller: bp.controller }
        Column {
            visible: bp.futu
            width: parent.width
            SectionTitle { text: "5 · 交易解锁(仅实盘需要)" }
            Group {
                width: parent.width
                GroupRow {
                    width: parent.width
                    stacked: true; richLabel: true
                    label: "<b>只存 md5</b>于 Keychain / DPAPI,明文算完即丢,不写配置、不进日志。模拟盘无需解锁。"
                    Input {
                        width: parent.width
                        password: true; placeholder: "富途交易密码"
                        text: bp.m.password || ""
                        onEdited: function (t) { if (bp.controller) bp.controller.setFutuPassword(t) }
                    }
                }
                SwitchRow {
                    width: parent.width
                    label: "我填的已经是 md5"; sub: "不勾则由引擎本机计算"
                    checked: !!bp.m.isMd5
                    onToggled: function (on) { if (bp.controller) bp.controller.setFutuMd5(on) }
                }
                GroupRow {
                    width: parent.width
                    label: "解锁状态"; sub: bp.m.unlockState || ""
                    Row {
                        spacing: 6
                        Button { text: "保存"; busy: !!bp.m.saving; onClicked: if (bp.controller) bp.controller.saveFutuPassword() }
                        Button { kind: "primary"; text: "交易解锁"; busy: !!bp.m.unlocking; onClicked: if (bp.controller) bp.controller.unlockFutu() }
                    }
                }
            }
            // 组下 14,与 p.hint 的上 7 合并成 14
            HintP { topPadding: 14; text: "解锁随 OpenD 会话失效,重启 OpenD 后需重新解锁;未解锁时实盘单会在引擎侧被拦下。" }
        }
        GuidePrimer { width: parent.width; g: bp.m.guide || ({}) }
    }

    component ConnectRow: Column {
        id: cr
        property var c: ({})
        property var controller: null
        SectionTitle { text: "4 · 连接引擎" }
        ButtonRow {
            width: parent.width
            Button { text: cr.c.text || ""; busy: !!cr.c.busy; onClicked: if (cr.controller) cr.controller.toggleConnection() }
        }
        HintP { topPadding: 0; text: "「检测连接」是一次性只读探测;这里才是引擎下单用的长连接。" }
    }

    // 「连不上时照着做」:没连上时默认展开(上 16)
    component GuidePrimer: Primer {
        id: gp
        property var g: ({})
        id_: g.id || ""
        intro: false
        topPadding: 16
        defaultOpen: !!g.defaultOpen
        summary: "连不上时照着做"
        StepList { width: parent.width; topPadding: 10; items: gp.g.steps || [] }
    }

    // ---- 账户 ----------------------------------------------------------------------------------
    component AccountsPanel: Column {
        id: ap
        property var m: ({})
        property var controller: null
        readonly property var d: m.draft || null
        // 提示条之间 14;最后一条下面是分节标题(上 24),外边距合并,不另留
        Repeater {
            id: apNotices
            model: ap.m.notices || []
            Column {
                required property var modelData
                required property int index
                width: ap.width
                Alert { width: parent.width; tone: parent.modelData.tone; title: parent.modelData.title; text: parent.modelData.text }
                Item { width: 1; height: parent.index < apNotices.count - 1 ? 14 : 0 }
            }
        }
        SectionTitle { text: "已配置的账户"; count: ap.m.count || 0 }
        EmptyState { visible: !!ap.m.empty; width: parent.width; text: ap.m.empty || "" }
        Group {
            visible: (ap.m.rows || []).length > 0
            width: parent.width
            Repeater {
                model: ap.m.rows || []
                GroupRow {
                    // 名字格是个内嵌 Component:按 id 读这一行的数据,不靠作用域链(里面的 Repeater 也有 modelData)
                    id: accRow
                    required property var modelData
                    width: ap.width
                    sub: modelData.sub
                    labelItem: Component {
                        Row {
                            spacing: 4
                            Label { anchors.verticalCenter: parent.verticalCenter; text: accRow.modelData.alias; size: 13 }
                            Repeater {
                                model: accRow.modelData.pills
                                Pill { required property var modelData; anchors.verticalCenter: parent.verticalCenter; tint: modelData.tint; text: modelData.text }
                            }
                        }
                    }
                    Row {
                        spacing: 8
                        Button { small: true; text: "修改"; onClicked: if (ap.controller) ap.controller.openDraft(modelData.alias) }
                        Button { small: true; kind: "danger"; text: "删除"; enabled: !ap.m.busy; onClicked: if (ap.controller) ap.controller.removeAccount(modelData.alias) }
                    }
                }
            }
        }
        // 组下 14
        Item { visible: !ap.d && (ap.m.rows || []).length > 0; width: 1; height: 14 }
        ButtonRow {
            visible: !ap.d
            width: parent.width
            Button { kind: "primary"; text: "添加账户"; enabled: !!(ap.m.add && !ap.m.add.disabled); onClicked: if (ap.controller) ap.controller.openDraft("") }
        }
        Column {
            visible: !!ap.d
            width: parent.width
            SectionTitle { text: ap.d ? ap.d.title : "" }
            Group {
                width: parent.width
                hint: "连接(端口、client id)不能从这里改:账户只能挂到配置里已有的连接上。保存后直接写进配置并重启引擎,不再弹确认框。"
                GroupRow {
                    width: parent.width
                    label: "别名"; sub: "指令里怎么称呼它,如「模拟」「主账户」"
                    Input {
                        width: 220; maximumLength: 24
                        enabled: !(ap.d && ap.d.editing)
                        text: ap.d ? ap.d.alias : ""
                        onEdited: function (t) { if (ap.controller) ap.controller.setDraft("alias", t) }
                    }
                }
                GroupRow {
                    width: parent.width
                    label: "账号"; sub: ap.d ? ap.d.idSub : ""
                    Input {
                        width: 220; maximumLength: 15; placeholder: "如 DU1234567"
                        text: ap.d ? ap.d.accountId : ""
                        onEdited: function (t) { if (ap.controller) ap.controller.setDraft("accountId", t) }
                    }
                }
                GroupRow {
                    width: parent.width
                    label: "类别"; sub: ap.d ? ap.d.kindSub : ""
                    subColor: ap.d && ap.d.mismatch ? Theme.orangeText : Theme.labelSecondary
                    Segmented {
                        small: true
                        options: [{ value: "paper", label: "纸面(模拟)" }, { value: "live", label: "实盘" }]
                        value: ap.d && ap.d.paper ? "paper" : "live"
                        onActivated: function (v) { if (ap.controller) ap.controller.setDraft("paper", v === "paper") }
                    }
                }
                GroupRow {
                    width: parent.width
                    label: "连接"; sub: "经哪条连接下单"
                    Select {
                        small: true; width: 220
                        options: ap.d ? ap.d.connections : []
                        value: ap.d ? ap.d.connection : ""
                        onActivated: function (v) { if (ap.controller) ap.controller.setDraft("connection", v) }
                    }
                }
                GroupRow {
                    width: parent.width
                    label: "默认账户"; sub: "指令里没点名账户时发到它"
                    Segmented {
                        small: true
                        options: [{ value: "yes", label: "是" }, { value: "no", label: "否" }]
                        value: ap.d && ap.d.makeDefault ? "yes" : "no"
                        onActivated: function (v) { if (ap.controller) ap.controller.setDraft("makeDefault", v === "yes") }
                    }
                }
            }
            Item { width: 1; height: 14 }
            ButtonRow {
                width: parent.width
                Button {
                    kind: "primary"; text: "保存…"
                    busy: !!(ap.d && ap.d.save.loading); enabled: !!(ap.d && !ap.d.save.disabled)
                    onClicked: if (ap.controller) ap.controller.saveDraft()
                }
                Button { text: "取消"; onClicked: if (ap.controller) ap.controller.cancelDraft() }
            }
        }
    }

    // ---- 大模型 ---------------------------------------------------------------------------------
    component LlmPanel: Column {
        id: lp
        property var m: ({})
        property var controller: null
        // 提示条下 14 与分节标题的上 24 合并,只剩 24
        Alert { width: parent.width; tone: "info"; rich: true; text: "发给模型的只有指令原文、当前时间、行情快照、账户别名与限额;<b>真实账号、余额、持仓、成交记录不出本机</b>。" }
        SectionTitle { text: "供应商" }
        // .seg-row:30 高、下 14
        Item {
            width: parent.width; height: 30 + 14
            Segmented {
                options: lp.m.providers || []
                value: lp.m.provider || undefined
                onActivated: function (v) { if (lp.controller) lp.controller.setLlm("provider", v) }
            }
        }
        Group {
            width: parent.width
            GroupRow {
                width: parent.width
                label: "模型"
                Select {
                    width: 320
                    options: lp.m.models || []
                    value: lp.m.model || undefined
                    onActivated: function (v) { if (lp.controller) lp.controller.setLlm("model", v) }
                }
            }
            GroupRow {
                width: parent.width
                stacked: true; label: "自定义模型"; sub: "留空则用上面选中的"
                Input { width: parent.width; placeholder: "如 deepseek-chat"; text: lp.m.customModel || ""; onEdited: function (t) { if (lp.controller) lp.controller.setLlm("customModel", t) } }
            }
            GroupRow {
                visible: !!lp.m.needsBaseUrl
                width: parent.width
                stacked: true; label: "Base URL"; sub: "OpenAI 兼容端点"
                Input { width: parent.width; placeholder: "https://api.example.com/v1"; text: lp.m.baseUrl || ""; onEdited: function (t) { if (lp.controller) lp.controller.setLlm("baseUrl", t) } }
            }
        }
        SectionTitle { text: "API Key" }
        Group {
            width: parent.width
            GroupRow {
                width: parent.width
                stacked: true; label: "按供应商分开存于系统凭据库,不落配置、不进日志"
                Input { width: parent.width; password: true; placeholder: "sk-..."; text: lp.m.apiKey || ""; onEdited: function (t) { if (lp.controller) lp.controller.setLlm("apiKey", t) } }
            }
            GroupRow {
                width: parent.width
                label: "当前供应商 Key"
                labelItem: Component {
                    Column {
                        Label { text: "当前供应商 Key"; size: 13 }
                        // AntD Badge 的字是 13px(不跟 sub 的 11px)
                        StatusDot { status: lp.m.keyState || "default"; text: lp.m.keyText || ""; size: 13 }
                    }
                }
                Button { text: "保存"; onClicked: if (lp.controller) lp.controller.saveLlmKey() }
            }
        }
        SectionTitle { text: "调用参数" }
        Group {
            width: parent.width
            GroupRow {
                visible: !!lp.m.supportsEffort
                width: parent.width
                label: "推理档位"; sub: "effort,仅 Anthropic"
                Select {
                    width: 190
                    options: ["low", "medium", "high", "xhigh", "max"].map(function (v) { return { value: v, label: v } })
                    value: lp.m.effort || "high"
                    onActivated: function (v) { if (lp.controller) lp.controller.setLlm("effort", v) }
                }
            }
            NumberRow {
                visible: !!lp.m.supportsTemperature
                width: parent.width
                label: "temperature"; sub: "留空 = 不发送"
                min: 0; max: 2; step: 0.1; placeholder: "不发送"
                value: lp.m.temperature === undefined ? null : lp.m.temperature
                onValueEdited: function (v) { if (lp.controller) lp.controller.setLlm("temperature", v) }
            }
            NumberRow {
                width: parent.width
                label: "max_tokens"
                min: 1000; step: 1000
                value: lp.m.maxTokens === undefined ? null : lp.m.maxTokens
                onValueEdited: function (v) { if (lp.controller) lp.controller.setLlm("maxTokens", v) }
            }
            NumberRow {
                width: parent.width
                label: "超时(秒)"
                min: 1; step: 5
                value: lp.m.timeout === undefined ? null : lp.m.timeout
                onValueEdited: function (v) { if (lp.controller) lp.controller.setLlm("timeout", v) }
            }
        }
        Item { width: 1; height: 14 }
        ButtonRow {
            width: parent.width
            Button { text: "测试连接"; busy: !!lp.m.testing; onClicked: if (lp.controller) lp.controller.testLlm() }
            Button { kind: "primary"; text: "保存配置"; onClicked: if (lp.controller) lp.controller.saveLlm() }
        }
        CardsBlock {
            width: parent.width
            b: !lp.m.test ? ({}) : lp.m.test.working ? { working: lp.m.test.working } : { cards: [lp.m.test.card] }
        }
        HintP { visible: !!lp.m.docs; text: lp.m.docs || "" }
    }

    // ---- Discord 跟单 ----------------------------------------------------------------------------
    component FollowPanel: Column {
        id: fp
        property var m: ({})
        property var controller: null
        readonly property bool ready: !m.loading && m.empty === undefined
        LoadingBlock { visible: !!fp.m.loading; width: parent.width; rows: 4 }
        EmptyState { visible: fp.m.empty !== undefined; width: parent.width; text: fp.m.empty || "" }
        Column {
            visible: fp.ready
            width: parent.width
            Alert {
                width: parent.width
                tone: "warn"; title: "信任的人在频道里发的蝴蝶单与贷方价差,不经确认直接发到券商。"
                text: "只认本地速记完整接住的两种写法:写明价格的买入蝴蝶(「1.8 挂15蝴蝶 15CM」)、写明方向与价格的贷方价差(「7770 7775 bear call -2 -2.5」,区间按收得多的一头挂)。 "
                      + "没写价格、没写 bull put / bear call、蝴蝶带止损、带条件的只提醒、不发,也不交给大模型猜。开关关着时只观察:照样解析、照样记在下面,但一张单都不发。\n"
                      + "对方发错一条、或者对方的 Discord 账号被盗,都会变成你账户里的订单——先只观察几天,再打开。"
            }
            SectionTitle { text: "1 · Bot 与连接" }
            Group {
                width: parent.width
                GroupRow {
                    width: parent.width
                    stacked: true; richLabel: true
                    label: "bot token 只存在系统凭证库(Keychain / 凭据管理器),不写配置、不进日志。<b>不要填你自己账号的 token</b>:用个人账号跑自动化违反 Discord 的条款,会被封号。"
                    Input { width: parent.width; password: true; placeholder: fp.m.tokenPlaceholder || ""; text: fp.m.token || ""; onEdited: function (t) { if (fp.controller) fp.controller.setFollowToken(t) } }
                }
                GroupRow {
                    width: parent.width
                    label: "连接"; sub: fp.m.link ? fp.m.link.text : ""
                    Row {
                        spacing: 6
                        Button { text: "保存 token"; busy: !!(fp.m.saveToken && fp.m.saveToken.loading); enabled: !!(fp.m.saveToken && !fp.m.saveToken.disabled); onClicked: if (fp.controller) fp.controller.saveFollowToken() }
                        Button { text: "重新连接"; busy: !!(fp.m.reconnect && fp.m.reconnect.loading); enabled: !!(fp.m.reconnect && !fp.m.reconnect.disabled); onClicked: if (fp.controller) fp.controller.reconnectFollow() }
                    }
                }
            }
            Primer {
                width: parent.width
                // 组下 14 与 Primer 上 16 合并成 16;下面是分节标题(上 24),Primer 的下 12 并进去
                id_: "follow-setup"; intro: false; topPadding: 16; bottomPadding: 0
                defaultOpen: !!fp.m.setupOpen
                summary: "第一次配置:五步"
                StepList { width: parent.width; topPadding: 10; items: fp.m.setupSteps || [] }
            }
            SectionTitle { text: "2 · 听哪个频道、信任谁" }
            Group {
                width: parent.width
                GroupRow {
                    width: parent.width
                    icon: "sf-antenna"; tint: "indigo"
                    label: "频道 ID"; sub: "bot 加入的服务器里的一个频道"
                    Input { width: 230; placeholder: "一串数字"; text: fp.m.channelId || ""; onEdited: function (t) { if (fp.controller) fp.controller.setFollow("channelId", t) } }
                }
                GroupRow {
                    width: parent.width
                    stacked: true
                    label: "信任的发送者"
                    sub: "只有这些人在这个频道发的消息才会被当成单子。关注过来的公告频道,发送者是那条关注本身(信任它 = 信任能在源频道发公告的人)。"
                    Flow {
                        width: parent.width
                        spacing: 6
                        Repeater {
                            model: fp.m.authors || []
                            AntTag { required property var modelData; text: modelData.text; closable: true; onClosed: if (fp.controller) fp.controller.removeAuthor(modelData.id) }
                        }
                        Label { visible: (fp.m.authors || []).length === 0; text: "还没有信任任何人"; size: 11; color: Theme.labelSecondary }
                    }
                }
                GroupRow {
                    width: parent.width
                    label: "手动添加"; sub: "右键对方头像 →「复制用户 ID」;本地收件的写成 local:显示名"
                    Row {
                        spacing: 6
                        Input { width: 200; placeholder: "用户 ID 或 local:显示名"; text: fp.m.newAuthor || ""; onEdited: function (t) { if (fp.controller) fp.controller.setNewAuthor(t) } }
                        Button { text: "添加"; enabled: !!fp.m.canAdd; onClicked: if (fp.controller) fp.controller.addAuthor("") }
                    }
                }
            }
            Item { width: 1; height: 14 }
            Group {
                width: parent.width
                SwitchRow {
                    width: parent.width
                    icon: "sf-doc"; tint: "teal"
                    label: "本地收件"
                    sub: "对方的私密频道拉不进 bot 时:从你屏幕上的 Discord 窗口把新消息抄进收件文件,软件读文件。不用任何 token,Discord 那边什么都收不到。"
                    checked: !!fp.m.localInbox
                    onToggled: function (on) { if (fp.controller) fp.controller.setFollow("localInbox", on) }
                }
                GroupRow {
                    width: parent.width
                    label: "读哪个频道"; sub: "Discord 窗口标题里的频道名(不含 #)。填了,软件自己读这个窗口,随软件启动和退出;留空就要自己运行脚本。"
                    Input { width: 230; placeholder: "例如 charlie的策略"; text: fp.m.localChannel || ""; onEdited: function (t) { if (fp.controller) fp.controller.setFollow("localChannel", t) } }
                }
                GroupRow {
                    width: parent.width
                    label: "读窗口"; sub: fp.m.reader ? fp.m.reader.text : ""
                    AntTag { visible: !!(fp.m.reader && fp.m.reader.tag); text: fp.m.reader && fp.m.reader.tag ? fp.m.reader.tag.text : ""; color_: fp.m.reader && fp.m.reader.tag ? fp.m.reader.tag.color : "" }
                }
                GroupRow {
                    width: parent.width
                    label: "收件文件"; sub: fp.m.inbox ? fp.m.inbox.text : ""
                    Label { css: 1.47; text: fp.m.inbox ? fp.m.inbox.path : ""; size: 11; color: Theme.labelSecondary }
                }
            }
            Primer {
                width: parent.width
                id_: "follow-inbox-setup"; intro: false; topPadding: 16
                summary: "本地收件怎么用"
                StepList { width: parent.width; topPadding: 10; items: fp.m.inboxSteps || [] }
            }
            // Primer 下 12 与 p.hint 上 7 合并成 12(已在 Primer 里);p.hint 下面紧贴着组
            HintP { topPadding: 0; text: "频道里最近的消息(这次看到的,加上收件文件里已有的):" }
            Group {
                visible: (fp.m.seen || []).length > 0
                width: parent.width
                Repeater {
                    model: fp.m.seen || []
                    GroupRow {
                        id: seenRow
                        required property var modelData
                        width: fp.width
                        sub: modelData.sub
                        // 名字那一行混着 11px 的 id(.muted.mono 在这里不是等宽,只是小号二级色;基线对齐)
                        labelItem: Component {
                            Row {
                                spacing: 4
                                Label { id: seenName; anchors.verticalCenter: parent.verticalCenter; text: seenRow.modelData.name; size: 13 }
                                Label { anchors.baseline: seenName.baseline; text: seenRow.modelData.id; size: 11; color: Theme.labelSecondary }
                                AntTag { visible: seenRow.modelData.local; anchors.verticalCenter: parent.verticalCenter; text: "本地收件" }
                                // 收件文件里原有的:只列出来,没有拿去判定、发单
                                AntTag { visible: !!seenRow.modelData.history; anchors.verticalCenter: parent.verticalCenter; text: "之前收到 · 未处理" }
                            }
                        }
                        Item {
                            width: childrenRect.width; height: childrenRect.height
                            AntTag { visible: modelData.trusted; text: "已信任"; color_: "success" }
                            Button { visible: !modelData.trusted; small: true; text: "信任"; onClicked: if (fp.controller) fp.controller.addAuthor(modelData.id) }
                        }
                    }
                }
            }
            EmptyState { visible: !!fp.m.seenEmpty; compact: true; width: parent.width; text: fp.m.seenEmpty || "" }
            HintP { visible: !!fp.m.trustHint; topPadding: 14; text: "点某一条右边的「信任」,就把它的发送者加进名单;保存之后才生效。" }
            SectionTitle { text: "3 · 发到哪、最多亏多少" }
            Group {
                width: parent.width
                hint: "这三个上限是跟单多加的一道;「设置」里的限额、保护规则、熔断照常生效,取更严的那个。"
                GroupRow {
                    width: parent.width
                    stacked: true
                    label: "发到这些账户"; sub: "一个都不勾 = 默认账户。勾两个就每单各发一份,上限各算各的。"
                    Flow {
                        width: parent.width
                        spacing: 8
                        Repeater {
                            model: fp.m.accounts || []
                            // AntD 的勾选项:字后面还有 8 的内边距,高是 13px 字的行框 19.11
                            Checkbox { required property var modelData; rightPadding: 8; height: 19.11; text: modelData.label; checked: modelData.checked; onToggled: function (on) { if (fp.controller) fp.controller.toggleFollowAccount(modelData.value, on) } }
                        }
                    }
                }
                NumberRow {
                    width: parent.width
                    icon: "sf-dollar"; tint: "red"
                    label: "每单最坏亏损上限"; sub: "USD。蝴蝶 = 张数 × 100 × 权利金;贷方价差 = 张数 × 100 ×(宽度 − 收到的权利金)"
                    min: 1; step: 50
                    value: fp.m.maxRisk === undefined ? null : fp.m.maxRisk
                    onValueEdited: function (v) { if (fp.controller) fp.controller.setFollow("maxRisk", v) }
                }
                NumberRow {
                    width: parent.width
                    icon: "sf-layers"; tint: "purple"
                    label: "每天最多跟几单"; sub: fp.m.perDaySub || ""
                    min: 1; max: 100; step: 1
                    value: fp.m.perDay === undefined ? null : fp.m.perDay
                    onValueEdited: function (v) { if (fp.controller) fp.controller.setFollow("perDay", v) }
                }
                NumberRow {
                    width: parent.width
                    icon: "sf-clock"; tint: "gray"
                    label: "消息多旧就不跟"; sub: "秒。断线之后补到的旧消息不追"
                    min: 1; max: 600; step: 5
                    value: fp.m.maxAge === undefined ? null : fp.m.maxAge
                    onValueEdited: function (v) { if (fp.controller) fp.controller.setFollow("maxAge", v) }
                }
            }
            SectionTitle { text: "4 · 成交之后" }
            Group {
                width: parent.width
                hint: "软件只跟对方的开仓:他什么时候走、止盈止损设在哪,软件不知道。上面这一项是用你自己的规则替跟进来的蝴蝶收尾,不是跟着他平。"
                SwitchRow {
                    width: parent.width
                    icon: "sf-target"; tint: "green"
                    label: "成交后自动建追踪"
                    sub: "跟进来的单子成交之后,软件自己给它建一条持仓追踪并打开「到价自动平仓」:蝴蝶按蝶式预设(分档利润回撤),贷方价差收回 60% 权利金止盈、消息里写了「站稳 / 跌破 N 止损」的再加标的止损线;触发了直接发平仓单,不再问你。软件关着、电脑睡着时不盯。"
                    checked: !!fp.m.trackFly
                    onToggled: function (on) { if (fp.controller) fp.controller.setFollow("trackFly", on) }
                }
                GroupRow {
                    width: parent.width
                    icon: "sf-clock"; tint: "gray"
                    label: "到点平仓(美东)"
                    sub: "自动建的那条追踪到这个钟点持仓还在就平,写成 HH:MM(如 15:45);留空 = 不设。建追踪时这个钟点已经过了,就落在下一次(第二天)。只在上面那一项开着时有用。"
                    Input { width: 110; placeholder: "如 15:45"; enabled: !!fp.m.trackFly; text: fp.m.trackExitAt || ""; onEdited: function (t) { if (fp.controller) fp.controller.setFollow("trackExitAt", t) } }
                }
                GroupRow {
                    visible: (fp.m.tracksPending || 0) > 0
                    width: parent.width
                    label: "在等成交"
                    sub: "有 %1 张跟进去的单子还没成交(或刚成交):成交之后几秒内自动建追踪,建好、建不了都会发通知。".arg(fp.m.tracksPending || 0)
                    AntTag { text: "%1 张".arg(fp.m.tracksPending || 0) }
                }
            }
            SectionTitle { text: "5 · 开关" }
            Group {
                width: parent.width
                SwitchRow {
                    width: parent.width
                    icon: "sf-bolt"; tint: "orange"
                    label: "自动跟单"; sub: "关着 = 只观察。关是当场生效的,开要点保存"
                    checked: !!fp.m.enabled
                    onToggled: function (on) { if (fp.controller) fp.controller.setFollowEnabled(on) }
                }
            }
            Item { width: 1; height: 14 }
            Column {
                visible: (fp.m.problems || []).length > 0
                width: parent.width
                Alert { width: parent.width; tone: "warn"; title: "还不能保存"; text: (fp.m.problems || []).map(function (p) { return "• " + p }).join("\n") }
                Item { width: 1; height: 14 }
            }
            ButtonRow {
                width: parent.width; collapsed: true
                Button { kind: "primary"; text: "保存"; busy: !!(fp.m.save && fp.m.save.loading); enabled: !!(fp.m.save && !fp.m.save.disabled); onClicked: if (fp.controller) fp.controller.saveFollow() }
                Label { visible: !!fp.m.dirty; anchors.verticalCenter: parent.verticalCenter; text: "有未保存的修改"; size: 11; color: Theme.labelSecondary }
            }
            SectionTitle { text: "最近的信号"; count: (fp.m.recent || []).length }
            Group {
                visible: (fp.m.recent || []).length > 0
                width: parent.width
                Repeater {
                    model: fp.m.recent || []
                    GroupRow {
                        required property var modelData
                        width: fp.width
                        label: modelData.label
                        sub: modelData.sub + (modelData.quote ? "\n" + modelData.quote : "")
                        AntTag { text: modelData.tag; color_: modelData.tone === "default" ? "" : modelData.tone }
                    }
                }
            }
            EmptyState {
                visible: (fp.m.recent || []).length === 0
                compact: true; width: parent.width
                text: "信任的发送者发来像单子的消息之后,每一条跟了没有、为什么,都记在这里;连着 TWS 时还会记下处理完那一刻的盘口,对着对方写的价"
            }
            // 最后那个组的下 14 留在页底
            Item { width: 1; height: 14 }
        }
    }
}
