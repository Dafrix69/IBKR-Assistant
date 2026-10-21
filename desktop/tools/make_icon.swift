// 应用图标的生成脚本:画一次矢量,按各尺寸直接栅格化(不是拿 1024 缩小),产出
//
//   build/icon.icns   macOS(16…1024 共 10 段 PNG)
//   build/icon.ico    Windows(16…256 七张 PNG 装进 ICO)
//   build/icon.png    1024 的 macOS 版,开发态 `npm start` 的 Dock 图标用它
//
//   swift tools/make_icon.swift [输出目录=build] [--preview 预览图.png]
//
// 为什么是 Swift 不是 Node:要的是渐变、柔和投影、抗锯齿的矢量渲染,CoreGraphics 本机就有;
// Node 这边得引一个 canvas / sharp 之类的原生依赖,只为了一年跑一两次的出图不值得。
// 图标改了就重跑一遍,把 build/ 下三个产物一起提交——打包不依赖这个脚本。
//
// 造型(docs/features/ui.md「应用图标」):Mac 的连续圆角方形 + 深海蓝渐变 + 玻璃边,
// 一个白色粗笔画的 D(Datrix),D 里三根逐级走高的柱子,最高那根是暖金色。颜色克制:蓝、白、一点金。
import AppKit

// ---- 几何:都在 1024 的画布坐标里,原点左上 --------------------------------------------

struct Layout {
  let body: CGRect        // 图标底板
  let shadow: Bool        // macOS 的图标自带落影;Windows 的不带
}
// macOS 图标网格(Big Sur 起):1024 画布、824 的底板、四周各留 100
let macLayout = Layout(body: CGRect(x: 100, y: 100, width: 824, height: 824), shadow: true)
// Windows 的图标铺得更满,系统不会再给它套底板
let winLayout = Layout(body: CGRect(x: 32, y: 32, width: 960, height: 960), shadow: false)

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
          blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

/// 超椭圆(n = 5):和 Apple 的"连续曲率圆角"几乎重合,没有普通圆角矩形那道曲率突变的折痕
func squircle(_ r: CGRect, n: CGFloat = 5) -> CGPath {
  let p = CGMutablePath()
  let cx = r.midX, cy = r.midY, a = r.width / 2, b = r.height / 2
  let steps = 720
  for i in 0...steps {
    let t = CGFloat(i) / CGFloat(steps) * 2 * .pi
    let c = cos(t), s = sin(t)
    let x = cx + a * (c < 0 ? -1 : 1) * pow(abs(c), 2 / n)
    let y = cy + b * (s < 0 ? -1 : 1) * pow(abs(s), 2 / n)
    if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
  }
  p.closeSubpath()
  return p
}

// D 与柱子:在"底板单位坐标"里定义(0…1,左上为原点),换底板大小时整体跟着缩放
struct Mark { let left: CGFloat; let top: CGFloat; let bottom: CGFloat; let right: CGFloat; let stroke: CGFloat }
struct Bar { let x: CGFloat; let width: CGFloat; let height: CGFloat; let gold: Bool; let alpha: CGFloat }
let mark = Mark(left: 0.238, top: 0.218, bottom: 0.782, right: 0.762, stroke: 0.083)
let barBase: CGFloat = 0.684
let bars = [
  Bar(x: 0.342, width: 0.070, height: 0.136, gold: false, alpha: 0.58),
  Bar(x: 0.449, width: 0.070, height: 0.226, gold: false, alpha: 0.85),
  Bar(x: 0.556, width: 0.070, height: 0.325, gold: true, alpha: 1.00),
]
// 32px 及以下:笔画加粗、只留两根柱子,不然糊成一片
let smallMark = Mark(left: 0.238, top: 0.218, bottom: 0.782, right: 0.762, stroke: 0.115)
let smallBarBase: CGFloat = 0.670
let smallBars = [
  Bar(x: 0.365, width: 0.095, height: 0.180, gold: false, alpha: 0.85),
  Bar(x: 0.505, width: 0.095, height: 0.330, gold: true, alpha: 1.00),
]

/// D:竖笔 + 右边一个半圆,描边沿路径居中
func letterD(_ m: Mark, _ u: (CGFloat, CGFloat) -> CGPoint, _ s: CGFloat) -> CGPath {
  let r = (m.bottom - m.top) / 2 * s
  let top = u(m.left, m.top), bottom = u(m.left, m.bottom)
  let center = CGPoint(x: u(m.right, 0).x - r, y: (top.y + bottom.y) / 2)
  let p = CGMutablePath()
  p.move(to: top)
  p.addLine(to: CGPoint(x: center.x, y: top.y))
  p.addArc(center: center, radius: r, startAngle: -.pi / 2, endAngle: .pi / 2, clockwise: false)
  p.addLine(to: bottom)
  p.closeSubpath()
  return p
}

// ---- 绘制 -------------------------------------------------------------------------------

