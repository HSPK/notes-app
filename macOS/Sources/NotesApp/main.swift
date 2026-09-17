import AppKit
import Foundation

private struct EditorAppearance: Codable {
    var theme: String
    var latinFont: String
    var cjkFont: String
}

private struct Settings: Codable {
    var directory: String
    var port: Int
    var autoStart: Bool
    var autoOpenBrowser: Bool
    var appearance: EditorAppearance

    enum CodingKeys: String, CodingKey {
        case directory = "Directory", port = "Port"
        case autoStart = "AutoStart", autoOpenBrowser = "AutoOpenBrowser"
        case appearance = "EditorAppearance"
    }
}

private struct CoreStatus: Decodable {
    let running: Bool
    let hasFolder: Bool
    let port: Int
}

private struct CoreReply: Decodable {
    let ok: Bool
    let error: String?
    let settings: Settings?
    let firstRun: Bool?
    let status: CoreStatus?
    let url: String?
}

private struct AppError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private final class NotesCore {
    private var handle: OpaquePointer?

    init() throws {
        precondition(Thread.isMainThread)
        guard notes_core_abi_version() == 1 else {
            throw AppError(message: "The Notes core is incompatible with this app.")
        }
        var error: UnsafeMutablePointer<CChar>?
        handle = notes_core_create(nil, &error)
        defer { if let error { notes_core_string_free(error) } }
        guard handle != nil else {
            throw AppError(message: error.map { String(cString: $0) }
                ?? "The Notes core could not be initialized.")
        }
    }

    func request(_ operation: String, settings: Settings? = nil) throws -> CoreReply {
        precondition(Thread.isMainThread)
        guard let handle else { throw AppError(message: "The Notes core is closed.") }
        struct Request: Encodable {
            let op: String
            let settings: Settings?
        }
        let data = try JSONEncoder().encode(Request(op: operation, settings: settings))
        let json = String(decoding: data, as: UTF8.self)
        guard let text = json.withCString({ notes_core_request(handle, $0) }) else {
            throw AppError(message: "The Notes core returned no response.")
        }
        defer { notes_core_string_free(text) }
        let response = try JSONDecoder().decode(
            CoreReply.self, from: Data(String(cString: text).utf8)
        )
        guard response.ok else {
            throw AppError(message: response.error ?? "The Notes core request failed.")
        }
        return response
    }

    func close() {
        precondition(Thread.isMainThread)
        guard let handle else { return }
        do {
            _ = try request("stop")
        } catch {
            NSLog("Notes core shutdown failed: %@", error.localizedDescription)
        }
        self.handle = nil
        notes_core_free(handle)
    }

    deinit { close() }
}

private func showError(_ message: String, window: NSWindow? = nil) {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Notes"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    NSApp.activate(ignoringOtherApps: true)
    if let window, window.isVisible {
        alert.beginSheetModal(for: window)
    } else {
        alert.runModal()
    }
}

private final class SettingsWindow: NSWindowController, NSWindowDelegate {
    private var saved: Settings
    private let onSave: (Settings) throws -> Settings
    private let directory = NSTextField()
    private let port = NSTextField()
    private let autoStart = NSButton(checkboxWithTitle: "Start service when Notes launches",
                                     target: nil, action: nil)
    private let autoOpen = NSButton(checkboxWithTitle: "Open browser after automatic startup",
                                    target: nil, action: nil)
    private let theme = NSPopUpButton(frame: .zero, pullsDown: false)
    private let latinFont = NSComboBox()
    private let cjkFont = NSComboBox()
    private let themes = ["system", "light", "dark"]

