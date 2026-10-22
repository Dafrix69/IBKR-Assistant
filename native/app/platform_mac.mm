#include "platform.h"

#include <QGuiApplication>
#include <QMenu>
#include <QWindow>

#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>
#include <IOKit/ps/IOPowerSources.h>
#include <IOKit/ps/IOPSKeys.h>
#include <IOKit/pwr_mgt/IOPMLib.h>

namespace ibkr::app::platform {

namespace {

NSString* ns(const QString& s) { return s.toNSString(); }

/// 无窗口平台(自检、截图)上 winId 不是 NSView、也没有 Dock:原生那几样一律不碰
bool cocoa() { return QGuiApplication::platformName() == QLatin1StringView("cocoa"); }

/// 当前那一次 Dock 跳的请求号:macOS 上每调一次 requestUserAttention 都是一次新的,只有最后一个能取消
NSInteger g_attention = 0;

}  // namespace

void playWav(const QByteArray& wav) {
    @autoreleasepool {
        NSData* data = [NSData dataWithBytes:wav.constData() length:NSUInteger(wav.size())];
        NSSound* sound = [[NSSound alloc] initWithData:data];
        [sound play];  // NSSound 在播放期间自己留着自己
    }
}

bool notify(const QString& title, const QString& body) {
    if (!cocoa()) return false;
    // 没有包标识(不是从 .app 里起来的)时 UNUserNotificationCenter 会直接抛:先看一眼
    if (![[NSBundle mainBundle] bundleIdentifier]) return false;
    @autoreleasepool {
        UNUserNotificationCenter* center = [UNUserNotificationCenter currentNotificationCenter];
        static bool asked = false;
        if (!asked) {
            asked = true;
            [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                                  completionHandler:^(BOOL, NSError*) {}];
        }
        UNMutableNotificationContent* content = [[UNMutableNotificationContent alloc] init];
        content.title = ns(title);
        content.body = ns(body);
        NSString* identifier = [[NSUUID UUID] UUIDString];
        UNNotificationRequest* request = [UNNotificationRequest requestWithIdentifier:identifier content:content trigger:nil];
        [center addNotificationRequest:request withCompletionHandler:^(NSError*) {}];
    }
    return true;
}

void requestAttention(QWindow*, bool on) {
    if (!cocoa()) return;
    if (on) {
        g_attention = [NSApp requestUserAttention:NSCriticalRequest];
    } else if (g_attention) {
        [NSApp cancelUserAttentionRequest:g_attention];
        g_attention = 0;
    }
}

void makeFloatingPanel(QWindow* window) {
    if (!window || !cocoa()) return;
    NSView* view = reinterpret_cast<NSView*>(window->winId());
    NSWindow* w = view.window;
    if (!w) return;
    // 屏保那一层:别的置顶窗口(TWS 的对话框)压不住它;所有桌面、别的应用的全屏空间之上都看得见
    w.level = NSScreenSaverWindowLevel;
    // Qt 给工具窗口设了 MoveToActiveSpace;它和 CanJoinAllSpaces 互斥,两个同时在 AppKit 当场抛异常(整个应用退出),先去掉
    NSWindowCollectionBehavior behavior = w.collectionBehavior & ~NSWindowCollectionBehaviorMoveToActiveSpace;
    w.collectionBehavior = behavior | NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorIgnoresCycle;
    w.hidesOnDeactivate = NO;
    if ([w isKindOfClass:[NSPanel class]]) {
        NSPanel* panel = static_cast<NSPanel*>(w);
        panel.becomesKeyOnlyIfNeeded = YES;
        panel.floatingPanel = YES;
        panel.styleMask |= NSWindowStyleMaskNonactivatingPanel;
    }
}

void hideTitleText(QWindow* window) {
    if (!window || !cocoa()) return;
    NSWindow* w = reinterpret_cast<NSView*>(window->winId()).window;
    if (!w) return;
    w.titleVisibility = NSWindowTitleHidden;
    w.titlebarAppearsTransparent = YES;
}

void revealFile(const QString& path) {
    @autoreleasepool {
        NSURL* url = [NSURL fileURLWithPath:ns(path)];
        [[NSWorkspace sharedWorkspace] activateFileViewerSelectingURLs:@[url]];
    }
}

void setDockMenu(QMenu* menu) {
    if (menu && cocoa()) menu->setAsDockMenu();
}

}  // namespace ibkr::app::platform

