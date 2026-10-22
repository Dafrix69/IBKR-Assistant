import QtQuick
import Dafri.Kit

// 持仓追踪(pages/Tracker.tsx):账户持仓(组合优先)→ 盯盘心跳 → 正在追踪的卡片。
// 模型与按钮都在 C++(shell/tracker_controller);看得见时它按券商的节拍刷持仓
ScrollPage {
    id: page
    property var controller: null
    readonly property var m: controller ? controller.model : ({})
    Component.onCompleted: if (controller) controller.setVisible(true)
    Component.onDestruction: if (controller) controller.setVisible(false)
    Connections {
        target: page.controller
        ignoreUnknownSignals: true
        // 建完追踪后把视线带过去:滚到「正在追踪」
        function onCreated() { page.reveal(trackersHead) }
        // 价位弹窗的「查看」跳过来:同样滚到「正在追踪」(闪哪一张由 controller 定)
        function onReveal() { page.reveal(trackersHead) }
    }

    PageHead {
        width: parent.width
        title: "持仓追踪"
        Button { small: true; text: "刷新持仓"; onClicked: if (page.controller) page.controller.reload() }
    }
    Alert {
        width: parent.width
        tone: "warn"
        title: "这一页会真的发单。"
        text: "打开「到价自动平仓」后,价格触及止盈 / 止损时软件会自动发出平仓单;仍受三道闸门约束:自动执行已打开、实盘账户需在「设置」里允许实盘下单、熔断期间不发。<b>软件必须开着。</b>盯盘在本机进行,关掉就不再盯,不同于挂在券商服务器上的条件单。"
        rich: true
    }
    // CSS 的外边距会合并:提示条下面的 14 并进分节标题上面的 24,标题下面的 9 并进参考资料上面的 4——这里只算大的那个
    SectionTitle { text: "账户持仓" }
    Primer {
        id_: "intro-tracker"
        topPadding: 0
        width: parent.width
        summary: "哪些持仓会出现在这里"
        Hint {
            text: "这里只列<b>券商账户里的实际持仓</b>(IBKR 走 portfolio / positions,富途走持仓查询),且只含配置里有别名的账户。已校验未发送、排队中、已提交未成交的订单都不是持仓,不会出现在这里,也不能追踪。"
            topPadding: 0
        }
    }
    Column {
        width: parent.width
        spacing: 8
        EmptyState { visible: !!(page.m.positions && page.m.positions.empty); width: parent.width; text: page.m.positions ? (page.m.positions.empty || "") : "" }
        // 按 key 原地更新的模型(不是现拼的数组):持仓每秒刷新时卡片不重建,展开着的表单不回初值
        Repeater {
            model: page.controller ? page.controller.positions : null
            PositionCard { required property var modelData; m: modelData; controller: page.controller }
        }
    }
    SectionTitle { id: trackersHead; text: "正在追踪" }
    Alert {
        visible: !!page.m.tracksError
        width: parent.width
        tone: "error"
        title: "追踪列表没读到,下面是上一次读到的"
        text: page.m.tracksError || ""
    }
    // .hint 的上 7 与分节标题的下 9 合并成 9(已在标题里);下面的 .cards 紧跟着,没有间距
    Hint {
        visible: !!page.m.pulse
        topPadding: 0
        text: page.m.pulse ? page.m.pulse.text : ""
        warn: !!(page.m.pulse && page.m.pulse.bad)
        textFormat: Text.PlainText
    }
    Column {
        width: parent.width
        spacing: 8
        EmptyState { visible: !!(page.m.tracks && page.m.tracks.empty); width: parent.width; text: page.m.tracks ? (page.m.tracks.empty || "") : "" }
        Repeater {
            model: page.controller ? page.controller.tracks : null
            TrackCard {
                required property var modelData
                c: modelData
                controller: page.controller
                busy: page.controller && page.controller.busy[modelData.id] ? page.controller.busy[modelData.id] : ""
                flash: page.controller ? page.controller.flashId === modelData.id : false
            }
        }
    }
}