    init(saved: Settings, draft: Settings?, onSave: @escaping (Settings) throws -> Settings) {
        self.saved = saved
        self.onSave = onSave
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 440),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init(window: window)
        window.title = "Notes Settings"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        buildControls()
        load(draft ?? saved)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private func buildControls() {
        guard let content = window?.contentView else { return }
        let browse = NSButton(title: "Browse…", target: self, action: #selector(browseFolder))
        directory.placeholderString = "Choose a folder containing Markdown notes"
        directory.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let folderRow = NSStackView(views: [directory, browse])
        folderRow.orientation = .horizontal
        folderRow.spacing = 8
        theme.addItems(withTitles: ["System", "Light", "Dark"])
        let families = NSFontManager.shared.availableFontFamilies.sorted {
            $0.localizedStandardCompare($1) == .orderedAscending
        }
        for combo in [latinFont, cjkFont] {
            combo.isEditable = true
            combo.completes = true
            combo.addItems(withObjectValues: families)
            combo.numberOfVisibleItems = 12
        }
        port.widthAnchor.constraint(equalToConstant: 100).isActive = true
        port.alignment = .left
        let rows: [(String, NSView)] = [
            ("Notes folder", folderRow), ("Port", port), ("Browser theme", theme),
            ("English font", latinFont), ("Chinese font", cjkFont),
        ]
        let grid = NSGridView(views: rows.map { title, control in
            let label = NSTextField(labelWithString: title)
            label.textColor = .labelColor
            label.font = .systemFont(ofSize: NSFont.systemFontSize)
            return [label, control]
        })
        grid.rowSpacing = 12
        grid.columnSpacing = 16
        grid.column(at: 0).xPlacement = .trailing
        grid.column(at: 1).xPlacement = .fill
        grid.cell(atColumnIndex: 1, rowIndex: 1).xPlacement = .leading
        grid.cell(atColumnIndex: 1, rowIndex: 2).xPlacement = .leading
        let hint = NSTextField(wrappingLabelWithString:
            "Stop the service from the menu before changing the folder or port. " +
            "Browser appearance changes apply without restarting. " +
            "Open Notes starts the service when needed.")
        hint.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        hint.textColor = .secondaryLabelColor
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelChanges))
        cancel.keyEquivalent = "\u{1b}"
        let save = NSButton(title: "Save", target: self, action: #selector(saveChanges))
        save.keyEquivalent = "\r"
        let buttons = NSStackView(views: [NSView(), cancel, save])
        buttons.orientation = .horizontal
        buttons.spacing = 8
        let stack = NSStackView(views: [grid, autoStart, autoOpen, hint, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
            grid.widthAnchor.constraint(equalTo: stack.widthAnchor),
            hint.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    private func load(_ settings: Settings) {
        directory.stringValue = settings.directory
        port.stringValue = String(settings.port)
        autoStart.state = settings.autoStart ? .on : .off
        autoOpen.state = settings.autoOpenBrowser ? .on : .off
        theme.selectItem(at: themes.firstIndex(of: settings.appearance.theme) ?? 0)
        latinFont.stringValue = settings.appearance.latinFont
        cjkFont.stringValue = settings.appearance.cjkFont
    }

    @objc private func browseFolder() {
        guard let window else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        if !directory.stringValue.isEmpty {
            panel.directoryURL = URL(fileURLWithPath: directory.stringValue, isDirectory: true)
        }
        panel.beginSheetModal(for: window) { [weak self] response in
            if response == .OK, let url = panel.url {
                self?.directory.stringValue = url.path
            }
        }
    }

    @objc private func saveChanges() {
        guard let number = Int(port.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            showError("Enter a whole number for the port.", window: window)
            return
        }
        var draft = saved
        draft.directory = directory.stringValue
        draft.port = number
        draft.autoStart = autoStart.state == .on
        draft.autoOpenBrowser = autoOpen.state == .on
        draft.appearance = EditorAppearance(theme: themes[theme.indexOfSelectedItem],
                                            latinFont: latinFont.stringValue,
                                            cjkFont: cjkFont.stringValue)
        do {
            let persisted = try onSave(draft)
            saved = persisted
            load(persisted)
            window?.orderOut(nil)
        } catch {
            showError(error.localizedDescription, window: window)
        }
    }

    @objc private func cancelChanges() {
        load(saved)
        window?.orderOut(nil)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
    private var core: NotesCore?
    private var settings: Settings?
    private var settingsWindow: SettingsWindow?
    private var statusItem: NSStatusItem?
    private var timer: Timer?
    private var status: CoreStatus?
    private var lastStatusError: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let identifier = Bundle.main.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
            .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            existing.activate(options: [.activateIgnoringOtherApps])
            NSApp.terminate(nil)
            return
        }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem = item
        item.button?.image = NSImage(systemSymbolName: "note.text", accessibilityDescription: "Notes")
        item.button?.image?.isTemplate = true
        item.button?.target = self
        item.button?.action = #selector(statusClicked)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        do {
            let core = try NotesCore()
            self.core = core
            let reply = try core.request("get_settings")
            guard let loaded = reply.settings else {
                throw AppError(message: "The Notes core returned no settings.")
            }
            settings = loaded
            refreshStatus()
            timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                self?.refreshStatus()
            }
            if reply.firstRun == true, !migrateLegacySettings(from: loaded) { return }
            guard let settings else { return }
            if settings.directory.isEmpty {
                openSettings()
            } else if settings.autoStart {
                do {
                    _ = try core.request("start")
                    if settings.autoOpenBrowser { try launchBrowser() }
                    refreshStatus()
                } catch {
                    openSettings()
                    showError(error.localizedDescription, window: settingsWindow?.window)
                }
            }
        } catch {
            showError(error.localizedDescription)
            NSApp.terminate(nil)
        }
    }

