import QtQuick
Item {
    Component.onCompleted: {
        var res = {}
        var L = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789", C = "交易记录已成交仅校验未发送去向不明"
        for (var px of [9,10,11,12,13,14,15,16,17,18,20,22,24,26,28,32]) for (var w of [400, 590, 700]) for (var k of ["L","C"]) {
            var t = Qt.createQmlObject('import QtQuick; Text {}', this)
            t.text = k === "L" ? L : C; t.font.family = ".AppleSystemUIFont"; t.font.pointSize = px; t.font.weight = w; t.font.variableAxes = { "wght": w }
            res[px + "/" + w + "/" + k] = +t.implicitWidth.toFixed(3)
            t.destroy()
        }
        console.log(JSON.stringify(res)); Qt.quit()
    }
}