// CGContext 的阴影(偏移、模糊)按设备像素算,不吃坐标变换:既不跟着 1024 → px 缩放,也不跟着翻转。
// 所以这里统一换算——不然小尺寸上 24px 的模糊会糊成一圈灰方框,阴影还往上跑
var deviceScale: CGFloat = 1
func setShadow(_ ctx: CGContext, dy: CGFloat, blur: CGFloat, color: CGColor) {
  ctx.setShadow(offset: CGSize(width: 0, height: -dy * deviceScale), blur: blur * deviceScale, color: color)
}

func drawIcon(_ ctx: CGContext, _ L: Layout) {
  let body = L.body
  let shape = squircle(body)
  let u = { (x: CGFloat, y: CGFloat) in CGPoint(x: body.minX + x * body.width, y: body.minY + y * body.height) }
  let s = body.width  // 底板单位长度

  // 1. 落影:macOS 网格里的那一道(向下 10、柔化 24)
  if L.shadow {
    ctx.saveGState()
    setShadow(ctx, dy: 10, blur: 24, color: rgb(0x000000, 0.32))
    ctx.addPath(shape); ctx.setFillColor(rgb(0x0B2A6E)); ctx.fillPath()
    ctx.restoreGState()
  }

  // 2. 底板:左上亮蓝 → 右下深海蓝
  ctx.saveGState()
  ctx.addPath(shape); ctx.clip()
  let bg = CGGradient(colorsSpace: nil, colors: [rgb(0x4A95FF), rgb(0x1A5BDB), rgb(0x0B2566)] as CFArray,
                      locations: [0, 0.48, 1])!
  ctx.drawLinearGradient(bg, start: u(0.15, 0.0), end: u(0.85, 1.0), options: [])
  // 左上一团漫射光,右下一点压暗:让底板有体积,而不是一块平涂
  let glow = CGGradient(colorsSpace: nil, colors: [rgb(0xFFFFFF, 0.22), rgb(0xFFFFFF, 0)] as CFArray, locations: [0, 1])!
  ctx.drawRadialGradient(glow, startCenter: u(0.22, 0.10), startRadius: 0, endCenter: u(0.22, 0.10), endRadius: s * 0.75, options: [])
  let dusk = CGGradient(colorsSpace: nil, colors: [rgb(0x020A24, 0), rgb(0x020A24, 0.30)] as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(dusk, start: u(0.5, 0.55), end: u(0.5, 1.0), options: [])

  // 3. D:白色粗笔画,垫一层柔影托离底板
  let small = deviceScale * 1024 <= 32
  let m = small ? smallMark : mark
  ctx.saveGState()
  setShadow(ctx, dy: s * 0.012, blur: s * 0.030, color: rgb(0x020A24, 0.35))
  ctx.addPath(letterD(m, u, s)); ctx.setLineWidth(m.stroke * s); ctx.setLineJoin(.round)
  ctx.setStrokeColor(rgb(0xFFFFFF)); ctx.strokePath()
  ctx.restoreGState()

  // 4. D 里的柱子:越往右越高越实(读作"在涨"),最高那根暖金渐变
  let base = small ? smallBarBase : barBase
  for b in small ? smallBars : bars {
    let rect = CGRect(x: body.minX + b.x * s, y: body.minY + (base - b.height) * s, width: b.width * s, height: b.height * s)
    let path = CGPath(roundedRect: rect, cornerWidth: b.width * s * 0.3, cornerHeight: b.width * s * 0.3, transform: nil)
    ctx.saveGState()
    if b.gold {
      setShadow(ctx, dy: 0, blur: s * 0.035, color: rgb(0xFFD36B, 0.45))
      ctx.addPath(path); ctx.setFillColor(rgb(0xFFD36B)); ctx.fillPath()
      ctx.restoreGState(); ctx.saveGState()
      ctx.addPath(path); ctx.clip()
      let gold = CGGradient(colorsSpace: nil, colors: [rgb(0xFFF4CF), rgb(0xFFD063), rgb(0xF5A524)] as CFArray,
                            locations: [0, 0.45, 1])!
      ctx.drawLinearGradient(gold, start: CGPoint(x: rect.midX, y: rect.minY), end: CGPoint(x: rect.midX, y: rect.maxY), options: [])
    } else {
      ctx.addPath(path); ctx.setFillColor(rgb(0xFFFFFF, b.alpha)); ctx.fillPath()
    }
    ctx.restoreGState()
  }

  // 5. 玻璃边:上沿亮、下沿几乎看不见的一道内描边
  ctx.addPath(shape); ctx.setLineWidth(s * 0.0075)
  ctx.replacePathWithStrokedPath(); ctx.clip()
  let rim = CGGradient(colorsSpace: nil, colors: [rgb(0xFFFFFF, 0.55), rgb(0xFFFFFF, 0.08), rgb(0xFFFFFF, 0.18)] as CFArray,
                       locations: [0, 0.6, 1])!
  ctx.drawLinearGradient(rim, start: u(0.5, 0), end: u(0.5, 1), options: [])
  ctx.restoreGState()
}

func render(_ px: Int, _ L: Layout) -> NSBitmapImageRep {
  let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.interpolationQuality = .high
  ctx.setShouldAntialias(true)
  // 翻成左上原点,再按 1024 → px 缩放:每个尺寸都是矢量直接落格
  ctx.translateBy(x: 0, y: CGFloat(px)); ctx.scaleBy(x: 1, y: -1)
  ctx.scaleBy(x: CGFloat(px) / 1024, y: CGFloat(px) / 1024)
  deviceScale = CGFloat(px) / 1024
  drawIcon(ctx, L)
  return NSBitmapImageRep(cgImage: ctx.makeImage()!)
}

func png(_ rep: NSBitmapImageRep) -> Data { rep.representation(using: .png, properties: [:])! }

func write(_ data: Data, _ path: String) {
  try! data.write(to: URL(fileURLWithPath: path))
}

// ---- 产物 -------------------------------------------------------------------------------

var args = Array(CommandLine.arguments.dropFirst())
var previewPath: String? = nil
if let i = args.firstIndex(of: "--preview"), i + 1 < args.count {
  previewPath = args[i + 1]; args.removeSubrange(i...(i + 1))
}
let outDir = args.first ?? "build"
let fm = FileManager.default
try! fm.createDirectory(atPath: outDir, withIntermediateDirectories: true)

// macOS:.icns 自己拼,不走 iconutil——它要调一个系统服务,受限环境(沙箱、部分 CI)里会报
// "Failed to generate ICNS",连一个好好的 iconset 都转不回去。格式很简单:'icns' + 总长,
// 后面一段段 [类型 4 字节][段长 4 字节][PNG]。类型表与 iconutil 产出的一致,16 / 32 用 PNG 版的 icp4 / icp5(10.7 起支持)
let icnsEntries: [(String, Int)] = [
  ("icp4", 16), ("ic11", 32), ("icp5", 32), ("ic12", 64), ("ic07", 128),
  ("ic13", 256), ("ic08", 256), ("ic14", 512), ("ic09", 512), ("ic10", 1024),
]
var rendered: [Int: Data] = [:]
var icns = Data()
func be32(_ v: Int, into d: inout Data) { var x = UInt32(v).bigEndian; d.append(Data(bytes: &x, count: 4)) }
for (type, size) in icnsEntries {
  let data = rendered[size] ?? png(render(size, macLayout))
  rendered[size] = data
  icns.append(type.data(using: .ascii)!)
  be32(8 + data.count, into: &icns)
  icns.append(data)
}
var icnsFile = "icns".data(using: .ascii)!
be32(8 + icns.count, into: &icnsFile)
icnsFile.append(icns)
write(icnsFile, "\(outDir)/icon.icns")
write(rendered[1024]!, "\(outDir)/icon.png")

// Windows:ICO 里直接装 PNG(Vista 起都认),7 个尺寸
let winSizes = [16, 24, 32, 48, 64, 128, 256]
let pngs = winSizes.map { png(render($0, winLayout)) }
var ico = Data()
func le16(_ v: Int) { var x = UInt16(v).littleEndian; ico.append(Data(bytes: &x, count: 2)) }
func le32(_ v: Int) { var x = UInt32(v).littleEndian; ico.append(Data(bytes: &x, count: 4)) }
le16(0); le16(1); le16(winSizes.count)
var offset = 6 + 16 * winSizes.count
for (size, data) in zip(winSizes, pngs) {
  ico.append(UInt8(size >= 256 ? 0 : size)); ico.append(UInt8(size >= 256 ? 0 : size))
  ico.append(0); ico.append(0)          // 调色板数、保留
  le16(1); le16(32)                     // 色面、位深
  le32(data.count); le32(offset)
  offset += data.count
}
for data in pngs { ico.append(data) }
write(ico, "\(outDir)/icon.ico")

// 预览:深浅两种桌面底色上,各尺寸并排(只给人看,不进仓库)
if let previewPath {
  let W = 1760, H = 1040
  let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setFillColor(rgb(0xECECF0)); ctx.fill(CGRect(x: 0, y: H / 2, width: W, height: H / 2))
  ctx.setFillColor(rgb(0x1E1E22)); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H / 2))
  for (row, y) in [(0, H / 2 + 20), (1, 20)] {
    var x = 30
    for size in [480, 256, 128, 64, 32, 16] {
      let img = render(size, macLayout).cgImage!
      ctx.draw(img, in: CGRect(x: x, y: y + (480 - size) / 2, width: size, height: size))
      x += size + 40
    }
    let win = render(256, winLayout).cgImage!
    ctx.draw(win, in: CGRect(x: W - 256 - 40, y: y + 112, width: 256, height: 256))
    _ = row
  }
  write(png(NSBitmapImageRep(cgImage: ctx.makeImage()!)), previewPath)
}
print("icon.icns / icon.ico / icon.png → \(outDir)")
