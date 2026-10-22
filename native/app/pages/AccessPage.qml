import QtQuick
import Dafri.Kit

// 接入(pages/Access.tsx):TWS、富途 OpenD、账户、大模型、Discord 跟单,五个子页签各是一节(lib/TwsPanel、FutuPanel、AccountsPanel、LlmPanel、FollowPanel)。
// 整条路都不接触任何券商的登录密码——登录在券商程序自己的窗口完成。内容最宽 880。
// 状态与取数都在 C++(shell/access_controller),每一节怎么摆在 shell/access_rules;这里只摆
ScrollPage {
    id: page
    property var controller: null
    readonly property var m: controller ? controller.model : ({})
    readonly property string sub: controller ? controller.sub : "tws"
    signal notify(string title, string body)
    maxWidth: 880
    Component.onCompleted: if (controller) controller.setVisible(true)
    Component.onDestruction: if (controller) controller.setVisible(false)

    PageHead {
        width: parent.width
        title: "接入"
        Segmented {
            options: [{ value: "tws", label: "TWS" }, { value: "futu", label: "富途 OpenD" }, { value: "accounts", label: "账户" },
                      { value: "llm", label: "大模型" }, { value: "follow", label: "Discord 跟单" }]
            value: page.sub
            onActivated: function (v) { if (page.controller) page.controller.setSub(v) }
        }
    }
    Loader {
        width: parent.width
        sourceComponent: page.sub === "tws" || page.sub === "futu" ? brokerPanel : page.sub === "accounts" ? accountsPanel : page.sub === "llm" ? llmPanel : followPanel
    }
    Component { id: brokerPanel; AccessParts.BrokerPanel { width: parent ? parent.width : 0; m: page.m; futu: page.sub === "futu"; controller: page.controller } }
    Component { id: accountsPanel; AccessParts.AccountsPanel { width: parent ? parent.width : 0; m: page.m; controller: page.controller } }
    Component { id: llmPanel; AccessParts.LlmPanel { width: parent ? parent.width : 0; m: page.m; controller: page.controller } }
    Component { id: followPanel; AccessParts.FollowPanel { width: parent ? parent.width : 0; m: page.m; controller: page.controller } }
}