// kAEReopenApplication(点 Dock 图标、在访达里再打开一次):Qt 没有对外的信号,接 Apple Event
@interface IbkrReopenHandler : NSObject
@property(nonatomic) std::function<void()>* handler;
- (void)handleReopen:(NSAppleEventDescriptor*)event withReplyEvent:(NSAppleEventDescriptor*)reply;
@end
@implementation IbkrReopenHandler
- (void)handleReopen:(NSAppleEventDescriptor*)event withReplyEvent:(NSAppleEventDescriptor*)reply {
    (void)event;
    (void)reply;
    if (self.handler && *self.handler) (*self.handler)();
}
@end

namespace ibkr::app::platform {

void onReopen(std::function<void()> handler) {
    if (!cocoa()) return;
    static IbkrReopenHandler* target = [[IbkrReopenHandler alloc] init];
    static std::function<void()> stored;
    stored = std::move(handler);
    target.handler = &stored;
    [[NSAppleEventManager sharedAppleEventManager] setEventHandler:target
                                                       andSelector:@selector(handleReopen:withReplyEvent:)
                                                     forEventClass:kCoreEventClass
                                                        andEventID:kAEReopenApplication];
}

void activateApp() {
    if (cocoa()) [NSApp activateIgnoringOtherApps:YES];
}

std::optional<bool> onBatteryPower() {
    CFTypeRef info = IOPSCopyPowerSourcesInfo();
    if (!info) return std::nullopt;
    CFStringRef type = IOPSGetProvidingPowerSourceType(info);
    std::optional<bool> out;
    if (type) out = CFStringCompare(type, CFSTR(kIOPMBatteryPowerKey), 0) == kCFCompareEqualTo;
    CFRelease(info);
    return out;
}

namespace {

std::function<void(bool)> g_powerChanged;
std::optional<bool> g_lastBattery;

void powerSourceChanged(void*) {
    const auto battery = onBatteryPower();
    // 电源列表变了不一定是换了电源(电量也会触发):只在真的换了时回调
    if (!battery || battery == g_lastBattery) return;
    g_lastBattery = battery;
    if (g_powerChanged) g_powerChanged(*battery);
}

}  // namespace

void watchPower(std::function<void(bool)> powerChanged, std::function<void()> willSleep, std::function<void()> didWake) {
    if (!cocoa()) return;
    g_powerChanged = std::move(powerChanged);
    g_lastBattery = onBatteryPower();
    if (CFRunLoopSourceRef source = IOPSNotificationCreateRunLoopSource(powerSourceChanged, nullptr)) {
        CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopDefaultMode);
        CFRelease(source);
    }
    NSNotificationCenter* center = [[NSWorkspace sharedWorkspace] notificationCenter];
    auto sleep = std::make_shared<std::function<void()>>(std::move(willSleep));
    auto wake = std::make_shared<std::function<void()>>(std::move(didWake));
    [center addObserverForName:NSWorkspaceWillSleepNotification object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification*) {
        if (*sleep) (*sleep)();
    }];
    [center addObserverForName:NSWorkspaceDidWakeNotification object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification*) {
        if (*wake) (*wake)();
    }];
}

bool preventAppSuspension() {
    static IOPMAssertionID assertion = 0;
    static id<NSObject> activity = nil;
    if (!activity) {
        activity = [[NSProcessInfo processInfo] beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep
                                                                  reason:@"盯盘与提醒:窗口藏着时也要准点"];
    }
    if (assertion) return true;
    return IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleSystemSleep, kIOPMAssertionLevelOn,
                                       CFSTR("Datrix 在盯盘:挂起期间持仓追踪不判断"), &assertion) == kIOReturnSuccess;
}

}  // namespace ibkr::app::platform
