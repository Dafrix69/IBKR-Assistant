import QtQuick

// 自动列宽的小号表(AntD Table size="small",不带 scroll:浏览器的 table-layout: auto),回测的参数扫描、交易分析那几张 .review-table 用。
//   · 列宽:每列先拿最宽的那一格(含表头)+ 左右 8;给了 width 的列就是那么宽;页面比它们加起来宽,多出来的按各列的宽按比例分给没给 width 的列;
//   · 表头 11px 500 二级色(.review-table th),格子 11.5px、5 × 8,行与行之间 1px 发丝线,表头下面也是;悬停整行填充底;
//   · columns:[{ key, title, align: "right"?, width? }];rows:[{ key, cells: { 列 key: 字 | { text, tone: pos/neg, suffix, tip, tag } } }]
//     tone 是 .perf-num 的涨跌色;suffix 是接在后面的一段三级色小字(.muted),tip 是悬停提示;tag 是一枚 AntD 的无边 Tag(10.5px、左右 5、整圆、填充底、二级色);
//   · empty:一行都没有时表体里那一格(AntD 的 placeholder:控件面的底,中间一个小号空态);
//   · fixed:有一列 ellipsis 时 AntD 换成 table-layout: fixed——给了 width 的列就是那么宽,剩下的宽由没给的列平分(不看字多宽);
//     ellipsis 的列字一行、放不下省略;
//   · scrollX:scroll={{ x: 'max-content' }}——表至少和页面一样宽(多出来的照样按比例分),字放不下时表比页面宽、横着拖。
Item {
    id: root
    property var columns: []
    property var rows: []
    property real fontSize: 11.5
    property real headSize: 11
    property int headWeight: Theme.weightMedium
    property string empty: ""
    property bool fixed: false
    property bool scrollX: false
    readonly property real lineH: Math.ceil(fontSize * 1.47 * 100) / 100
    readonly property real headH: 5 + headSize * 1.47 + 5 + 1

    function cellText(v) { return v === undefined || v === null ? "" : typeof v === "object" ? (v.text || "") : String(v) }
    function cellOf(row, col) { return row && row.cells ? row.cells[col.key] : undefined }

    // ---- 量宽:每列一份不显示的副本(表头 + 每一格的字与小字)
    property int measureVersion: 0
    Repeater {
        id: measure
        model: root.columns
        Column {
            required property var modelData
            visible: false
            onImplicitWidthChanged: root.measureVersion++
            Label { text: modelData.title; size: root.headSize; weight: root.headWeight }
            Repeater {
                model: root.rows
                Row {
                    required property var modelData
                    readonly property var v: root.cellOf(modelData, parent.modelData)
                    readonly property bool tag: !!(v && v.tag)
                    Label { text: root.cellText(parent.v); size: parent.tag ? 10.5 : root.fontSize; tnum: !parent.tag }
                    Item { visible: parent.tag; width: 12; height: 1 }
                    Label { visible: !!(parent.v && parent.v.suffix); text: parent.v && parent.v.suffix ? parent.v.suffix : ""; size: 11 }
                }
            }
        }
    }
    readonly property var widths: {
        var v = measureVersion, n = columns.length, base = [], sum = 0, flexSum = 0
        for (var i = 0; i < n; ++i) {
            var m = measure.itemAt(i)
            var w = columns[i].width ? columns[i].width : (m ? m.implicitWidth : 0) + 16
            base.push(w)
            sum += w
            if (!columns[i].width) flexSum += w
        }
        var out = []
        if (fixed) {
            var fixedSum = 0, autos = 0
            for (var f = 0; f < n; ++f) { if (columns[f].width) fixedSum += columns[f].width; else autos++ }
            var share = autos > 0 ? Math.max(0, width - fixedSum) / autos : 0
            for (var g = 0; g < n; ++g) out.push(columns[g].width ? columns[g].width : share)
            return out
        }
        var extra = Math.max(0, width - sum)
        for (var k = 0; k < n; ++k) out.push(base[k] + (!columns[k].width && flexSum > 0 ? extra * base[k] / flexSum : 0))
        return out
    }
    readonly property real tableWidth: scrollX ? Math.max(width, offsets[offsets.length - 1]) : width
    readonly property var offsets: { var o = [0]; for (var i = 0; i < widths.length; ++i) o.push(o[i] + widths[i]); return o }
    implicitHeight: col.implicitHeight

    Flickable {
        width: root.width
        height: col.implicitHeight
        contentWidth: col.width
        contentHeight: col.implicitHeight
        interactive: contentWidth > width + 0.5
        flickableDirection: Flickable.HorizontalFlick
        boundsBehavior: Flickable.StopAtBounds
        clip: interactive
    Column {
        id: col
        width: root.tableWidth
        Item {
            width: parent.width
            height: root.headH
            Repeater {
                model: root.columns
                Label {
                    required property var modelData
                    required property int index
                    x: root.offsets[index] + 8; y: 5
                    width: (root.widths[index] || 0) - 16
                    horizontalAlignment: modelData.align === "right" ? Text.AlignRight : Text.AlignLeft
                    text: modelData.title; size: root.headSize; weight: root.headWeight; color: Theme.labelSecondary
                }
            }
            Rectangle { y: parent.height - 1; width: parent.width; height: 1; color: Theme.separator }
        }
        Repeater {
            model: root.rows
            Item {
                id: tr
                required property var modelData
                width: col.width
                height: 5 + root.lineH + 5 + 1
                Rectangle { anchors.fill: parent; color: trHover.hovered ? Theme.bgFill : "transparent" }
                HoverHandler { id: trHover }
                Repeater {
                    model: root.columns
                    Item {
                        required property var modelData
                        required property int index
                        readonly property var v: root.cellOf(tr.modelData, modelData)
                        x: root.offsets[index] + 8; y: 5
                        width: (root.widths[index] || 0) - 16; height: root.lineH
                        // Tag:18 高(1 的透明边 + 16)、左右 5、整圆、填充底、10.5px 二级色;竖直上跟一行字居中
                        Rectangle {
                            visible: !!(parent.v && parent.v.tag)
                            x: parent.modelData.align === "right" ? parent.width - width : 0
                            y: (root.lineH - 18) / 2
                            width: tagText.implicitWidth + 12; height: 18
                            radius: 9
                            color: Theme.bgFill
                            Label { id: tagText; x: 6; anchors.verticalCenter: parent.verticalCenter; text: root.cellText(parent.parent.v); size: 10.5; color: Theme.labelSecondary }
                        }
                        Row {
                            visible: !(parent.v && parent.v.tag)
                            x: parent.modelData.align === "right" ? parent.width - implicitWidth : 0
                            Label {
                                id: cellText
                                width: parent.parent.modelData.ellipsis ? parent.parent.width : undefined
                                elide: parent.parent.modelData.ellipsis ? Text.ElideRight : Text.ElideNone
                                // AntD 的 ellipsis 默认 showTitle:省略了,悬停看全文
                                Loader { anchors.fill: parent; active: cellText.truncated; sourceComponent: Tip { text: cellText.text } }
                                text: root.cellText(parent.parent.v); size: root.fontSize; tnum: true
                                color: parent.parent.v && parent.parent.v.tone === "pos" ? Theme.upText : parent.parent.v && parent.parent.v.tone === "neg" ? Theme.downText : Theme.label
                            }
                            Label {
                                visible: !!(parent.parent.v && parent.parent.v.suffix)
                                anchors.baseline: parent.children[0].baseline
                                text: parent.parent.v && parent.parent.v.suffix ? parent.parent.v.suffix : ""
                                size: 11; color: Theme.labelSecondary
                            }
                        }
                        // 有提示的格子才挂 Tip(每个 Tip 带一块玻璃与投影,一张表七十多格都挂上太重)
                        Loader {
                            anchors.fill: parent
                            active: !!(parent.v && parent.v.tip)
                            sourceComponent: Tip { text: parent && parent.parent && parent.parent.v ? parent.parent.v.tip || "" : "" }
                        }
                    }
                }
                Rectangle { y: parent.height - 1; width: parent.width; height: 1; color: Theme.separator }
            }
        }
        // 一行都没有:控件面的一格,里面一个小号空态(上下 5)
        Rectangle {
            visible: root.rows.length === 0 && root.empty !== ""
            width: parent.width
            height: visible ? 5 + emptyState.implicitHeight + 5 + 1 : 0
            color: Theme.bgControl
            EmptyState { id: emptyState; y: 5; width: parent.width; compact: true; text: root.empty }
            Rectangle { y: parent.height - 1; width: parent.width; height: 1; color: Theme.separator }
        }
    }
    }
}
