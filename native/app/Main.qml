import QtQuick
import Dafri.Kit

// 壳(同 Electron 版的 App.tsx + styles.css 的壳层布局):透明的工具栏浮着玻璃胶囊;下面左边一块浮着的玻璃侧栏(四周留 10),
// 右边是内容区。窗口底是分组灰 + 两抹几乎看不出的冷色。macOS 上内容铺进标题栏(同 Electron 的 hiddenInset),红绿灯浮在工具栏左端。
// 页面从这里往后按用得多少搬:持仓追踪 → 交易指令 → 总览 → 行情 → 其余;没搬的那一页显示占位,说清楚它还在 Electron 版里。
Window {
    id: root
    // 同 Electron 版 createWindow:1360 × 900,最小 900 × 700(1000 以下侧栏收成图标栏)
    width: 1360
    height: 900
    minimumWidth: 900
    minimumHeight: 700
    visible: true
    title: "Datrix"
    color: Theme.bgWindow
    flags: Qt.Window | Qt.ExpandedClientAreaHint | Qt.NoTitleBarBackgroundHint

    /// C++ 的 StatusStore;不拉引擎时(--engine none、自检)是 null
    property var statusStore: null
    /// 页面到引擎的唯一一条路(C++ 的 QmlBridge → shell::Bridge):bridge.call(方法, 入参, 回调)、bridge.ask(确认的内容, 回调)
    property var bridge: null
    /// 顶栏的两个按钮(shell/shell_actions)
    property var actions: null
    /// 条款同意(shell/consent_model)
    property var consent: null
    /// 提醒(shell/alerter)与置顶小窗的列表(shell/popup_rules 的 PopupQueue)、窗口那一半(app/popup_controller)
    property var alerter: null
    property var popupQueue: null
    property var popupController: null
    /// 「支持与数据」(app/support_service):关于、接入页用
    property var support: null
    /// 顶栏下面的两条:重要事件(shell/events_store)、宏观行情带(shell/macro_store)
    property var events: null
    property var macro: null
    /// 价位警告(盯单、流水、上次检查);板块页与持仓追踪页读它
    property var alerts: null
    /// 持仓追踪(持仓、追踪、每秒盯盘结果、托管对账)
    property var tracker: null
    /// 持仓追踪页的接线(模型、按钮、新建追踪)
    property var trackerPage: null
    /// 实时 SPX 与关口提醒;蝴蝶测算面板读它
    property var spot: null
    /// SPX 日内剧本、优质股异动、情报(时间线、档案、⌘K)
    property var playbook: null
    property var quality: null
    property var intel: null
    /// 新版本检查(顶栏的「新版本」、「关于」页)
    property var updates: null
    /// 交易指令页:输入与提交(shell/trade_composer,对应 store/trade)与页面接线(shell/trade_controller)
    property var composer: null
    property var tradePage: null
    property var terrain: null
    property var fly: null
    property var board: null
    property var recordsPage: null
    /// 行情页(K 线读盘 + 盘口,shell/market_controller)
    property var marketPage: null
    /// 想法页(shell/ideas_controller)
    property var ideasPage: null
    /// 板块页(shell/sectors_controller)
    property var sectorsPage: null
    /// 扫描页(shell/screener_controller)
    property var screenerPage: null
    /// 回测页(shell/backtest_controller)
    property var backtestPage: null
    /// 交易分析页(shell/review_controller)
    property var reviewPage: null
    /// 绩效体检页(shell/performance_controller)
    property var performancePage: null
    /// 情报页、档案抽屉、⌘K 查标的(shell/intel_controller)
    property var intelPage: null
    /// 接入页(shell/access_controller)
    property var accessPage: null
    /// 设置页、关于页(shell/settings_controller、about_controller)
    property var settingsPage: null
    /// 菜单栏那一层(app/desktop_shell):别的平台上 Ctrl+R / Ctrl+M 从这里接
    property var desktopShell: null
    property var aboutPage: null
    property var devCharts: null
    property var flyStore: null
    property string engineMode: "native"

    readonly property var st: statusStore ? statusStore.status : ({})
    readonly property bool mac: Qt.platform.os === "osx"

    /// 通知流(React 版 store/notify.ts):连接 / 熔断这些动作的结果写在这里,订单看板那一页显示。页面搬过来之前只记不显示
    /// --open page:x@y:页面数据到了之后把内容区滚到 y
    property real devScrollTo: -1
    function devScroll() {
        var page = pageLoader.item
        if (devScrollTo >= 0 && page && page.contentY !== undefined) page.contentY = Math.min(devScrollTo, Math.max(0, page.contentHeight - page.height))
    }
    /// 截图对比用(main.cpp 的 --open):先打开抽屉或对话框再抓
    function devOpen(what) {
        if (what === "fly-entry") { flyEntryModal.open(); return }
        if (what === "terrain") { terrainModal.open(); if (root.terrain) root.terrain.refresh(); return }
        // chart:<n>:图表对比(场景见 native/tests/fixtures/chart_scale_cases.json),铺在窗口左上角、同浏览器里的尺寸
        if (what.indexOf("chart:") === 0 && root.devCharts) {
            var c = root.devCharts.load(Number(what.slice(6)))
            devChartBox.width = c.w; devChartBox.height = c.h; devChartBox.visible = true
            return
        }
        // page:<侧栏项>[@滚动到的 y]:切到那一页(截图对比用)
        // page:<侧栏项>[@滚动到的 y][#form:<持仓 key>]:切到那一页(持仓追踪页可以顺带展开某一张持仓的表单)
        if (what.indexOf("page:") === 0) {
            var rest = what.slice(5), form = "", focus = ""
            if (rest.indexOf("#focus:") >= 0) { focus = rest.slice(rest.indexOf("#focus:") + 7); rest = rest.slice(0, rest.indexOf("#focus:")) }
            if (rest.indexOf("#form:") >= 0) { form = rest.slice(rest.indexOf("#form:") + 6); rest = rest.slice(0, rest.indexOf("#form:")) }
            var spec = rest.split("@")
            if (focus !== "") { navigateTo(spec[0], focus); if (spec.length > 1) devScrollTo = Number(spec[1]); return }
            // page:trade#parse:填一条指令并按「解析并校验」(预览引擎回 mock 的解析结果;截图对比结果卡片用)
            // page:trade#form:fly / fly-run(填好一只蝶并测算)/ playbook:右栏翻到那一面
            if ((form === "fly" || form === "fly-run" || form === "playbook") && root.composer) {
                Nav.navigate("trade")
                root.composer.pane = form === "playbook" ? "playbook" : "fly"
                if (form === "fly-run" && root.flyStore) { root.flyStore.patch({ center: "7750", targetSpot: "7745", targetTime: "14:30" }); Qt.callLater(function () { root.flyStore.run(false) }) }
                if (spec.length > 1) devScrollTo = Number(spec[1])
                return
            }
            // page:records#form:<记录 id>:打开那一条的单据(截图对比详情用)
            if (spec[0] === "records" && form !== "" && root.recordsPage) { Nav.navigate("records"); root.recordsPage.open(form); if (spec.length > 1) devScrollTo = Number(spec[1]); return }
            // page:board#form:feed:往通知流里推两条(看板的通知那一块接没接上,tests/tst_shell 的 boardShowsTheFeed 用)
            // page:screener#form:scan:点「扫描」(预览引擎回 mock 的 RS 与背离,出结果后复盘榜首那只);scan-leaders 再加「筛选强势股」
            if ((form === "scan" || form === "scan-leaders") && root.screenerPage) {
                Nav.navigate("screener")
                Qt.callLater(function () { root.screenerPage.run(); if (form === "scan-leaders") root.screenerPage.runLeaders() })
                if (spec.length > 1) devScrollTo = Number(spec[1])
                return
            }
            // page:backtest#form:run|sweep|custom|option:填 NVDA 跑一次 / 换均线交叉扫参数 / 换自定义策略 / 换买入蝴蝶(截图对比用,同在浏览器里点一遍)
            if ((form === "run" || form === "sweep" || form === "custom" || form === "option") && spec[0] === "backtest" && root.backtestPage) {
                Nav.navigate("backtest")
                // 策略目录读回来之后再点(扫参数要先有可扫的策略)
                devRetry.job = function () {
                    var bt = root.backtestPage
                    if (!bt.page.strategyOptions || bt.page.strategyOptions.length === 0) return false
                    bt.setSymbol("NVDA")
                    if (form === "run") bt.run()
                    else if (form === "custom") bt.setStrategy("custom")
                    else if (form === "option") bt.setInstType("butterfly")
                    else { bt.setStrategy("sma_cross"); bt.runSweep() }
                    return true
                }
                devRetry.start()
                if (spec.length > 1) devScrollTo = Number(spec[1])
                return
            }
            // page:review#form:run|stock:读回候选后点「分析」(默认那一笔是蝶)/ 先选股票那一笔再分析(截图对比用)
            if ((form === "run" || form === "stock") && spec[0] === "review" && root.reviewPage) {
                Nav.navigate("review")
                devRetry.job = function () {
                    var rv = root.reviewPage
                    if (!rv.page.options || rv.page.options.length === 0) return false
                    if (form === "stock") rv.select("stk:p9001")
                    rv.analyze()
                    return true
                }
                devRetry.start()
                if (spec.length > 1) devScrollTo = Number(spec[1])
                return
            }
            // page:intel#form:dossier[-<滚动>]|lookup:时间线读回来之后打开 NVDA 的档案(抽屉正文滚到那里)/ 开过 NVDA 再打开查标的(截图对比用)
            if ((form.indexOf("dossier") === 0 || form === "lookup") && spec[0] === "intel" && root.intelPage) {
                Nav.navigate("intel")
                devRetry.job = function () {
                    var it = root.intelPage
                    if (!it.page.timeline || !it.page.timeline.groups) return false
                    if (it.dossier.symbol !== "NVDA") it.openDossier("NVDA")
                    if (form === "lookup") { it.closeDossier(); it.setLookupOpen(true); return true }
                    // 滚动要等档案读回来(内容没撑开时滚不过去)
                    if (!it.dossier.ready) return false
                    if (form.length > 7) { var y = Number(form.slice(7)); Qt.callLater(function () { dossierDrawer.bodyScroll = y }) }
                    return true
                }
                devRetry.start()
                return
            }
            // page:performance#form:signals|sizer|share:读回账本后点「给信号打分」/ 填权益 50000、比例 1.5 / 打开分享卡片(截图对比用)
            if ((form === "signals" || form === "sizer" || form === "share") && spec[0] === "performance" && root.performancePage) {
                Nav.navigate("performance")
                devRetry.job = function () {
                    var pf = root.performancePage
                    if (!pf.page.hasData) return false
                    if (form === "signals") pf.scoreSignals()
                    else if (form === "share") { if (!pageLoader.item || !pageLoader.item.openShare) return false; pageLoader.item.openShare() }
                    else { pf.setSizerEquity(50000); pf.setSizerPct(1.5) }
                    return true
                }
                devRetry.start()
                if (spec.length > 1) devScrollTo = Number(spec[1])
                return
            }
            // page:settings#form:open|problems:读回设置后把保护规则与风险预算全打开(冷却挡同一个结构、按账户当日盈亏算)/
            // 再清空单笔名义金额并点「保存设置」(问题清单摆出来)(截图对比用)
            // page:settings#form:redup:在设置页把涨跌配色换成红涨绿跌(测 Theme → Alerter 的那一份记录)
            if (form === "redup" && spec[0] === "settings") { Nav.navigate("settings"); Theme.setUpDown("red-up"); return }
            if ((form === "open" || form === "problems") && spec[0] === "settings" && root.settingsPage) {
                Nav.navigate("settings")
                devRetry.job = function () {
                    var st = root.settingsPage
                    if (st.model.loading) return false
                    for (var k of ["slGuard", "ddGuard", "coolOn", "dailyOn", "rbOn"]) st.setField(k, true)
                    st.setField("coolScope", "position")
                    st.setField("dailyBasis", "account")
                    if (form === "problems") { st.setField("notional", null); st.save() }
                    return true
                }
                devRetry.start()
                if (spec.length > 1) devScrollTo = Number(spec[1])
                return
            }
            if (form === "feed") { Nav.navigate(spec[0]); root.pushNotification("测试通知", "第一条"); root.pushNotification("测试通知二", ""); return }
            if (form === "parse" && root.tradePage) { Nav.navigate("trade"); root.composer.text = "1.8 挂15蝴蝶 15CM"; Qt.callLater(function () { root.tradePage.submit(false) }); return }
            Nav.navigate(spec[0])
            if (spec.length > 1) devScrollTo = Number(spec[1])
            if (form !== "" && root.trackerPage) Qt.callLater(function () { root.trackerPage.toggleForm(form) })
            return
        }
        if (what === "all") eventList.open()
        else if (what === "act" && root.events && root.events.strip.items.length) eventActions.openFor(root.events.strip.items[0].id)
        else if (what === "popup" && root.alerter) {
            root.alerter.testPopup()
            root.alerter.announce({ id: "dev:level", kind: "level", symbol: "SPX", title: "SPX 下破 7700", body: "现价 7698.4,刚从上方穿过 7700", tone: "down", at: Date.now() - 60000, page: "trade" }, "", false)
            root.alerter.announce({ id: "dev:event", kind: "event", symbol: "SPX", title: "30 分钟后公布 CPI(9月)", body: "今天 20:30(美东 08:30) · CPI 月率:预期 0.3%,前值 0.4% · 公布前后指数常有跳空", tone: "info", at: Date.now() - 120000, page: "trade" }, "", false)
        }
    }
    // 截图对比用:每 100 毫秒试一次 job,它回 true 就停
    Timer {
        id: devRetry
        property var job: null
        property int tries: 0
        interval: 100; repeat: true
        onRunningChanged: if (running) tries = 0
        // 最多试 10 秒:目录一直不回来就算了(免得之后真去那一页时被自动填一遍)
        onTriggered: if (!job || job() || ++tries >= 100) stop()
    }
    function pushNotification(title, body) {
        // 通知流只有一份,在 C++(shell/board_controller,同 store/notify.ts):看板页读它的模型
        if (root.board) root.board.pushNotification(title, body || "")
    }

    Connections {
        target: root.actions
        ignoreUnknownSignals: true
        function onNotify(title, body) { root.pushNotification(title, body) }
    }
    // 涨跌配色:只记一份(Alerter 的 alerts/updown,提醒小窗跟着它);设置页改的是 Theme,这里写回 Alerter
    Component.onCompleted: if (root.alerter) Theme.upDown = root.alerter.updown
    Connections {
        target: Theme
        function onUpDownChanged() { if (root.alerter && root.alerter.updown !== Theme.upDown) root.alerter.updown = Theme.upDown }
    }
    // 跳到接入的某一节(tws / futu / accounts / llm / follow,同 React 的 navigate('futu')):交给接入页切子页签,用完清掉
    Connections {
        target: Nav
        function onSubsChanged() {
            var sub = Nav.subs.access
            if (!sub || !root.accessPage) return
            root.accessPage.setSub(sub)
            var s = Object.assign({}, Nav.subs); delete s.access; Nav.subs = s
        }
    }
    Connections {
        target: root.accessPage
        ignoreUnknownSignals: true
        function onNotify(title, body) { root.pushNotification(title, body) }
    }
    // 交易记录页:蝴蝶单的「分析这笔交易」去交易分析页;点代码徽章打开那只标的的档案(情报)。
    // 这两页搬过来之前只切到那一页的位置(带过去的 id / 标的等页面搬过来时接上)
    Connections {
        target: root.recordsPage
        ignoreUnknownSignals: true
        function onReviewRequested(id) { Nav.navigate("review") }
        // 点代码徽章:打开那只标的的档案(全站共用的抽屉,不切页)
        function onDossierRequested(symbol) { if (root.intelPage) root.intelPage.openDossier(symbol) }
    }
    // 提醒写进通知流的那一条(shell/alerter 的 notified;重要事件报的提醒由 C++ 直接交给它)
    Connections {
        target: root.alerter
        ignoreUnknownSignals: true
        function onNotified(title, body) { root.pushNotification(title, body) }
    }
    /// 提醒小窗里点了「查看」:跳到对应页(quality 这类旧页名由 Nav 换成侧栏项)
    // 弹窗的「查看」:切页;去持仓追踪的还要滚到「正在追踪」、把那只标的的卡片闪一下(pages/Tracker.tsx 的 useNavFocus)
    function navigateTo(page, symbol) {
        Nav.navigate(page)
        if (page === "tracker" && symbol && root.trackerPage) Qt.callLater(function () { root.trackerPage.focusSymbol(symbol) })
        // 带着标的跳到交易指令页的只有关口提醒的「查看」:右栏翻到蝴蝶测算
        if (page === "trade" && symbol && root.tradePage) root.tradePage.focus()
        // 标的档案的「K 线」:换成它来分析(页面挂上之后)
        // 价位穿越、异动弹窗的「查看」:那一只的行滚到眼前、闪一下
        if (page === "sectors" && symbol && root.sectorsPage) Qt.callLater(function () { root.sectorsPage.focus(symbol) })
        if (page === "market" && symbol && root.marketPage) Qt.callLater(function () { root.marketPage.pick(symbol) })
        // 「持仓的票被提到」的「查看」:直接打开它的档案(pages/Intel.tsx 的 useNavFocus)
        if (page === "intel" && symbol && root.intelPage) root.intelPage.openDossier(symbol)
    }
    /// 「写进指令框」(时间线上像单子的消息、事件的「应对」):只写、不发;翻到解析结果那一面、切到交易指令页、说一句
    function writeInstruction(text) {
        if (root.composer) { root.composer.appendInstruction(text); root.composer.pane = "result" }
        Nav.navigate("trade")
        if (root.statusStore) root.statusStore.showInfo("已写进指令框。先点「解析并校验」核对腿与权利金,再决定发不发。")
    }

    AlertPopup {
        objectName: "alertPopup"
        transientParent: null
        queue: root.popupQueue
        controller: root.popupController
    }

    // 窗口底的两抹冷色(--ambient):左上 70% × 55% 的蓝、右下 60% × 50% 的靛,72% 处淡到没有
    Ambient { anchors.fill: parent }

    // ⌘/Ctrl + 1…9:按侧栏顺序切页
    Repeater {
        model: 9
        Item {
            Shortcut { sequence: "Ctrl+" + (index + 1); onActivated: if (Nav.items[index]) Nav.navigate(Nav.items[index].key) }
        }
    }
    // 别的平台菜单栏还没挂进窗口,菜单项的快捷键不起作用:Ctrl+R(刷新状态、交易记录与条件单)、Ctrl+M(最小化)在这里接。
    // macOS 上是全局菜单栏接的,这里关着(不然按一下触发两次)
    Shortcut {
        sequence: "Ctrl+R"
        enabled: !!root.desktopShell && Qt.platform.os !== "osx"
        onActivated: root.desktopShell.refreshFromMenu()
    }
    Shortcut {
        sequence: "Ctrl+M"
        enabled: !!root.desktopShell && Qt.platform.os !== "osx"
        onActivated: root.desktopShell.minimizeFromMenu()
    }
    // ⌘⇧H:只熔断、不解除(同 Electron 版的菜单快捷键)。macOS 上由菜单栏那一项接(app/desktop_shell);
    // 别的平台菜单栏还没接进窗口,先在这里接
    Shortcut {
        sequence: "Ctrl+Shift+H"
        enabled: root.actions !== null && Qt.platform.os !== "osx"
        onActivated: root.actions.haltFromMenu("菜单/快捷键触发熔断", !root.visible)
    }

    Topbar {
        id: topbar
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        leadingInset: root.mac && root.visibility !== Window.FullScreen ? 88 : 12
        topbarState: root.statusStore ? root.statusStore.topbar : ({})
        busy: root.actions ? root.actions.busy : false
        update: root.updates ? root.updates.badge : null
        onUpdateClicked: Nav.navigate("about")
        onConnectClicked: if (root.actions) root.actions.toggleBrokerConnection()
        onBreakerClicked: if (root.actions) root.actions.toggleBreaker()
    }

    EventStrip {
        id: eventStrip
        anchors.top: topbar.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        height: implicitHeight
        store: root.events
        onAct: function (id) { eventActions.openFor(id) }
        onOpenAll: eventList.open()
        onOpenSectors: Nav.navigate("sectors")
    }
    MacroStrip {
        id: macroStrip
        anchors.top: eventStrip.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        height: implicitHeight
        store: root.macro
    }

    Sidebar {
        id: sidebar
        anchors.top: macroStrip.bottom
        anchors.bottom: parent.bottom
        anchors.left: parent.left
        anchors.leftMargin: 10
        anchors.bottomMargin: 10
        narrow: root.width <= 1000
        width: narrow ? 60 : 228
        counts: ({ pending: root.st.pending_count || 0, anomaly: root.quality ? root.quality.unread : 0, intel: root.intel ? root.intel.unread : 0 })
    }

    Item {
        id: content
        anchors.top: macroStrip.bottom
        anchors.bottom: parent.bottom
        anchors.left: sidebar.right
        anchors.right: parent.right
        clip: true
        Loader {
            id: pageLoader
            anchors.fill: parent
            // 搬过来的页面:持仓追踪;别的还是占位
            sourceComponent: Nav.current === "tracker" && root.trackerPage ? trackerPage
                           : Nav.current === "trade" && root.tradePage ? tradePageComp
                           : Nav.current === "board" && root.board ? boardPageComp
                           : Nav.current === "records" && root.recordsPage ? recordsPageComp
                           : Nav.current === "market" && root.marketPage ? marketPageComp
                           : Nav.current === "ideas" && root.ideasPage ? ideasPageComp
                           : Nav.current === "sectors" && root.sectorsPage ? sectorsPageComp
                           : Nav.current === "screener" && root.screenerPage ? screenerPageComp
                           : Nav.current === "backtest" && root.backtestPage ? backtestPageComp
                           : Nav.current === "review" && root.reviewPage ? reviewPageComp
                           : Nav.current === "performance" && root.performancePage ? performancePageComp
                           : Nav.current === "intel" && root.intelPage ? intelPageComp
                           : Nav.current === "access" && root.accessPage ? accessPageComp
                           : Nav.current === "settings" && root.settingsPage ? settingsPageComp
                           : Nav.current === "about" && root.aboutPage ? aboutPageComp : placeholder
        }
        Component {
            id: trackerPage
            TrackerPage { controller: root.trackerPage }
        }
        Component {
            id: recordsPageComp
            RecordsPage { controller: root.recordsPage }
        }
        Component {
            id: sectorsPageComp
            SectorsPage { controller: root.sectorsPage }
        }
        Component {
            id: screenerPageComp
            ScreenerPage { controller: root.screenerPage }
        }
        Component {
            id: backtestPageComp
            BacktestPage { controller: root.backtestPage }
        }
        Component {
            id: reviewPageComp
            ReviewPage { controller: root.reviewPage }
        }
        Component {
            id: performancePageComp
            PerformancePage { controller: root.performancePage }
        }
        Component {
            id: intelPageComp
            IntelPage { controller: root.intelPage; onWrite: function (t) { root.writeInstruction(t) } }
        }
        Component {
            id: settingsPageComp
            SettingsPage { controller: root.settingsPage }
        }
        Component {
            id: aboutPageComp
            AboutPage { controller: root.aboutPage }
        }
        Component {
            id: accessPageComp
            AccessPage { controller: root.accessPage }
        }
        Component {
            id: ideasPageComp
            IdeasPage { controller: root.ideasPage }
        }
        Component {
            id: marketPageComp
            MarketPage { controller: root.marketPage }
        }
        Component {
            id: boardPageComp
            BoardPage { controller: root.board }
        }
        Component {
            id: tradePageComp
            TradePage { onOpenFlyEntry: flyEntryModal.open(); onOpenTerrain: { terrainModal.open(); if (root.terrain) root.terrain.refresh() } controller: root.tradePage; composer: root.composer; fly: root.fly; flyStore: root.flyStore; navigate: function (key) { Nav.navigate(key) } }
        }
        Component {
            id: placeholder
            PagePlaceholder { label: (Nav.items.filter(function (i) { return i.key === Nav.current })[0] || {}).label || "" }
        }
    }

    Notice {
        anchors.horizontalCenter: parent.horizontalCenter
        y: 24
        z: 50
        text: root.statusStore ? root.statusStore.banner : ""
        info: root.statusStore ? root.statusStore.bannerInfo : false
        onClosed: if (root.statusStore) root.statusStore.hideBanner()
    }

    EventList {
        id: eventList
        store: root.events
        status: root.statusStore
        onOpenSettings: Nav.navigate("settings")
    }
    EventActions {
        id: eventActions
        store: root.events
        bridge: root.bridge
        connected: !!root.st.broker_connected
        onWrite: function (text) { root.writeInstruction(text) }
    }
    // 全站共用的标的档案与 ⌘K 查标的(shell/DossierHost.tsx):哪一页都能开
    DossierDrawer {
        id: dossierDrawer
        controller: root.intelPage
        onMarket: function (s) { root.navigateTo("market", s) }
        // 「写指令」:指令框换成「代码 」开头,翻到解析结果,切过去(不说话)
        onWrite: function (t) { if (root.composer) { root.composer.text = t; root.composer.pane = "result" } Nav.navigate("trade") }
        onWriteTimeline: function (t) { root.writeInstruction(t) }
    }
    LookupModal { controller: root.intelPage }
    // ⌘K(Windows 上 Ctrl+K):在输入框里也生效,这组键在这个软件里没有别的含义
    // 只在主窗口是活动窗口时:原生确认框开着时按了不该在后面弹出查标的(Electron 的确认框在主进程,渲染层收不到按键)。
    // macOS 上 Qt 把 Ctrl 映射成 ⌘、物理 Control 是 Meta:原版认 metaKey || ctrlKey,两个都要
    Shortcut {
        sequences: ["Ctrl+K", "Meta+K"]
        context: Qt.ApplicationShortcut
        enabled: !!root.intelPage && root.active
        onActivated: root.intelPage.setLookupOpen(true)
    }

    ConsentGate {
        anchors.fill: parent
        z: 100
        model: root.consent
    }

    component Ambient: Item {
        Shape2 { cx: 0.10; cy: 0.0; rx: 0.70; ry: 0.55; tone: Theme.ambientA }
        Shape2 { cx: 0.95; cy: 1.0; rx: 0.60; ry: 0.50; tone: Theme.ambientB }
    }
    // 一团椭圆的径向渐变(CSS 的 radial-gradient(rx ry at cx cy)):在单位圆里画,再按 rx : ry 拉伸
    component Shape2: Canvas {
        property real cx; property real cy; property real rx; property real ry
        property color tone
        width: parent.width * rx * 2
        height: parent.height * ry * 2
        x: parent.width * cx - width / 2
        y: parent.height * cy - height / 2
        onPaint: {
            var ctx = getContext("2d")
            ctx.reset()
            ctx.scale(width / 2, height / 2)
            ctx.translate(1, 1)
            var g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
            g.addColorStop(0, tone)
            g.addColorStop(0.72, Qt.rgba(tone.r, tone.g, tone.b, 0))
            ctx.fillStyle = g
            ctx.fillRect(-1, -1, 2, 2)
        }
        onToneChanged: requestPaint()
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
    }
    // 开发用的图表对比(devOpen("chart:<n>")):盖在最上面,白底,同浏览器里 #host 的位置
    Rectangle {
        id: devChartBox
        visible: false
        z: 1000
        color: "#ffffff"
        Chart { anchors.fill: parent; source: root.devCharts ? root.devCharts.source : null }
    }

    Modal {
        id: terrainModal
        objectName: "terrainModal"
        title: "SPX 地形回放"
        panelWidth: 1020
        TerrainReplay { width: parent.width; controller: root.terrain }
    }
    Modal {
        id: flyEntryModal
        title: "蝴蝶开仓复核"
        panelWidth: 940
        FlyEntry { width: parent.width; controller: root.fly }
    }

}
