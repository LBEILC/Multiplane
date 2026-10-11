import AppKit
import ApplicationServices

// Inspect and press the actual NSWindow buttons through Accessibility.
// Do not request permission interactively or change the machine's privacy settings.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    guard result == .success, let value = value else { fail("AX attribute \(name) failed: \(result.rawValue)") }
    return value
}
func actionNames(_ element: AXUIElement) -> [String] {
    var actions: CFArray?
    let result = AXUIElementCopyActionNames(element, &actions)
    guard result == .success else { fail("Cannot read button actions: \(result.rawValue)") }
    return actions as? [String] ?? []
}
func emit(_ value: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
    } catch { fail("Cannot encode AX result: \(error)") }
}
func pressWithOption(_ button: AXUIElement) -> AXError {
    // Hold a real modifier while AXPress is delivered; release on every return path.
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 58, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 58, keyDown: false) else {
        fail("Cannot create Option key events")
    }
    down.flags = .maskAlternate
    up.flags = []
    down.post(tap: .cghidEventTap)
    defer { up.post(tap: .cghidEventTap) }
    let deadline = Date().addingTimeInterval(2)
    while !CGEventSource.flagsState(.combinedSessionState).contains(.maskAlternate) {
        if Date() >= deadline {
            // exit() does not run defer.
            up.post(tap: .cghidEventTap)
            fail("Option key did not become active within 2000ms")
        }
        Thread.sleep(forTimeInterval: 0.01)
    }
    return AXUIElementPerformAction(button, kAXPressAction as CFString)
}

guard (3...4).contains(CommandLine.arguments.count), let pid = Int32(CommandLine.arguments[1]) else { fail("Expected pid and inspect|minimize|maximize|restore|close [AXPress|AXZoomWindow|Option+AXPress]") }
guard AXIsProcessTrusted() else { fail("Accessibility permission unavailable for the smoke runner") }
let application = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(application, 5)
let windows = attribute(application, kAXWindowsAttribute) as! [AXUIElement]
guard windows.count == 1 else { fail("Expected exactly one application window") }
let window = windows[0]
let names = ["minimize": kAXMinimizeButtonAttribute, "maximize": kAXZoomButtonAttribute, "close": kAXCloseButtonAttribute]
let action = CommandLine.arguments[2]
if action == "inspect" {
    var buttons: [String: Any] = [:]
    for (name, key) in names {
        let button = attribute(window, key) as! AXUIElement
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(attribute(button, kAXPositionAttribute) as! AXValue, .cgPoint, &point),
              AXValueGetValue(attribute(button, kAXSizeAttribute) as! AXValue, .cgSize, &size) else { fail("Invalid button bounds") }
        let enabled = attribute(button, kAXEnabledAttribute) as! Bool
        let actions = actionNames(button)
        buttons[name] = ["x": point.x, "y": point.y, "width": size.width, "height": size.height,
                         "enabled": enabled, "pressable": actions.contains(kAXPressAction), "actions": actions]
    }
    emit(buttons)
} else {
    guard let key = names[action == "restore" ? "maximize" : action] else { fail("Unknown action") }
    let button = attribute(window, key) as! AXUIElement
    let method = CommandLine.arguments.count == 4 ? CommandLine.arguments[3] : "AXPress"
    guard ["AXPress", "AXZoomWindow", "Option+AXPress"].contains(method) else { fail("Unknown AX method") }
    guard action == "maximize" || action == "restore" || method == "AXPress" else { fail("Modifier/zoom is only allowed on the green button") }
    let nativeAction = method == "AXZoomWindow" ? "AXZoomWindow" : kAXPressAction
    // Retain the actual system error even when an action is not advertised.
    let result = method == "Option+AXPress" ? pressWithOption(button) : AXUIElementPerformAction(button, nativeAction as CFString)
    emit(["ok": result == .success, "kind": result == .success ? "ax-action" : "ax-action-error",
          "action": action, "method": method, "axError": result.rawValue])
}
