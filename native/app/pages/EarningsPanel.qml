import QtQuick
import Dafri.Kit

Column {
    id: root
    property var report: ({})
    property bool expanded: false
    signal refresh()
    spacing: 5
    function percent(v) { return typeof v === "number" && isFinite(v) ? (v > 0 ? "+" : "") + v.toFixed(2) + "%" : "—" }
    function timing(v) { return v === "BEFORE MARKET" ? "盘前" : v === "AFTER MARKET" ? "盘后" : v === "DURING MARKET" ? "盘中" : "时段未知" }
    Row {
        width: root.width; spacing: 8
        Button { id: toggle; objectName: "earningsToggle"; small: true; kind: "text"; text: root.expanded ? "收起财报" : "财报 / 历史反应"; onClicked: root.expanded = !root.expanded }
        Label {
            width: Math.max(0,parent.width-toggle.width-8); wrap: true
            anchors.verticalCenter: parent.verticalCenter; size: 11
            color: root.report.upcoming ? Theme.orangeText : Theme.labelSecondary
            text: root.report.upcoming ? "财报提醒 · " + (root.report.upcoming.days_until === 0 ? "今天 · " : "还有 " + root.report.upcoming.days_until + " 天 · ") + root.report.upcoming.date + " " + root.timing(root.report.upcoming.timing) + " · " + (root.report.upcoming.status === "CONFIRMED" ? "已确认" : "未确认 / 预估")
                : root.report.message || "下次财报日期缺失 · IBKR WSH"
        }
    }
    Column {
        visible: root.expanded; width: parent.width; spacing: 5
        Row {
            spacing: 8
            Label { text: "IBKR WSH · 美东日期"; size: 11; color: Theme.labelSecondary }
            Button { objectName: "earningsRefresh"; small: true; kind: "text"; text: "刷新财报"; enabled: root.report.status !== "loading"; onClicked: root.refresh() }
        }
        Label { visible: !!root.report.at; width: parent.width; wrap: true; size: 10; color: Theme.labelSecondary; text: root.report.at ? "读取于（本机时间）" + new Date(root.report.at).toLocaleString() : "" }
        Label { width: parent.width; wrap: true; size: 11; color: Theme.labelSecondary; text: root.report.basis || "缺少财报日期时，无法计算财报后股价变化。" }
        Label { visible: !!root.report.price_error; width: parent.width; wrap: true; text: "历史行情缺失：" + (root.report.price_error || ""); size: 11; color: Theme.orangeText }
        Row {
            width: parent.width
            Label { width: parent.width*0.4; text: "财报日期 / 时段"; size: 11; color: Theme.labelSecondary }
            Label { width: parent.width*0.2; text: "开盘跳空"; size: 11; color: Theme.labelSecondary }
            Label { width: parent.width*0.2; text: "首日收盘"; size: 11; color: Theme.labelSecondary }
            Label { width: parent.width*0.2; text: "第5日收盘"; size: 11; color: Theme.labelSecondary }
        }
        Repeater {
            model: root.report.history || []
            delegate: Column {
                required property var modelData
                width: root.width; spacing: 2
                Row {
                    width: parent.width
                    Label { width: parent.width*0.4; wrap: true; text: modelData.date + " · " + root.timing(modelData.timing); size: 11 }
                    Label { width: parent.width*0.2; text: root.percent(modelData.gap); size: 11; tnum: true }
                    Label { width: parent.width*0.2; text: root.percent(modelData.day1); size: 11; tnum: true }
                    Label { width: parent.width*0.2; text: root.percent(modelData.day5); size: 11; tnum: true }
                }
                Label { visible: !!modelData.missing; width: parent.width; wrap: true; text: modelData.missing || ""; size: 10; color: Theme.labelSecondary }
            }
        }
        Label { visible: !(root.report.history || []).length; text: "历史财报记录缺失，暂无可计算样本"; size: 11; color: Theme.labelSecondary }
    }
}
