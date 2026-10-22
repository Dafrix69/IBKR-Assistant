import QtQuick

// 数字输入框(AntD InputNumber):值是数或 null(空着 = 不设),交出去的就是这两样——绝不交字符串。
// **受控**:value 只由外面给(绑定),这里从不给它赋值——自己一赋值,外面的绑定就断了,框里显示的和真正发出去的会对不上。
// 打字时只发 valueEdited,外面改了状态,绑定把新值送回来。
// 照 rc-input-number:打字途中越界的数不算数(不发);打完(回车 / 失焦)时夹到范围里再发一次,框里改写成真正的值
// (夹过的、敲到一半的 "1." "-" 都改正)。只认十进制;min ≥ 0 时连负号都敲不进去。
// 显示的小数位同 rc-input-number(没给 precision 时):值本身的位数与步长的位数取大的那个——步长 0.05 时 0 写成「0.00」、0.1 写成「0.10」
Input {
    id: root
    property var value: null
    property real min: -Infinity
    property real max: Infinity
    property real step: 1
    signal valueEdited(var value)
    validator: RegularExpressionValidator { regularExpression: root.min >= 0 ? /^\d*\.?\d*$/ : /^-?\d*\.?\d*$/ }
    inputMethodHints: Qt.ImhFormattedNumbersOnly
    function decimals(x) { var s = String(x); var e = s.indexOf("e-"); if (e >= 0) return Number(s.slice(e + 2)); var d = s.indexOf("."); return d < 0 ? 0 : s.length - d - 1 }
    function show(v) { return v === null || v === undefined ? "" : Number(v).toFixed(Math.max(decimals(v), decimals(root.step))) }
    function parse(t) {
        if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return undefined
        var n = Number(t)
        return isFinite(n) ? n : undefined
    }
    // 外面的值变了就照它重写。正在打字时,只有框里的字读出来不是这个值(是外面改的,例如点了价位 chip)才重写——
    // 刚敲出来的那个数回到这里时不动,免得光标跳走
    onValueChanged: {
        if (text === show(value)) return
        if (root.focused) {
            var n = parse(text.trim())
            if (n === value || (n === undefined && text.trim() === "" && (value === null || value === undefined))) return
        }
        text = show(value)
    }
    Component.onCompleted: text = show(value)
    onEdited: function (t) {
        if (t.trim() === "") { root.valueEdited(null); return }
        var n = parse(t)
        if (n === undefined || n < root.min || n > root.max) return
        if (n !== root.value) root.valueEdited(n)
    }
    onEditingFinished: {
        var n = parse(text.trim())
        if (n !== undefined) {
            var c = Math.max(root.min, Math.min(root.max, n))
            if (c !== root.value) root.valueEdited(c)
        }
        text = show(root.value)
    }
}
