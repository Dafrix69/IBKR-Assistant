import QtQuick
import Dafri.Kit

Column {
    id: root
    property var controller: null
    readonly property var m: controller ? controller.entry : ({})
    readonly property var e: m.evidence || ({})
    spacing: 12
    Timer { interval: 1000; repeat: true; running: root.visible; onTriggered: if(root.controller)root.controller.refreshEntry() }
    Timer { interval: 30000; repeat: true; running: root.visible; onTriggered: if(root.controller)root.controller.refreshEntryData() }
    onVisibleChanged: if(visible && controller)controller.refreshEntryData()
    Component.onCompleted: if(controller)controller.refreshEntryData()
    Label { width: parent.width; wrap: true; text: "先在蝴蝶测算中选腿、限价与目标时间，再复核这笔交易的依据。系统自动核对 IBKR 盘口和分钟线；缺失数据会标明。EHG 与参与者行为仍需外部证据，复核只生成草稿。"; color: Theme.labelSecondary }
    StatusCard {
        width: parent.width; title: root.m.title || "等待测算"; tone: root.m.ready ? "ok" : "warn"
        Label { width: parent.width; wrap: true; text: root.m.summary || "" }
    }
    Flow {
        width: parent.width; spacing: 14
        Column {
            spacing: 4
            Label { text: "交易假设" }
            Select { objectName: "entryMode"; width: 170; value: root.e.mode || ""; options: [{label:"选择假设",value:""},{label:"上行方向蝶",value:"up"},{label:"下行方向蝶",value:"down"},{label:"区间收敛蝶",value:"range"}]; onActivated: function(v){root.controller.patchEntry({mode:v})} }
        }
        Column {
            spacing: 4
            Label { text: "EHG 地形 · 人工观察" }
            Select { width: 250; value: root.e.regime || ""; options: [{label:"未获取 / 无法确认",value:""},{label:"左托底 + 右燃料",value:"bull"},{label:"左活板门 + 右顶盖",value:"bear"},{label:"正 Gamma 区间吸收",value:"range"},{label:"混合 / 翻转边界",value:"mixed"}]; onActivated: function(v){root.controller.patchEntry({regime:v})} }
        }
        Column {
            spacing: 4
            Label { text: "订单流证据用法" }
            Select { width: 215; value: root.e.flow || ""; options: [{label:"选择证据用法",value:""},{label:"未用订单流判方向",value:"none"},{label:"可信单腿方向轨",value:"single"},{label:"多腿仅作结构背景",value:"complex"},{label:"分类 / 覆盖不足",value:"weak"}]; onActivated: function(v){root.controller.patchEntry({flow:v})} }
        }
    }
    Field { width: parent.width; label: "EHG 来源、观察时刻与判断依据（人工记录）"; key: "source"; hint: "例如：平台页面 / 美东时间 / 多帧形态；不要填写账户信息" }
    Flow {
        width: parent.width; spacing: 12
        Field { visible: !!root.m.directional; label: "价格触发位"; key: "trigger"; hint: "放量突破的门位" }
        Field { visible: !!root.m.directional; label: "价格失效位"; key: "invalidation"; hint: "计划反方向边界" }
        Field { visible: !!root.m.directional; label: "方向上的第一障碍"; key: "barrier"; hint: "尚未接受的墙/价位" }
        Field { visible: !!root.m.range; label: "区间下界 / 失效位"; key: "rangeLow"; hint: "下边界" }
        Field { visible: !!root.m.range; label: "区间上界 / 失效位"; key: "rangeHigh"; hint: "上边界" }
        Field { label: "单笔风险预算（美元）"; key: "budget"; hint: "自行确定" }
        Field { label: "每组费用/滑点预留（美元）"; key: "fees"; hint: "往返合计；0 需显式填"; width: 195 }
        Field { label: "最晚退出（今日美东）"; key: "exitTime"; hint: "HH:mm" }
    }
    Flow {
        width: parent.width; spacing: 12
        Repeater {
            model: root.m.metrics || []
            Column {
                required property var modelData
                width: 240; spacing: 3
                Label { width: parent.width; wrap: true; text: modelData.label; size: 11; color: Theme.labelSecondary }
                Label { text: modelData.value; weight: Theme.weightSemibold; tnum: true }
            }
        }
    }
    Label { width: parent.width; wrap: true; size: 11; color: Theme.labelSecondary; text: "风险按计划净限价及费用预留计算，只有完整 1:-2:1 组合才适用。目标收益是条件情景，IV 压力不包含走反或时间延误。价格失效与时间退出只是计划，尚未挂单执行。" }
    Primer {
        width: parent.width; intro: false; id_: "fly-entry-rules"
        summary: "查看自动复核详情与资料依据"
        Column {
            width: parent.width; spacing: 9
            Repeater {
                model: root.m.checks || []
                Column {
                    required property var modelData
                    width: parent.width; spacing: 3
                    Label { width: parent.width; wrap: true; weight: Theme.weightSemibold; text: (modelData.state === "block" ? "冲突 · " : modelData.state === "wait" ? "待核实 · " : modelData.state === "pass" ? "已检查 · " : "提示 · ") + modelData.title; color: modelData.state === "block" ? Theme.red : modelData.state === "wait" ? Theme.orangeText : Theme.label }
                    Label { width: parent.width; wrap: true; text: modelData.detail; size: 11; color: Theme.labelSecondary }
                }
            }
            Label { width: parent.width; wrap: true; size: 11; text: "知识依据：05 EHG 实战训练 §4、§6–11；07 战术图解第12–15页；06 双轨订单流；01 总手册 §17、§22–23。04 将 EHG 描述为启发式估计，不能当成真实持仓披露。"; color: Theme.labelSecondary }
        }
    }
    Label { text: "仍需人工判断 · EHG、价格接受度与退出计划"; weight: Theme.weightSemibold }
    Repeater {
        model: root.m.manual || []
        Row {
            required property var modelData
            width: parent.width; spacing: 10
            Switch { objectName: "entryCheck_"+modelData.key; small: true; checked: modelData.checked; onToggled: function(on){root.controller.checkEntry(modelData.key,on)} }
            Column {
                width: parent.width-46; spacing: 2
                Label { width: parent.width; wrap: true; text: modelData.label }
                Label { width: parent.width; wrap: true; text: modelData.source; size: 10; color: Theme.labelSecondary }
            }
        }
    }
    Flow {
        width: parent.width; spacing: 12
        Button { text: "刷新测算"; enabled: root.controller && root.controller.planner.canRun && !root.controller.planner.running; onClicked: root.controller.refreshEntryPricing() }
        Button { objectName: "entryWrite"; kind: "primary"; text: "复核后写入指令草稿"; enabled: !!root.m.ready; onClicked: root.controller.writeReviewedInstruction() }
        Label { text: "改计划会清除勾选；生成草稿后仍需解析与校验。"; size: 11; color: Theme.labelSecondary; css: 32 }
    }
    component Field: Column {
        property string key: ""
        property string label: ""
        property string hint: ""
        width: 165; spacing: 4
        Label { text: parent.label; size: 11; color: Theme.labelSecondary }
        Input {
            width: parent.width; placeholder: parent.hint
            readonly property string v: root.e[parent.key] || ""
            onVChanged: if(!focused && text!==v)text=v
            Component.onCompleted: text=v
            onEdited: function(t){var p={};p[parent.key]=t;root.controller.patchEntry(p)}
        }
    }
}
