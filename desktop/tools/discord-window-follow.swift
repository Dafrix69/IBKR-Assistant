// 本地收件的脚本(docs/features/follow.md「本地收件」):读你屏幕上 Discord 窗口里当前频道的消息列表,
// 新出现的消息一行一个 JSON 追加到软件的收件文件。只用 macOS 的辅助功能(Accessibility),不碰 Discord 的接口、不用任何 token。
//
// 用法:
//   swift desktop/tools/discord-window-follow.swift --channel "charlie的策略" --out "~/Library/Application Support/dafri/follow-inbox.jsonl"
//   swift desktop/tools/discord-window-follow.swift --channel "charlie的策略" --dump      # 把消息列表的结构倒出来看(调试)
//
// 前提:
//   * Discord 要用 `open -a Discord --args --force-renderer-accessibility` 启动,否则窗口里的消息对辅助功能不可见;
//   * 运行脚本的终端要在「系统设置 → 隐私与安全性 → 辅助功能」里;
//   * Discord 停在那个频道;窗口标题里不是这个频道时脚本只等、不抄。
//
// 怎么读:Discord 把每条消息放在一个 article 里,它的辅助功能标题是「发送者 服务器标签 , 正文 , 时间」
// (连续发的第二条起屏幕上不再显示名字,标题里照样有);时间那一格旁边藏着一条完整日期的文本(「2026年10月7日 星期三 03:30」),
// 新鲜度按它算。只抄列表里新出现、而且是几分钟之内发出的消息:启动那一刻已有的、往上翻出来的旧消息都不抄。
import Cocoa
import ApplicationServices
import CryptoKit

// ---------------------------------------------------------------- 参数
var channelWanted = ""
var outPath = ""
var intervalSec = 1.5
var dumpMode = false
var bundleId = "com.hnc.Discord"
var freshMinutes = 10.0
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
    let a = args.removeFirst()
    switch a {
    case "--channel": channelWanted = args.isEmpty ? "" : args.removeFirst()
    case "--out": outPath = args.isEmpty ? "" : args.removeFirst()
    case "--interval": intervalSec = Double(args.isEmpty ? "1.5" : args.removeFirst()) ?? 1.5
    case "--fresh-minutes": freshMinutes = Double(args.isEmpty ? "10" : args.removeFirst()) ?? 10
    case "--app": bundleId = args.isEmpty ? bundleId : args.removeFirst()
    case "--dump": dumpMode = true
    default: fputs("不认识的参数:\(a)\n", stderr); exit(2)
    }
}
if channelWanted.isEmpty { fputs("要 --channel 频道名(窗口标题里的那个,不含 #)\n", stderr); exit(2) }
if !dumpMode && outPath.isEmpty { fputs("要 --out 收件文件路径(「接入 → Discord 跟单 → 收件文件」里显示的那个)\n", stderr); exit(2) }
if outPath.hasPrefix("~") { outPath = NSString(string: outPath).expandingTildeInPath }

// ---------------------------------------------------------------- 辅助功能
func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func str(_ el: AXUIElement, _ name: String) -> String {
    guard let v = attr(el, name) else { return "" }
    if let s = v as? String { return s }
    return ""
}
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func role(_ el: AXUIElement) -> String { str(el, kAXRoleAttribute) }
func subrole(_ el: AXUIElement) -> String { str(el, kAXSubroleAttribute) }

func findAll(_ el: AXUIElement, depth: Int = 0, _ pred: (AXUIElement) -> Bool, _ out: inout [AXUIElement]) {
    if depth > 60 { return }
    if pred(el) { out.append(el); return }
    for c in children(el) { findAll(c, depth: depth + 1, pred, &out) }
}

/** 一个元素下面所有静态文本的值,按出现顺序。 */
func staticTexts(_ el: AXUIElement, depth: Int = 0, _ out: inout [String]) {
    if depth > 30 { return }
    if role(el) == "AXStaticText" {
        let v = str(el, kAXValueAttribute)
        if !v.isEmpty { out.append(v) }
        return
    }
    for c in children(el) { staticTexts(c, depth: depth + 1, &out) }
}

