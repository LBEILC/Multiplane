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
// Optional attributes retain diagnostics while a transitional AX window disappears.
func optionalAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func describe(_ window: AXUIElement, _ index: Int, _ pid: Int32) -> [String: Any] {
    var point = CGPoint.zero
    var position: Any = NSNull()
    if let value = optionalAttribute(window, kAXPositionAttribute), CFGetTypeID(value) == AXValueGetTypeID(),
       AXValueGetValue(value as! AXValue, .cgPoint, &point) {
        position = ["x": point.x, "y": point.y]
    }
    return ["index": index, "pid": pid,
            "title": optionalAttribute(window, kAXTitleAttribute) as? String ?? "",
            "role": optionalAttribute(window, kAXRoleAttribute) as? String ?? "",
            "position": position]
}

guard (4...6).contains(CommandLine.arguments.count), let pid = Int32(CommandLine.arguments[1]) else {
    fail("Expected pid windows|inspect|minimize|maximize|restore|close title [AXPress|AXZoomWindow index]")
}
guard AXIsProcessTrusted() else { fail("Accessibility permission unavailable for the smoke runner") }
let application = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(application, 5)
let windows = attribute(application, kAXWindowsAttribute) as! [AXUIElement]
let candidates = windows.enumerated().map { describe($0.element, $0.offset, pid) }
let action = CommandLine.arguments[2]
let title = CommandLine.arguments[3]
if action == "windows" {
    emit(["candidates": candidates])
    exit(0)
}
let matches = candidates.filter { ($0["title"] as? String) == title && ($0["role"] as? String) == "AXWindow" }
guard CommandLine.arguments.count == 6, let index = Int(CommandLine.arguments[5]),
      windows.indices.contains(index), matches.count == 1, (matches[0]["index"] as? Int) == index else {
    emit(["kind": "window-selection-pending", "candidates": candidates])
    exit(0)
}
let window = windows[index]
let names = ["minimize": kAXMinimizeButtonAttribute, "maximize": kAXZoomButtonAttribute, "close": kAXCloseButtonAttribute]
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
    let method = CommandLine.arguments[4]
    guard ["AXPress", "AXZoomWindow"].contains(method) else { fail("Unknown AX method") }
    guard action == "maximize" || action == "restore" || method == "AXPress" else { fail("Zoom is only allowed on the green button") }
    let nativeAction = method == "AXZoomWindow" ? "AXZoomWindow" : kAXPressAction
    // Retain the actual system error even when an action is not advertised.
    let result = AXUIElementPerformAction(button, nativeAction as CFString)
    emit(["ok": result == .success, "kind": result == .success ? "ax-action" : "ax-action-error",
          "action": action, "method": method, "axError": result.rawValue])
}
