import QtQuick
import QtQuick.Effects

// 页面大标题(.page-head):上 14、标题 28px 字重 750 字距 -0.025em 行高 1.15、下 10,下面再空 14;
// 内容区顶上的 6 被它的 margin -6 抵掉。右边的按钮竖直居中。
// 吸顶(position: sticky; top: -6px,相对滚动容器的内边距边):盒子上沿停在视口的 0。停着的那一条后面铺一块玻璃(::before):铺满内容区的宽,
// 下面多出 10、最后 12px 渐隐;停在最上面时完全透明,滚出 40px 之内渐显。玻璃 = 背后内容现画的模糊(blur 30 / saturate 190%)+ 透明的那一档玻璃色。
// 这一项本身留在页面的列里占位,看得见的那一条挪到 ScrollPage 的 stickyLayer 上(不在滚动的内容里,模糊才拍不到它自己)
Item {
    id: root
    property string title: ""
    default property alias extra: extraBox.data
    implicitHeight: 14 + head.implicitHeight + 10 + 14 - 6
    // 找到外面的 ScrollPage(没有就照常摆在原地,不吸顶)
    property Item scroller: null
    readonly property real scrolled: scroller ? scroller.contentY : 0
    // 这一项在视口里的 y:跟着内容走,但不高过 6。sticky 的 top 是从滚动容器的内边距边算的(Chromium 让着 padding):
    // 内容区上 6 的内边距 + top: -6 = 盒子上沿停在视口的 0,标题停在 14(量的 React 版,滚动之后同不滚时一样高)
    readonly property real stuckY: scroller ? Math.max(6 + y - scrolled, 6) : 0
    Component.onCompleted: {
        for (var p = parent; p; p = p.parent) {
            if (p.stickyLayer !== undefined) { scroller = p; break }
        }
        if (scroller) bar.parent = scroller.stickyLayer
    }

    Item {
        id: bar
        x: root.scroller ? 28 : 0
        y: root.stuckY
        width: root.width
        height: root.implicitHeight
        // 盒子(含 padding)从 -6 起,高 14 + 标题 + 10;玻璃再往下多 10
        readonly property real boxH: 14 + head.implicitHeight + 10
        // Windows 下捕获滚动内容会触发 Qt ShaderEffectSource 生命周期断言,只保留着色层。
        // 其他平台叠加背后内容的模糊;软件渲染仍只画着色层。
        // 最后 12px 渐隐:模糊那一层用遮罩,着色那一层直接是渐变——不再套一层 layer,哪一层画不出来都不连累另一层
        Item {
            id: glass
            visible: !!root.scroller && opacity > 0
            x: -bar.x
            y: -6
            width: root.scroller ? root.scroller.width : 0
            height: bar.boxH + 10
            opacity: Math.max(0, Math.min(1, root.scrolled / 40))
            readonly property real solid: Math.max(0, 1 - 12 / Math.max(1, height))
            Loader {
                anchors.fill: parent
                active: Qt.platform.os !== "windows"
                sourceComponent: Item {
                    ShaderEffectSource {
                        id: behind
                        anchors.fill: parent
                        visible: false
                        live: glass.visible
                        sourceItem: glass.visible && root.scroller ? root.scroller.contentItem : null
                        sourceRect: Qt.rect(0, root.scrolled + bar.y - 6, glass.width, glass.height)
                    }
                    MultiEffect {
                        anchors.fill: parent
                        source: behind
                        blurEnabled: true
                        blurMax: 32
                        blur: 1.0
                        saturation: 0.9
                        maskEnabled: true
                        maskSource: fade
                    }
                    Item {
                        id: fade
                        visible: false
                        anchors.fill: parent
                        layer.enabled: glass.visible
                        Rectangle {
                            anchors.fill: parent
                            gradient: Gradient {
                                GradientStop { position: 0; color: "black" }
                                GradientStop { position: glass.solid; color: "black" }
                                GradientStop { position: 1; color: "transparent" }
                            }
                        }
                    }
                }
            }
            Rectangle {
                anchors.fill: parent
                gradient: Gradient {
                    GradientStop { position: 0; color: Theme.glassBgClear }
                    GradientStop { position: glass.solid; color: Theme.glassBgClear }
                    GradientStop { position: 1; color: Theme.tint(Theme.glassBgClear, 0) }
                }
            }
        }
        Label {
            id: head
            y: 14 - 6
            text: root.title
            size: 28; weight: Theme.weightHeavy; family: Theme.fontDisplay; letterSpacing: -0.7; css: 1.15
        }
        Item {
            id: extraBox
            anchors.right: parent.right
            anchors.verticalCenter: head.verticalCenter
            width: childrenRect.width; height: childrenRect.height
        }
    }
}
