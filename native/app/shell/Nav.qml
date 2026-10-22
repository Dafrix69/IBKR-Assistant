pragma Singleton
import QtQuick
import QtCore

// 侧栏三组、15 项,按"多久用一次"分层。照 shell/nav.ts;图标名对 kit/icons/(React 版 ui/Icons.tsx 的同一份线稿)。
// 徽标:board 显示排队等待触发的订单数,sectors(股票池)显示没看过的异动条数,intel 显示没看过的"持仓的票被提到"。
QtObject {
    id: nav
    readonly property var groups: [
        { key: "work", title: "工作区", bottom: false, items: [
            { key: "trade", icon: "sf-pencil", label: "交易指令", badge: "" },
            { key: "board", icon: "sf-board", label: "订单看板", badge: "pending" },
            { key: "records", icon: "sf-doc", label: "交易记录", badge: "" },
            { key: "tracker", icon: "sf-target", label: "持仓追踪", badge: "" } ] },
        { key: "research", title: "研究", bottom: false, items: [
            { key: "market", icon: "sf-candles", label: "行情", badge: "" },
            { key: "ideas", icon: "sf-bulb", label: "想法", badge: "" },
            { key: "sectors", icon: "sf-squares", label: "板块", badge: "anomaly" },
            { key: "screener", icon: "sf-scan", label: "扫描", badge: "" },
            { key: "backtest", icon: "sf-chart", label: "回测", badge: "" },
            { key: "review", icon: "sf-review", label: "交易分析", badge: "" },
            { key: "performance", icon: "sf-gauge", label: "绩效体检", badge: "" },
            // 放在研究组末尾:⌘1…9 按侧栏顺序切页,前九项不动
            { key: "intel", icon: "sf-antenna", label: "情报", badge: "intel" } ] },
        { key: "app", title: "应用", bottom: true, items: [
            { key: "access", icon: "sf-plug", label: "接入", badge: "" },
            { key: "settings", icon: "sf-gear", label: "设置", badge: "" },
            { key: "about", icon: "sf-info", label: "关于", badge: "" } ] }
    ]
    readonly property var items: groups.reduce(function (all, g) { return all.concat(g.items) }, [])  // QML 的 JS 没有 flatMap

    /// 旧页面里的跳转目标(子页 / 页内一节)→ 侧栏项
    readonly property var parentOf: ({
        pa: "market", book: "market", rs: "screener", inflection: "screener", deviation: "screener",
        tws: "access", futu: "access", accounts: "access", llm: "access", follow: "access",
        alerts: "sectors", quality: "sectors"
    })
    function keyFor(tab) { return parentOf[tab] || tab }
    function valid(key) { return items.some(function (i) { return i.key === key }) }

    property string current: "trade"
    property var subs: ({})

    /// 切页。传子页名(pa / rs / tws…)会切到它的父页并记住子页
    function navigate(key) {
        var parent = keyFor(key)
        if (parent !== key) { var s = Object.assign({}, subs); s[parent] = key; subs = s }
        if (valid(parent)) current = parent
    }

    /// 折叠着的组(同 React 版记在本地的 dafri-sidegroup-*)
    property var collapsed: ({})
    function setGroupOpen(key, open) {
        var c = Object.assign({}, collapsed); c[key] = !open; collapsed = c
        store.collapsedJson = JSON.stringify(collapsed)
    }
    function groupOf(key) { return groups.filter(function (g) { return g.items.some(function (i) { return i.key === key }) })[0] }

    property var store: Settings { category: "shell"; property string tab: "trade"; property string collapsedJson: "{}" }
    Component.onCompleted: {
        try { collapsed = JSON.parse(store.collapsedJson) || {} } catch (e) { collapsed = {} }
        if (valid(store.tab)) current = store.tab
    }
    // 目标在折叠着的组里(快捷键 / 跳转过来):把组展开,不然选中项看不见。只在切页时做,
    // 否则用户收起自己正在看的那一组会被立刻顶开
    onCurrentChanged: {
        store.tab = current
        var g = groupOf(current)
        if (g && collapsed[g.key]) setGroupOpen(g.key, true)
    }
}