    private func migrateLegacySettings(from original: Settings) -> Bool {
        guard let identifier = Bundle.main.bundleIdentifier,
              let legacy = UserDefaults.standard.persistentDomain(forName: identifier),
              ["notesDirectory", "notesPort", "autoStartServer", "autoOpenBrowser"]
                .contains(where: { legacy[$0] != nil }) else { return true }
        var draft = original
        draft.directory = legacy["notesDirectory"] as? String ?? ""
        draft.port = legacy["notesPort"] as? Int ?? 8123
        draft.autoStart = legacy["autoStartServer"] as? Bool ?? true
        draft.autoOpenBrowser = legacy["autoOpenBrowser"] as? Bool ?? false
        do {
            let malformed = (legacy["notesDirectory"] != nil && !(legacy["notesDirectory"] is String))
                || (legacy["notesPort"] != nil && !(legacy["notesPort"] is Int))
                || (legacy["autoStartServer"] != nil && !(legacy["autoStartServer"] is Bool))
                || (legacy["autoOpenBrowser"] != nil && !(legacy["autoOpenBrowser"] is Bool))
            guard !malformed else {
                throw AppError(message: "The previous preferences contain an invalid value.")
            }
            _ = try saveSettings(draft)
            return true
        } catch {
            showSettings(draft: draft)
            showError("Previous settings could not be imported. They have not been changed. " +
                      "Review the settings and save when ready.\n\n" + error.localizedDescription,
                      window: settingsWindow?.window)
            return false
        }
    }

    private func saveSettings(_ draft: Settings) throws -> Settings {
        guard let persisted = try core?.request("save_settings", settings: draft).settings else {
            throw AppError(message: "The Notes core returned no saved settings.")
        }
        settings = persisted
        refreshStatus()
        return persisted
    }

    private func refreshStatus() {
        do {
            guard let current = try core?.request("status").status else {
                throw AppError(message: "The Notes core returned no service status.")
            }
            status = current
            lastStatusError = nil
            statusItem?.button?.toolTip = current.running
                ? "Notes — Running on port \(current.port)" : "Notes — Stopped"
        } catch {
            status = nil
            statusItem?.button?.toolTip = "Notes — Service unavailable"
            let message = error.localizedDescription
            if message != lastStatusError {
                NSLog("Notes service status unavailable: %@", message)
                lastStatusError = message
            }
        }
    }

    @objc private func statusClicked() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            refreshStatus()
            let menu = NSMenu()
            func add(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
                let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
                item.target = self
                return item
            }
            menu.autoenablesItems = false
            _ = add("Open Notes", #selector(openNotes), key: "o")
            _ = add("Settings…", #selector(openSettings), key: ",")
            add("Open Folder", #selector(openFolder)).isEnabled = status?.hasFolder == true
            menu.addItem(.separator())
            _ = add(status?.running == true ? "Stop" : "Start", #selector(toggleService))
            menu.addItem(.separator())
            _ = add("Quit Notes", #selector(quit), key: "q")
            statusItem?.menu = menu
            statusItem?.button?.performClick(nil)
            statusItem?.menu = nil
        } else {
            openNotes()
        }
    }

    private func launchBrowser() throws {
        guard let address = try core?.request("open_url").url, let url = URL(string: address) else {
            throw AppError(message: "The Notes core returned no browser address.")
        }
        guard NSWorkspace.shared.open(url) else {
            throw AppError(message: "The default browser could not be opened.")
        }
    }

    @objc private func openNotes() {
        do { try launchBrowser() } catch {
            openSettings()
            showError(error.localizedDescription, window: settingsWindow?.window)
        }
        refreshStatus()
    }

    @objc private func toggleService() {
        do {
            guard let current = try core?.request("status").status else {
                throw AppError(message: "The Notes core returned no service status.")
            }
            _ = try core?.request(current.running ? "stop" : "start")
        } catch {
            openSettings()
            showError(error.localizedDescription, window: settingsWindow?.window)
        }
        refreshStatus()
    }

    @objc private func openFolder() {
        guard let path = settings?.directory, !path.isEmpty else { openSettings(); return }
        if !NSWorkspace.shared.open(URL(fileURLWithPath: path, isDirectory: true)) {
            showError("The notes folder could not be opened.")
        }
    }

    @objc private func openSettings() { showSettings() }

    private func showSettings(draft: Settings? = nil) {
        guard let settings else { return }
        if settingsWindow == nil {
            settingsWindow = SettingsWindow(saved: settings, draft: draft) { [weak self] draft in
                guard let self else { throw AppError(message: "Notes is shutting down.") }
                return try self.saveSettings(draft)
            }
        }
        settingsWindow?.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.window?.makeKeyAndOrderFront(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        timer = nil
        core?.close()
        core = nil
    }

    @objc private func quit() { NSApp.terminate(nil) }
}

private let app = NSApplication.shared
private let delegate = AppDelegate()
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
