import QtQuick

// 多行输入框(AntD Input.TextArea + theme/antd.ts):同 Input 的面、发丝边、12 圆角、焦点环;内边距上下 (32 − 2 − 行高) / 2 = 5.4、左右 11,13px 字、行高 1.47;
// 高固定 rows 行(原版 rows={6},没开 autoSize),字多了在框里滚。受控:text 由外面给,打字只发 edited;⌘↩ / ⌘⇧↩ 发 submit(shift)
Item {
    id: root
    property string text: ""
    property string placeholder: ""
    property int rows: 6
    readonly property bool focused: field.activeFocus
    readonly property alias cursorPosition: field.cursorPosition
    readonly property alias selectionStart: field.selectionStart
    readonly property alias selectionEnd: field.selectionEnd
    signal edited(string text)
    signal submit(bool shift)
    readonly property real lineBox: Theme.fontBody * 1.47
    /// AntD 的输入框内边距:一行字在控件高(32)里竖直居中
    readonly property real padY: (Theme.controlHeight - 2 - lineBox) / 2
    implicitHeight: rows * lineBox + 2 * padY + 2
    implicitWidth: 160
    function focusAndPlace(caret) { field.forceActiveFocus(); field.cursorPosition = caret }
    // 外面改了字(「应对」、情报、「写进指令」…):光标放到末尾,同浏览器给受控 textarea 设 value 之后(TextEdit 设完 text 光标在 0,接着敲就插到句首)
    onTextChanged: if (field.text !== text) { field.text = text; field.cursorPosition = field.length }
    Rectangle {
        anchors.fill: parent
        anchors.margins: -3.5
        radius: face.radius + 3.5
        color: "transparent"
        border.width: 3.5
        border.color: Theme.tint(Theme.blue, 0.3)
        visible: field.activeFocus
    }
    Rectangle {
        id: face
        anchors.fill: parent
        radius: Theme.radiusControl
        color: root.enabled ? Theme.bgControl : Theme.bgFill
        border.width: 1
        border.color: field.activeFocus ? Theme.blue : Theme.separator
    }
    Text {
        x: 12; y: 1 + root.padY
        width: parent.width - 24
        visible: field.text === ""
        wrapMode: Text.Wrap
        text: root.placeholder
        color: Theme.labelTertiary
        font: field.font
        lineHeight: root.lineBox; lineHeightMode: Text.FixedHeight
    }
    Flickable {
        id: scroller
        x: 12; y: 1 + root.padY
        width: parent.width - 24
        height: parent.height - 2 - 2 * root.padY
        clip: true
        contentWidth: width
        contentHeight: field.contentHeight
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height
        // 光标走到看不见的地方(打字、外面写进一大段)就滚过去
        function ensureVisible(r) {
            if (contentY > r.y) contentY = r.y
            else if (contentY + height < r.y + r.height) contentY = r.y + r.height - height
        }
    TextEdit {
        id: field
        width: scroller.width
        height: Math.max(scroller.height, contentHeight)
        onCursorRectangleChanged: scroller.ensureVisible(cursorRectangle)
        wrapMode: TextEdit.Wrap
        selectByMouse: true
        color: Theme.label
        selectionColor: Theme.tint(Theme.blue, 0.3)
        selectedTextColor: Theme.label
        font.pixelSize: Theme.fontBody
        font.family: Theme.fontFamily
        textFormat: TextEdit.PlainText
        Keys.onPressed: function (e) {
            if ((e.key === Qt.Key_Return || e.key === Qt.Key_Enter) && (e.modifiers & (Qt.ControlModifier | Qt.MetaModifier))) {
                e.accepted = true
                root.submit(!!(e.modifiers & Qt.ShiftModifier))
            }
        }
        onTextChanged: if (text !== root.text) root.edited(text)
    }
    }
}
