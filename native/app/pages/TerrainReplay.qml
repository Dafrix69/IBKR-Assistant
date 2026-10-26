import QtQuick
import Dafri.Kit

Column {
    id: root
    property var controller: null
    readonly property var m: controller ? controller.model : ({})
    property string inspection: "移动鼠标查看行权价与净 GEX"
    spacing: 16
    Flow {
        width: parent.width; spacing: 10
        Label { text: "交易日（美东）"; css: 30 }
        Select { width: 170; options: root.m.dates || []; value: root.m.date || ""; enabled: !root.m.busy; onActivated: function(v) { if(root.controller) root.controller.selectDate(v) } }
        Button { text: root.m.busy ? "读取中…" : "刷新记录"; enabled: !root.m.busy; onClicked: if(root.controller) root.controller.refresh() }
        Label { text: "SPX · OI-GEX"; color: Theme.labelSecondary; css: 30 }
    }
    Label { width: parent.width; wrap: true; text: root.m.status || "请连接本地引擎读取记录，无需连接 TWS。"; color: Theme.labelSecondary }
    Rectangle {
        width: parent.width; height: 320; radius: 12
        color: Theme.bgFill
        Canvas {
            id: plot
            objectName: "terrainPlot"
            anchors.fill: parent
            property var snapshot: root.m
            property color ink: Theme.labelSecondary
            property color blue: Theme.blue
            property color positive: Theme.green
            property color negative: Theme.red
            onSnapshotChanged: { root.inspection = "移动鼠标查看行权价与净 GEX"; requestPaint() }
            onInkChanged: requestPaint()
            onWidthChanged: requestPaint()
            onHeightChanged: requestPaint()
            onPaint: {
                var c=getContext("2d"); c.clearRect(0,0,width,height)
                var l=68,r=width-22,top=30,bottom=height-45,mid=(top+bottom)/2
                var low=Number(root.m.low || 0),high=Number(root.m.high || 1),scale=Number(root.m.scale || 1)
                function x(k) { return l+(k-low)/Math.max(1,high-low)*(r-l) }
                function y(g) { return mid-g/scale*(bottom-top)/2 }
                c.font="11px '"+Theme.fontFamily+"'"; c.fillStyle=ink; c.strokeStyle=ink; c.lineWidth=0.5
                c.beginPath();c.moveTo(l,mid);c.lineTo(r,mid);c.stroke()
                c.textAlign="right";c.fillText((scale/1e9).toPrecision(3)+" B",l-8,top+5);c.fillText("0",l-8,mid+4);c.fillText((-scale/1e9).toPrecision(3)+" B",l-8,bottom)
                c.textAlign="center"
                for(var i=0;i<=4;i++){var k=low+(high-low)*i/4;c.fillText(k.toFixed(0),x(k),bottom+23)}
                c.fillText("行权价",(l+r)/2,height-5)
                var rows=root.m.rows || [],valid=[]
                for(var j=0;j<rows.length;j++) {
                    var a=rows[j];if(typeof a.strike!=="number" || typeof a.net_gex!=="number")continue
                    var px=x(a.strike),py=y(a.net_gex)
                    c.globalAlpha=0.25;c.fillStyle=a.net_gex>=0?positive:negative
                    c.fillRect(px-3,Math.min(py,mid),6,Math.max(1,Math.abs(py-mid)));c.globalAlpha=1
                    valid.push({x:px,y:py})
                }
                // 各档是离散采样:画点,不跨未采集的行权价连线。
                c.fillStyle=blue
                for(var v=0;v<valid.length;v++){c.beginPath();c.arc(valid[v].x,valid[v].y,2.8,0,2*Math.PI);c.fill()}
                var spot=root.m.spot
                if(rows.length && typeof spot==="number" && spot>=low && spot<=high){
                    c.strokeStyle=blue;c.lineWidth=1.5;c.beginPath();c.moveTo(x(spot),top);c.lineTo(x(spot),bottom);c.stroke()
                    c.fillStyle=blue;c.textAlign="center";c.fillText("现价 "+spot.toFixed(2),Math.max(l+48,Math.min(r-48,x(spot))),18)
                }
                if(!valid.length){c.fillStyle=ink;c.textAlign="center";c.fillText("此时没有可绘制的地形",(l+r)/2,mid-24)}
            }
            MouseArea {
                anchors.fill: parent; hoverEnabled: true
                acceptedButtons: Qt.NoButton
                onPositionChanged: function(e) {
                    var rows=root.m.rows || [], target=(root.m.low || 0)+(e.x-68)/Math.max(1,width-90)*((root.m.high || 1)-(root.m.low || 0))
                    var best=null
                    for(var i=0;i<rows.length;i++)if(typeof rows[i].strike==="number" && (best===null || Math.abs(rows[i].strike-target)<Math.abs(best.strike-target)))best=rows[i]
                    if(best)root.inspection="行权价 " + best.strike + " · 净 GEX " + (typeof best.net_gex==="number" ? best.net_gex.toLocaleString(Qt.locale("en_US"),"f",0)+" 美元 / 1%" : "缺失")
                }
            }
        }
    }
    Label { text: root.inspection; size: 11; color: Theme.labelSecondary }
    Row {
        spacing: 12
        Label { text: "● 每档净 GEX"; color: Theme.blue; size: 11 }
        Label { text: "正值"; color: Theme.green; size: 11 }
        Label { text: "负值"; color: Theme.red; size: 11 }
        Label { text: "纵轴：美元 / 标的变动 1%（B = 十亿）"; color: Theme.labelSecondary; size: 11 }
    }
    Row {
        width: parent.width; spacing: 12
        Button { text: "上一帧"; small: true; enabled: !root.m.busy && root.m.count > 0; onClicked: root.controller.step(-1) }
        Slider {
            objectName: "terrainTimeline"
            width: Math.max(120,parent.width-170); anchors.verticalCenter: parent.verticalCenter
            from: root.m.begin || 0; to: root.m.end || 0; value: root.m.cursor || 0; stepSize: 1000
            enabled: !root.m.busy && root.m.count > 1
            onMoved: function(v) { root.controller.seek(v) }
        }
        Button { text: "下一帧"; small: true; enabled: !root.m.busy && root.m.count > 0; onClicked: root.controller.step(1) }
    }
    Flow {
        width: parent.width; spacing: 18
        Label { text: "回放 " + (root.m.time || "—") + " ET"; weight: Theme.weightSemibold }
        Label { text: "采集 " + (root.m.frameTime || "—") + " · 第 " + (root.m.index || 0) + " / " + (root.m.count || 0) + " 帧" }
        Label { text: "帧龄 " + Math.round(root.m.ageSeconds || 0) + " 秒"; color: Theme.labelSecondary }
    }
    Label { width: parent.width; wrap: true; text: "时间范围 " + (root.m.startTime || "—") + "–" + (root.m.endTime || "—") + " ET。拖动时显示该时刻之前最后收到的一帧，空档不插值。"; size: 11; color: Theme.labelSecondary }
    Label { width: parent.width; wrap: true; text: "仅展示已采集行权价，零值可能包含上游缺失数据。GEX 使用 Call 正、Put 负的持仓假设，不是 EHG，也不是交易信号。"; size: 11; color: Theme.labelSecondary }
}
