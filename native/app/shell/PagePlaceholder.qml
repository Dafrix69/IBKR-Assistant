import QtQuick
import Dafri.Kit

// 还没搬过来的页面:页面的大标题照常有(styles.css 的 .page-head:上 14 下 10、28px、字重 750、字距 -0.025em),
// 下面一句说清楚这一页还在 Electron 版里,不是空白
Item {
    property string label: ""
    Column {
        x: 28
        y: 6
        width: parent.width - 56
        Item {
            width: parent.width
            height: 14 + head.implicitHeight + 10 + 14
            Text {
                id: head
                y: 14
                text: label
                font.pixelSize: Theme.fontLargeTitle; font.weight: Theme.weightHeavy; font.letterSpacing: -0.7
                font.family: Theme.fontFamily; color: Theme.label
            }
        }
        Text {
            text: "这一页还在 Electron 版里,Qt 版没搬过来"
            font.pixelSize: Theme.fontBody; font.family: Theme.fontFamily; color: Theme.labelSecondary
        }
    }
}
