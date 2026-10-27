#!/bin/zsh
# 出 macOS 安装包(docs/features/packaging.md):
#   1. 用 mac-package 预设编一份打包版 Datrix.app(引擎在 Contents/MacOS,提示词 / schema / 条款 / 示例配置在 Contents/Resources);
#   2. 拷到一个临时目录里加工,不动编译目录:画图标、编跟单本地收件读窗口的程序、macdeployqt 带上 Qt(连引擎那个可执行文件一起)、检查不再引用 Homebrew;
#   3. ad-hoc 签名(没有 Developer ID 证书;别的 Mac 第一次打开要右键 → 打开);
#   4. 做成 DMG(里面有 Datrix.app 与 Applications 的快捷方式)。
# 输出目录里只留这一份 .app 与它的 DMG。
#
#   native/tools/package_mac.sh [输出目录,默认 ~/Developer/ibkr/work/dist]
#
# hdiutil 在受限的沙箱里跑不了,要在普通终端里跑这个脚本。
set -euo pipefail

native=${0:A:h:h}
out=${1:-$HOME/Developer/ibkr/work/dist}
build=$HOME/Library/Caches/IBKR-Assistant/native-build/mac-package

cd "$native"
cmake --preset mac-package
cmake --build --preset mac-package --target ibkr_bundle
app_built=$build/app/Datrix.app
[[ -x $app_built/Contents/MacOS/ibkr-engine ]] || { echo "Datrix.app 里没有引擎:编译没走到 ibkr_bundle" >&2; exit 1; }
version=$(plutil -extract CFBundleShortVersionString raw "$app_built/Contents/Info.plist")

stage=$(mktemp -d "${TMPDIR:-/tmp}/datrix-package.XXXXXX")
trap 'rm -rf "$stage"' EXIT
app=$stage/dmg/Datrix.app
mkdir -p "$stage/dmg"
ditto "$app_built" "$app"
chmod -R u+w "$app"  # 编出来的 Info.plist 是只读的,下面要改它

# 图标:矢量现画(tools/make_icon.swift 自己拼 .icns,不走 iconutil)
if swift tools/make_icon.swift "$stage/icon" >/dev/null && [[ -f $stage/icon/icon.icns ]]; then
    cp "$stage/icon/icon.icns" "$app/Contents/Resources/Datrix.icns"
    plutil -replace CFBundleIconFile -string Datrix "$app/Contents/Info.plist"
else
    echo "图标没画出来,先不带图标" >&2
fi

# 本地收件读窗口的程序:编好放在引擎旁边,界面拉引擎时把位置告诉它(DAFRI_INBOX_READER)。只链系统框架,不经 macdeployqt
swiftc -O tools/discord-window-follow.swift -o "$app/Contents/MacOS/discord-window-follow"

# Qt 的库与插件带进包里;引擎是另一个可执行文件,也要改它的引用
macdeployqt "$app" -qmldir="$native/app" -executable="$app/Contents/MacOS/ibkr-engine" -always-overwrite
for bin in "$app/Contents/MacOS/Datrix" "$app/Contents/MacOS/ibkr-engine"; do
    if otool -L "$bin" | grep -q /opt/homebrew; then
        echo "$bin 还引用着 Homebrew 的库,在别的 Mac 上起不来:" >&2
        otool -L "$bin" | grep /opt/homebrew >&2
        exit 1
    fi
done
[[ -d $app/Contents/PlugIns/tls ]] || echo "注意:没有带上 TLS 插件,连大模型、拉事件日历会失败" >&2

codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"

ln -s /Applications "$stage/dmg/Applications"
mkdir -p "$out"
dmg=$out/Datrix-$version.dmg
rm -rf "$out/Datrix.app" "$out"/Datrix-*.dmg(N)
hdiutil create -volname "Datrix $version" -srcfolder "$stage/dmg" -ov -format UDZO "$dmg" >/dev/null
ditto "$app" "$out/Datrix.app"
echo "$out/Datrix.app"
echo "$dmg"