func dump(_ el: AXUIElement, _ depth: Int, _ maxDepth: Int, _ budget: inout Int) {
    if depth > maxDepth || budget <= 0 { return }
    let kids = children(el)
    let sub = subrole(el)
    print("\(String(repeating: " ", count: depth))\(role(el))\(sub.isEmpty ? "" : "/" + sub)[\(kids.count)] t=\(str(el, kAXTitleAttribute).prefix(100)) d=\(str(el, kAXDescriptionAttribute).prefix(100)) v=\(str(el, kAXValueAttribute).prefix(120))")
    budget -= 1
    for c in kids { dump(c, depth + 1, maxDepth, &budget) }
}

// ---------------------------------------------------------------- 找窗口与消息列表
struct Found {
    let window: AXUIElement
    let title: String
    let list: AXUIElement
}

func locate(app: NSRunningApplication) -> Found? {
    let appEl = AXUIElementCreateApplication(app.processIdentifier)
    // Electron 认这个属性;没用 --force-renderer-accessibility 启动时它不够,但设一下没坏处
    AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let windows = (attr(appEl, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    for w in windows {
        let title = str(w, kAXTitleAttribute)
        if !title.contains(channelWanted) { continue }
        var webs: [AXUIElement] = []
        findAll(w, { role($0) == "AXWebArea" }, &webs)
        guard let web = webs.first else { continue }
        var lists: [AXUIElement] = []
        findAll(web, { role($0) == "AXList" }, &lists)
        // 频道消息列表:描述里带「消息」/「Messages」,而且不是私信列表;找不到就取子项最多的那个
        let msgKeys = ["消息", "Messages", "messages"]
        let list = lists.first { l in
            let d = str(l, kAXDescriptionAttribute) + str(l, kAXTitleAttribute)
            return msgKeys.contains { d.contains($0) } && !d.contains("私信")
        } ?? lists.max { children($0).count < children($1).count }
        guard let l = list else { continue }
        return Found(window: w, title: title, list: l)
    }
    return nil
}

// ---------------------------------------------------------------- 一条消息
struct Message {
    let author: String
    /// 屏幕上的短标签(「03:30」「昨天23:25」),只用来显示
    let timeLabel: String
    /// Discord 藏在旁边的完整时刻(「2026年10月7日 星期三 03:30」解出来的),判新鲜度用它
    let sentAt: Date?
    let content: String
    var key: String {
        let stamp = sentAt.map { String(Int($0.timeIntervalSince1970)) } ?? timeLabel
        let digest = SHA256.hash(data: Data("\(author)\u{1}\(stamp)\u{1}\(content)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined().prefix(24).description
    }
}

/** 「2026年10月7日 星期三 03:30」→ 本机时区的时刻;不是这个样子回 nil。 */
let fullDatePattern = try! NSRegularExpression(pattern: "(\\d{4})年(\\d{1,2})月(\\d{1,2})日[^0-9]*(\\d{1,2}):(\\d{2})")
func parseFullDate(_ s: String) -> Date? {
    let ns = s as NSString
    guard let m = fullDatePattern.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
    var c = DateComponents()
    c.year = Int(ns.substring(with: m.range(at: 1)))
    c.month = Int(ns.substring(with: m.range(at: 2)))
    c.day = Int(ns.substring(with: m.range(at: 3)))
    c.hour = Int(ns.substring(with: m.range(at: 4)))
    c.minute = Int(ns.substring(with: m.range(at: 5)))
    return Calendar.current.date(from: c)
}

/** 列表项 → 消息。日期分隔线(AXSplitter)、没有 article 的项回 nil。 */
func extract(_ item: AXUIElement) -> Message? {
    var articles: [AXUIElement] = []
    findAll(item, { subrole($0) == "AXDocumentArticle" }, &articles)
    guard let article = articles.first else { return nil }
    let title = str(article, kAXTitleAttribute)
    let segments = title.components(separatedBy: " , ")
    guard segments.count >= 2 else { return nil }
    var author = segments[0].trimmingCharacters(in: .whitespaces)
    // 标题里发送者后面跟着服务器标签(「服务器标签：账户新高」):标签在 Discord 里是单独的按钮,按它的名字去掉
    var tagButtons: [AXUIElement] = []
    findAll(article, { role($0) == "AXButton" && str($0, kAXTitleAttribute).hasPrefix("服务器标签") }, &tagButtons)
    for b in tagButtons {
        let t = str(b, kAXTitleAttribute)
        if let r = author.range(of: t) { author.removeSubrange(r) }
    }
    author = author.replacingOccurrences(of: "\\s*服务器标签[：:].*$", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    if author.isEmpty { return nil }
    let timeLabel = segments.count >= 3 ? segments[segments.count - 1].trimmingCharacters(in: .whitespaces) : ""
    let body = segments.count >= 3 ? segments[1..<(segments.count - 1)].joined(separator: " , ") : segments[1]
    var all: [String] = []
    staticTexts(article, &all)
    let sentAt = all.lazy.compactMap { parseFullDate($0) }.first
    return Message(author: author, timeLabel: timeLabel, sentAt: sentAt, content: body.trimmingCharacters(in: .whitespacesAndNewlines))
}

func scan(_ list: AXUIElement) -> [Message] {
    return children(list).compactMap { extract($0) }
}

// ---------------------------------------------------------------- 主循环
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
    fputs("Discord 没在运行(\(bundleId))\n", stderr); exit(1)
}
if !AXIsProcessTrusted() {
    fputs("这个终端没有辅助功能权限:系统设置 → 隐私与安全性 → 辅助功能,加进去再运行。\n", stderr)
    _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    exit(1)
}

func describe(_ m: Message) -> String {
    let when = m.sentAt.map { "\($0)" } ?? "没有完整日期"
    return "[\(m.timeLabel) | \(when)] \(m.author): \(m.content.replacingOccurrences(of: "\n", with: " ⏎ "))"
}

if dumpMode {
    guard let found = locate(app: app) else {
        fputs("没找到标题里带「\(channelWanted)」的窗口,或者窗口里没有消息列表。Discord 是不是没带 --force-renderer-accessibility 启动?\n", stderr)
        exit(1)
    }
    print("窗口:\(found.title)")
    let items = children(found.list)
    print("列表项:\(items.count)(倒出最后 3 项)")
    var budget = 300
    for it in items.suffix(3) { dump(it, 0, 10, &budget); print("---") }
    print("== 解析结果(最后 8 条)==")
    for m in scan(found.list).suffix(8) { print("\(describe(m))  key=\(m.key)") }
    exit(0)
}

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
var known = Set<String>()
var primed = false
var waitingSaid = false

func append(_ m: Message, channel: String) {
    let line: [String: Any] = [
        "v": 1, "key": m.key, "seen_at": iso.string(from: Date()), "channel": channel,
        "author": m.author, "time_label": m.timeLabel, "content": m.content,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.withoutEscapingSlashes]) else { return }
    if !FileManager.default.fileExists(atPath: outPath) { FileManager.default.createFile(atPath: outPath, contents: nil) }
    if let h = FileHandle(forWritingAtPath: outPath) {
        h.seekToEndOfFile()
        h.write(data)
        h.write("\n".data(using: .utf8)!)
        h.closeFile()
        print(describe(m))
    } else {
        fputs("写不进收件文件:\(outPath)\n", stderr)
    }
}

print("盯着「\(channelWanted)」,新消息追加到 \(outPath)。启动时列表里已有的不抄。Ctrl-C 停。")
while true {
    guard let found = locate(app: app) else {
        if !waitingSaid {
            print("等窗口切回「\(channelWanted)」…(标题里要有它;Discord 要带 --force-renderer-accessibility 启动)")
            waitingSaid = true
        }
        primed = false
        known.removeAll()
        Thread.sleep(forTimeInterval: intervalSec)
        continue
    }
    waitingSaid = false
    let messages = scan(found.list)
    let keys = messages.map { $0.key }
    if !primed {
        known = Set(keys)
        primed = true
        print("已就位:窗口「\(found.title)」,列表里现有 \(messages.count) 条,之后新出现的才抄。")
    } else {
        let now = Date()
        for m in messages where !known.contains(m.key) {
            known.insert(m.key)
            // 只抄几分钟之内发出的:往上翻出来的旧消息不算新;读不到完整日期的不抄(宁可漏,不可错)
            guard let at = m.sentAt else { continue }
            let ageMinutes = now.timeIntervalSince(at) / 60
            if ageMinutes < -2 || ageMinutes > freshMinutes { continue }
            append(m, channel: found.title)
        }
        if known.count > 2000 { known = Set(keys) }
    }
    Thread.sleep(forTimeInterval: intervalSec)
}
