import QtQuick

// 图标:React 版 ui/Icons.tsx 的同一份线稿(kit/icons/,tools/gen_icons.mjs 生成)。color 不给就是原色(应用标)。
Image {
    id: root
    property string name: ""
    property color color: Theme.blue
    property bool tinted: true
    property int size: 16
    width: size
    height: size
    source: name === "" ? "" : "image://icon/" + name + (tinted ? "/" + root.color : "")
    sourceSize.width: size * Screen.devicePixelRatio
    sourceSize.height: size * Screen.devicePixelRatio
    smooth: true
    asynchronous: false
    cache: true
}
