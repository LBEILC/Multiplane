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
    guard AXUIElementCopyActionNames(element, &actions) == .success else { fail("Cannot read button actions") }
    return actions as? [String] ?? []
}
guard CommandLine.arguments.count == 3, let pid = Int32(CommandLine.arguments[1]) else { fail("Expected pid and inspect|minimize|maximize|restore|close") }
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
    let data = try JSONSerialization.data(withJSONObject: buttons, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
} else {
    guard let key = names[action == "restore" ? "maximize" : action] else { fail("Unknown action") }
    let button = attribute(window, key) as! AXUIElement
    // The green button's default press may enter full screen. Use its exposed Zoom action
    // (the Option-click behavior) to test maximize/restore without changing app settings.
    let nativeAction = action == "maximize" || action == "restore" ? "AXZoomWindow" : kAXPressAction
    guard actionNames(button).contains(nativeAction) else { fail("Button does not expose \(nativeAction)") }
    guard AXUIElementPerformAction(button, nativeAction as CFString) == .success else { fail("\(nativeAction) failed for \(action)") }
}
