import QtQuick

// 状态圆点(AntD 的 Badge status):ok 绿、bad 红、warn 橙、info 蓝、idle 灰(工具栏里的灰用三级文字色,shell.css 那一条)
Rectangle {
    property string state: "idle"
    property color idleColor: Theme.gray
    width: 8; height: 8; radius: 4
    color: state === "ok" ? Theme.green : state === "bad" ? Theme.red : state === "warn" ? Theme.orange : state === "info" ? Theme.blue : idleColor
}
