import QtQuick

// 分节标题(.section-title):17px 字重 700、行高继承 1.47(一行 25),上 24 左右 4 下 9。
// count ≥ 0 时后面跟一枚条数徽标(.count-badge:灰胶囊 16 高、最窄 16、左右 5、10.5px 500 二级色;0 也显示,过 999 写 999+),间距 6
Item {
    id: root
    property alias text: label.text
    property int count: -1
    /// 上边距:默认 24;紧跟在页头(下 14)后面时两段外边距合并,只剩 24 - 14 = 10
    property real topGap: 24
    implicitHeight: topGap + label.implicitHeight + 9
    // 宽不能是 0:Column 这类定位器不摆宽或高为 0 的子项
    implicitWidth: label.implicitWidth + 8 + (badge.visible ? 6 + badge.width : 0)
    Label {
        id: label
        x: 4; y: root.topGap
        size: 17; weight: 700; family: Theme.fontDisplay; letterSpacing: -0.25
    }
    Rectangle {
        id: badge
        visible: root.count >= 0
        x: label.x + label.implicitWidth + 6
        anchors.verticalCenter: label.verticalCenter
        width: Math.max(16, badgeL.implicitWidth + 10); height: 16; radius: 8
        color: Theme.bgFillStrong
        Label { css: 0;
            id: badgeL
            anchors.centerIn: parent
            text: root.count > 999 ? "999+" : String(root.count)
            color: Theme.labelSecondary
            size: 10.5; weight: 500; family: Theme.fontFamily
        }
    }
}
