import QtQuick

// 单行输入框(AntD Input + theme/antd.ts):控件面、发丝边、12 圆角(small:24 高、9 圆角、左右 7,条款与表单里用的那种);
// 聚焦时边换强调色,外面一圈 3.5px 的焦点环(强调色 30%)。
Item {
    id: root
    onVisibleChanged: field.syncSecure()
    onPasswordChanged: field.syncSecure()
    property alias text: field.text
    property string placeholder: ""
    property alias readOnly: field.readOnly
    property bool small: false
    /// size="large"(⌘K 查标的):40 高、15px 字、左右 11
    property bool large: false
    /// allowClear:有字时右边一枚清除钮,点了清空(发 edited(""))
    property bool clearable: false
    /// status="warning":边换橙色
    property bool warn: false
    /// Input.Password:字显示成圆点
    property bool password: false
    property bool mono: false
    property alias validator: field.validator
    property alias inputMethodHints: field.inputMethodHints
    /// 最多敲几个字(AntD 的 maxLength:超出的敲不进去、粘贴进来的截掉)
    property alias maximumLength: field.maximumLength
    /// 输入框此刻有没有焦点(受控的数字框据此决定要不要照外面的值重写)
    readonly property alias focused: field.activeFocus
    signal accepted()
    signal edited(string text)
    /// 打完了:回车,或者焦点离开
    signal editingFinished()
    implicitHeight: small ? 24 : large ? 40 : Theme.controlHeight
    implicitWidth: 160
    // 焦点环
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
        radius: root.small ? Theme.radiusSmall : Theme.radiusControl
        // 不可用:AntD 的禁用输入框是填充色底、三级色字
        color: root.enabled ? Theme.bgControl : Theme.bgFill
        border.width: 1
        border.color: root.warn ? Theme.orange : field.activeFocus ? Theme.blue : Theme.separator
    }
    Text {
        anchors.verticalCenter: parent.verticalCenter
        x: field.x
        visible: field.text === ""
        width: field.width
        elide: Text.ElideRight
        text: root.placeholder
        color: Theme.labelTertiary
        font: field.font
    }
    TextInput {
        id: field
        anchors.fill: parent
        anchors.leftMargin: root.small ? 7 : 11; anchors.rightMargin: (root.small ? 7 : 11) + (root.clearable ? 18 : 0)
        verticalAlignment: TextInput.AlignVCenter
        echoMode: root.password ? TextInput.Password : TextInput.Normal
        // 密码框拿着焦点时开安全键盘输入(同浏览器的 password 框;kit/secure_input.h)。藏起来 / 销毁时还拿着焦点的,先关上
        property bool secured: false
        onActiveFocusChanged: syncSecure()
        function syncSecure() {
            var want = root.password && activeFocus && root.visible
            if (want === secured) return
            secured = want
            SecureInput.focus(want)
        }
        Component.onDestruction: if (secured) { secured = false; SecureInput.focus(false) }
        clip: true
        selectByMouse: true
        color: root.enabled ? Theme.label : Theme.labelTertiary
        selectionColor: Theme.tint(Theme.blue, 0.3)
        selectedTextColor: Theme.label
        font.pixelSize: root.large ? 15 : Theme.fontBody
        font.family: root.mono ? Theme.fontMono : Theme.fontFamily
        // 程序填进来的字从头显示(AntD 的输入框不会停在末尾)
        onTextChanged: if (!activeFocus) cursorPosition = 0
        onAccepted: root.accepted()
        onTextEdited: root.edited(text)
        onEditingFinished: root.editingFinished()
    }
    // 清除钮(AntD 的 close-circle 实心小图标,三级色;悬停二级色)
    Rectangle {
        visible: root.clearable && field.text !== ""
        anchors.right: parent.right; anchors.rightMargin: root.small ? 7 : 11
        anchors.verticalCenter: parent.verticalCenter
        width: 12; height: 12; radius: 6
        color: clearHover.hovered ? Theme.labelSecondary : Theme.labelTertiary
        Text { anchors.centerIn: parent; text: "✕"; color: Theme.bgControl; font.pixelSize: 7; font.weight: Font.Bold }
        HoverHandler { id: clearHover; cursorShape: Qt.PointingHandCursor }
        TapHandler { onTapped: { field.text = ""; root.edited("") } }
    }
    /// 全选(改标签那种一点开就整段选中的输入框)
    function selectAll() { field.selectAll() }
    function focusField() { field.forceActiveFocus() }
}
