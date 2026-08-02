import AppKit
import Foundation
import Network
import SwiftUI

private enum PreferenceKey {
    static let directory = "notesDirectory"
    static let port = "notesPort"
    static let autoStart = "autoStartServer"
    static let autoOpenBrowser = "autoOpenBrowser"
    static let browser = "preferredBrowser"
    static let editor = "preferredEditor"
    static let liveReload = "liveReload"
    static let dirtyReload = "dirtyReload"
    static let strictMode = "strictMode"
    static let startupTimeout = "startupTimeout"
    static let appearance = "appearance"
    static let ansiColors = "ansiColors"
    static let logFontSize = "logFontSize"
}

private enum BrowserChoice: String, CaseIterable {
    case system
    case safari
    case chrome
    case edge
    case firefox

    var title: String {
        switch self {
        case .system: return "系统默认"
        case .safari: return "Safari"
        case .chrome: return "Google Chrome"
        case .edge: return "Microsoft Edge"
        case .firefox: return "Firefox"
        }
    }

    var bundleIdentifier: String? {
        switch self {
        case .system: return nil
        case .safari: return "com.apple.Safari"
        case .chrome: return "com.google.Chrome"
        case .edge: return "com.microsoft.edgemac"
        case .firefox: return "org.mozilla.firefox"
        }
    }
}

private enum EditorChoice: String, CaseIterable {
    case system
    case vscode
    case cursor
    case zed
    case obsidian

    var title: String {
        switch self {
        case .system: return "系统默认"
        case .vscode: return "Visual Studio Code"
        case .cursor: return "Cursor"
        case .zed: return "Zed"
        case .obsidian: return "Obsidian"
        }
    }

    var bundleIdentifiers: [String] {
        switch self {
        case .system: return []
        case .vscode: return ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders"]
        case .cursor: return ["com.todesktop.230313mzl4w4u92"]
        case .zed: return ["dev.zed.Zed"]
        case .obsidian: return ["md.obsidian"]
        }
    }
}

private enum AppearanceChoice: String, CaseIterable {
    case system
    case light
    case dark

    var title: String {
        switch self {
        case .system: return "跟随系统"
        case .light: return "浅色"
        case .dark: return "深色"
        }
    }
}

private enum ProjectInspector {
    static func configURL(for directory: String) -> URL? {
        guard !directory.isEmpty else { return nil }
        let root = URL(fileURLWithPath: directory, isDirectory: true)
        let candidates = [
            "mkdocs.yml",
            "mkdocs.yaml",
            "mkdocs/mkdocs.yml",
            "mkdocs/mkdocs.yaml",
        ]
        return candidates
            .map { root.appendingPathComponent($0) }
            .first { FileManager.default.fileExists(atPath: $0.path) }
    }

    static func themeName(for directory: String) -> String {
        guard let configURL = configURL(for: directory),
              let contents = try? String(contentsOf: configURL, encoding: .utf8) else {
            return "未识别"
        }

        let lines = contents.split(separator: "\n", omittingEmptySubsequences: false)
        var themeIndent: Int?
        for rawLine in lines {
            let line = String(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("#") else { continue }
            let indent = line.prefix { $0 == " " || $0 == "\t" }.count

            if themeIndent == nil {
                guard trimmed.hasPrefix("theme:") else { continue }
                let inlineValue = trimmed.dropFirst("theme:".count)
                    .trimmingCharacters(in: .whitespaces)
                if !inlineValue.isEmpty {
                    return inlineValue.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                }
                themeIndent = indent
                continue
            }

            if let themeIndent, indent <= themeIndent {
                break
            }
            if trimmed.hasPrefix("name:") {
                return trimmed.dropFirst("name:".count)
                    .trimmingCharacters(in: .whitespaces)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            }
        }
        return "默认"
    }
}

private final class SettingsStore {
    private let defaults = UserDefaults.standard

    init() {
        defaults.register(defaults: [
            PreferenceKey.port: 8123,
            PreferenceKey.autoStart: true,
            PreferenceKey.autoOpenBrowser: false,
            PreferenceKey.browser: BrowserChoice.system.rawValue,
            PreferenceKey.editor: EditorChoice.vscode.rawValue,
            PreferenceKey.liveReload: true,
            PreferenceKey.dirtyReload: false,
            PreferenceKey.strictMode: false,
            PreferenceKey.startupTimeout: 15,
            PreferenceKey.appearance: AppearanceChoice.system.rawValue,
            PreferenceKey.ansiColors: true,
            PreferenceKey.logFontSize: 12.0,
        ])
    }

    var directory: String {
        get {
            if let value = defaults.string(forKey: PreferenceKey.directory), !value.isEmpty {
                return value
            }
            return ""
        }
        set {
            defaults.set(newValue, forKey: PreferenceKey.directory)
        }
    }

    var port: Int {
        get {
            let value = defaults.integer(forKey: PreferenceKey.port)
            return (1...65_535).contains(value) ? value : 8123
        }
        set {
            defaults.set(newValue, forKey: PreferenceKey.port)
        }
    }

    var autoStart: Bool {
        get { defaults.bool(forKey: PreferenceKey.autoStart) }
        set { defaults.set(newValue, forKey: PreferenceKey.autoStart) }
    }

    var autoOpenBrowser: Bool {
        get { defaults.bool(forKey: PreferenceKey.autoOpenBrowser) }
        set { defaults.set(newValue, forKey: PreferenceKey.autoOpenBrowser) }
    }

    var browser: BrowserChoice {
        get {
            BrowserChoice(rawValue: defaults.string(forKey: PreferenceKey.browser) ?? "")
                ?? .system
        }
        set { defaults.set(newValue.rawValue, forKey: PreferenceKey.browser) }
    }

    var editor: EditorChoice {
        get {
            EditorChoice(rawValue: defaults.string(forKey: PreferenceKey.editor) ?? "")
                ?? .vscode
        }
        set { defaults.set(newValue.rawValue, forKey: PreferenceKey.editor) }
    }

    var liveReload: Bool {
        get { defaults.bool(forKey: PreferenceKey.liveReload) }
        set { defaults.set(newValue, forKey: PreferenceKey.liveReload) }
    }

    var dirtyReload: Bool {
        get { defaults.bool(forKey: PreferenceKey.dirtyReload) }
        set { defaults.set(newValue, forKey: PreferenceKey.dirtyReload) }
    }

    var strictMode: Bool {
        get { defaults.bool(forKey: PreferenceKey.strictMode) }
        set { defaults.set(newValue, forKey: PreferenceKey.strictMode) }
    }

    var startupTimeout: Int {
        get {
            let value = defaults.integer(forKey: PreferenceKey.startupTimeout)
            return (5...60).contains(value) ? value : 15
        }
        set { defaults.set(newValue, forKey: PreferenceKey.startupTimeout) }
    }

    var appearance: AppearanceChoice {
        get {
            AppearanceChoice(rawValue: defaults.string(forKey: PreferenceKey.appearance) ?? "")
                ?? .system
        }
        set { defaults.set(newValue.rawValue, forKey: PreferenceKey.appearance) }
    }

    var ansiColors: Bool {
        get { defaults.bool(forKey: PreferenceKey.ansiColors) }
        set { defaults.set(newValue, forKey: PreferenceKey.ansiColors) }
    }

    var logFontSize: Double {
        get {
            let value = defaults.double(forKey: PreferenceKey.logFontSize)
            return (10...20).contains(value) ? value : 12
        }
        set { defaults.set(newValue, forKey: PreferenceKey.logFontSize) }
    }
}

private enum ServerState {
    case stopped
    case starting
    case running(managed: Bool)
    case failed(String)

    var title: String {
        switch self {
        case .stopped:
            return "已停止"
        case .starting:
            return "启动中…"
        case .running(let managed):
            return managed ? "运行中" : "运行中（外部）"
        case .failed:
            return "启动失败"
        }
    }

    var symbolName: String {
        switch self {
        case .stopped:
            return "book.closed"
        case .starting:
            return "ellipsis.circle"
        case .running:
            return "book.fill"
        case .failed:
            return "exclamationmark.triangle.fill"
        }
    }
}

private final class ServerManager {
    let settings: SettingsStore
    var onChange: (() -> Void)?
    var onLogCleared: (() -> Void)?

    private(set) var state: ServerState = .stopped {
        didSet {
            DispatchQueue.main.async { [weak self] in
                self?.onChange?()
            }
        }
    }

    private var process: Process?
    private var logHandle: FileHandle?
    private var startupTimer: Timer?
    private var healthTimer: Timer?
    private var startupDeadline: Date?
    private var isCheckingPort = false
    private var pendingRestart = false
    private var readyCallbacks: [(Bool) -> Void] = []

    init(settings: SettingsStore) {
        self.settings = settings
        healthTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.refreshHealth()
        }
    }

    deinit {
        healthTimer?.invalidate()
        startupTimer?.invalidate()
    }

    var webURL: URL? {
        URL(string: "http://127.0.0.1:\(settings.port)")
    }

    var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/NotesApp/mkdocs.log")
    }

    var isManagedRunning: Bool {
        process?.isRunning == true
    }

    func start() {
        switch state {
        case .starting, .running:
            return
        case .stopped, .failed:
            break
        }

        guard validateConfiguration() else {
            flushReadyCallbacks(success: false)
            return
        }

        state = .starting
        checkPort { [weak self] isReachable in
            guard let self else { return }
            if isReachable {
                self.state = .running(managed: false)
                self.flushReadyCallbacks(success: true)
            } else {
                self.launchMkDocs()
            }
        }
    }

    func ensureRunning(completion: @escaping (Bool) -> Void) {
        if case .running = state {
            completion(true)
            return
        }
        readyCallbacks.append(completion)
        start()
    }

    func stop() {
        pendingRestart = false
        stopManagedProcess()
    }

    func restart() {
        if let process, process.isRunning {
            pendingRestart = true
            startupTimer?.invalidate()
            process.terminate()
        } else {
            state = .stopped
            start()
        }
    }

    func applyUpdatedConfiguration() {
        if isManagedRunning {
            restart()
        } else {
            state = .stopped
            if settings.autoStart {
                start()
            }
        }
    }

    func shutdown() {
        pendingRestart = false
        startupTimer?.invalidate()
        healthTimer?.invalidate()
        if let process, process.isRunning {
            process.terminate()
        }
    }

    func clearLog() throws {
        let logDirectory = logURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: logDirectory,
            withIntermediateDirectories: true
        )

        if let logHandle {
            try logHandle.truncate(atOffset: 0)
            try logHandle.seek(toOffset: 0)
        } else {
            try Data().write(to: logURL, options: .atomic)
        }
        onLogCleared?()
    }

    private func validateConfiguration() -> Bool {
        let directoryURL = URL(fileURLWithPath: settings.directory, isDirectory: true)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: directoryURL.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            state = .failed("笔记目录不存在")
            return false
        }

        guard ProjectInspector.configURL(for: settings.directory) != nil else {
            state = .failed("没有找到 MkDocs 配置")
            return false
        }

        let executableURL = directoryURL.appendingPathComponent(".venv/bin/mkdocs")
        guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
            state = .failed("没有找到 .venv/bin/mkdocs，请先运行 make setup")
            return false
        }

        guard (1...65_535).contains(settings.port) else {
            state = .failed("端口必须介于 1 和 65535")
            return false
        }
        return true
    }

    private func launchMkDocs() {
        let directoryURL = URL(fileURLWithPath: settings.directory, isDirectory: true)
        let executableURL = directoryURL.appendingPathComponent(".venv/bin/mkdocs")
        guard let configURL = ProjectInspector.configURL(for: settings.directory) else {
            state = .failed("没有找到 MkDocs 配置")
            flushReadyCallbacks(success: false)
            return
        }

        do {
            let logDirectory = logURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: logDirectory,
                withIntermediateDirectories: true
            )
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil)
            }
            let logHandle = try FileHandle(forWritingTo: logURL)
            try logHandle.seekToEnd()
            self.logHandle = logHandle
            let timestamp = ISO8601DateFormatter().string(from: Date())
            let sessionHeader = "\n=== \(timestamp) · 127.0.0.1:\(settings.port) ===\n"
            try logHandle.write(contentsOf: Data(sessionHeader.utf8))

            let process = Process()
            process.executableURL = executableURL
            var arguments = [
                "serve",
                "-f", configURL.path,
                "--dev-addr", "127.0.0.1:\(settings.port)",
            ]
            if !settings.liveReload {
                arguments.append("--no-livereload")
            }
            if settings.dirtyReload {
                arguments.append("--dirty")
            }
            if settings.strictMode {
                arguments.append("--strict")
            }
            process.arguments = arguments
            process.currentDirectoryURL = directoryURL
            process.standardOutput = logHandle
            process.standardError = logHandle
            process.terminationHandler = { [weak self, weak process] _ in
                try? logHandle.close()
                DispatchQueue.main.async {
                    guard let self, self.process === process else { return }
                    self.process = nil
                    if self.logHandle === logHandle {
                        self.logHandle = nil
                    }
                    self.startupTimer?.invalidate()
                    if self.pendingRestart {
                        self.pendingRestart = false
                        self.state = .stopped
                        self.start()
                    } else if case .stopped = self.state {
                        // The user explicitly stopped the service.
                    } else if case .failed = self.state {
                        // Keep the more specific failure already shown to the user.
                    } else {
                        self.state = .failed("MkDocs 已退出，请查看日志")
                        self.flushReadyCallbacks(success: false)
                    }
                }
            }

            try process.run()
            self.process = process
            state = .starting
            startupDeadline = Date().addingTimeInterval(TimeInterval(settings.startupTimeout))
            startupTimer?.invalidate()
            startupTimer = Timer.scheduledTimer(
                withTimeInterval: 0.35,
                repeats: true
            ) { [weak self] _ in
                self?.pollStartup()
            }
        } catch {
            state = .failed(error.localizedDescription)
            flushReadyCallbacks(success: false)
        }
    }

    private func pollStartup() {
        guard let process, process.isRunning else { return }
        if let startupDeadline, Date() > startupDeadline {
            startupTimer?.invalidate()
            state = .failed("等待服务启动超时，请查看日志")
            process.terminate()
            flushReadyCallbacks(success: false)
            return
        }

        checkPort { [weak self] isReachable in
            guard let self, isReachable else { return }
            self.startupTimer?.invalidate()
            self.state = .running(managed: true)
            self.flushReadyCallbacks(success: true)
        }
    }

    private func stopManagedProcess() {
        startupTimer?.invalidate()
        if let process, process.isRunning {
            state = .stopped
            process.terminate()
        } else {
            process = nil
            state = .stopped
        }
        flushReadyCallbacks(success: false)
    }

    private func refreshHealth() {
        guard !isCheckingPort else { return }
        switch state {
        case .running(let managed):
            checkPort { [weak self] isReachable in
                guard let self else { return }
                if !isReachable {
                    if !managed || self.process?.isRunning != true {
                        self.state = .stopped
                    }
                }
            }
        case .stopped:
            checkPort { [weak self] isReachable in
                if isReachable {
                    self?.state = .running(managed: false)
                }
            }
        case .starting, .failed:
            break
        }
    }

    private func checkPort(completion: @escaping (Bool) -> Void) {
        guard !isCheckingPort,
              let port = NWEndpoint.Port(rawValue: UInt16(settings.port)) else {
            completion(false)
            return
        }

        isCheckingPort = true

        let connection = NWConnection(
            host: NWEndpoint.Host("127.0.0.1"),
            port: port,
            using: .tcp
        )
        var didFinish = false
        let finish: (Bool) -> Void = { [weak self] isReachable in
            guard !didFinish else { return }
            didFinish = true
            connection.cancel()
            self?.isCheckingPort = false
            completion(isReachable)
        }

        connection.stateUpdateHandler = { state in
            DispatchQueue.main.async {
                switch state {
                case .ready:
                    finish(true)
                case .failed, .cancelled:
                    finish(false)
                default:
                    break
                }
            }
        }
        connection.start(queue: DispatchQueue.global(qos: .utility))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            finish(false)
        }
    }

    private func flushReadyCallbacks(success: Bool) {
        let callbacks = readyCallbacks
        readyCallbacks.removeAll()
        callbacks.forEach { $0(success) }
    }
}

private enum ANSITextRenderer {
    private static let expression = try! NSRegularExpression(
        pattern: "\u{001B}\\[([0-9;]*)m"
    )

    static func render(_ text: String, colors: Bool, fontSize: Double) -> NSAttributedString {
        let source = text as NSString
        let result = NSMutableAttributedString()
        let matches = expression.matches(
            in: text,
            range: NSRange(location: 0, length: source.length)
        )

        var cursor = 0
        var foreground = NSColor.labelColor
        var isBold = false

        func attributes() -> [NSAttributedString.Key: Any] {
            let baseFont = NSFont.monospacedSystemFont(
                ofSize: fontSize,
                weight: isBold ? .semibold : .regular
            )
            return [
                .font: baseFont,
                .foregroundColor: colors ? foreground : NSColor.labelColor,
            ]
        }

        for match in matches {
            if match.range.location > cursor {
                let range = NSRange(
                    location: cursor,
                    length: match.range.location - cursor
                )
                result.append(NSAttributedString(
                    string: source.substring(with: range),
                    attributes: attributes()
                ))
            }

            let codesText = match.range(at: 1).length > 0
                ? source.substring(with: match.range(at: 1))
                : "0"
            let codes = codesText.split(separator: ";").compactMap { Int($0) }
            for code in codes {
                switch code {
                case 0:
                    foreground = .labelColor
                    isBold = false
                case 1:
                    isBold = true
                case 22:
                    isBold = false
                case 30: foreground = .black
                case 31, 91: foreground = .systemRed
                case 32, 92: foreground = .systemGreen
                case 33, 93: foreground = .systemYellow
                case 34, 94: foreground = .systemBlue
                case 35, 95: foreground = .systemPurple
                case 36, 96: foreground = .systemCyan
                case 37, 97: foreground = .labelColor
                case 39: foreground = .labelColor
                default: break
                }
            }
            cursor = NSMaxRange(match.range)
        }

        if cursor < source.length {
            result.append(NSAttributedString(
                string: source.substring(from: cursor),
                attributes: attributes()
            ))
        }
        return result
    }
}

private final class LogWindowController: NSWindowController, NSWindowDelegate {
    private let server: ServerManager
    private let settings: SettingsStore
    private let textView = NSTextView()
    private let statusLabel = NSTextField(labelWithString: "")
    private let autoScrollCheckbox = NSButton(
        checkboxWithTitle: "自动滚动",
        target: nil,
        action: nil
    )
    private var refreshTimer: Timer?
    private var lastModificationDate: Date?
    private var lastFileSize: UInt64 = .max

    init(server: ServerManager, settings: SettingsStore) {
        self.server = server
        self.settings = settings

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 880, height: 580),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Notes 日志"
        window.center()
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("NotesLogWindow")
        super.init(window: window)
        window.delegate = self
        buildInterface()
        server.onLogCleared = { [weak self] in
            self?.lastFileSize = .max
            self?.reload(force: true)
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func showWindow(_ sender: Any?) {
        reload(force: true)
        super.showWindow(sender)
        startRefreshing()
    }

    func windowWillClose(_ notification: Notification) {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    func reloadPreferences() {
        reload(force: true)
    }

    private func buildInterface() {
        guard let contentView = window?.contentView else { return }

        textView.frame = NSRect(x: 0, y: 0, width: 840, height: 500)
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = true
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.textContainer?.containerSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.textContainer?.widthTracksTextView = false
        textView.drawsBackground = true
        textView.backgroundColor = .textBackgroundColor
        textView.textContainerInset = NSSize(width: 10, height: 10)
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false

        let scrollView = NSScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.borderType = .bezelBorder
        scrollView.documentView = textView

        let reloadButton = NSButton(
            title: "重新载入",
            target: self,
            action: #selector(reloadButtonPressed)
        )
        let clearButton = NSButton(
            title: "清空",
            target: self,
            action: #selector(clearButtonPressed)
        )
        autoScrollCheckbox.state = .on
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.alignment = .right

        let toolbar = NSStackView(
            views: [reloadButton, clearButton, autoScrollCheckbox, NSView(), statusLabel]
        )
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        toolbar.orientation = .horizontal
        toolbar.alignment = .centerY
        toolbar.spacing = 10

        contentView.addSubview(toolbar)
        contentView.addSubview(scrollView)
        NSLayoutConstraint.activate([
            toolbar.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 14),
            toolbar.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -14),
            toolbar.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 12),
            scrollView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 12),
            scrollView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -12),
            scrollView.topAnchor.constraint(equalTo: toolbar.bottomAnchor, constant: 10),
            scrollView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -12),
        ])
    }

    private func startRefreshing() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(
            withTimeInterval: 0.75,
            repeats: true
        ) { [weak self] _ in
            self?.reload()
        }
    }

    @objc private func reloadButtonPressed() {
        reload(force: true)
    }

    @objc private func clearButtonPressed() {
        do {
            try server.clearLog()
            reload(force: true)
        } catch {
            let alert = NSAlert()
            alert.messageText = "无法清空日志"
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .warning
            if let window {
                alert.beginSheetModal(for: window)
            }
        }
    }

    private func reload(force: Bool = false) {
        let url = server.logURL
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else {
            textView.string = ""
            statusLabel.stringValue = "暂无日志"
            return
        }

        let fileSize = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
        let modificationDate = attributes[.modificationDate] as? Date
        if !force, fileSize == lastFileSize, modificationDate == lastModificationDate {
            return
        }
        lastFileSize = fileSize
        lastModificationDate = modificationDate

        let maximumBytes = 4 * 1024 * 1024
        guard let handle = try? FileHandle(forReadingFrom: url) else { return }
        defer { try? handle.close() }
        if fileSize > maximumBytes {
            try? handle.seek(toOffset: fileSize - UInt64(maximumBytes))
        }
        let data = (try? handle.readToEnd()) ?? Data()
        var text = String(decoding: data, as: UTF8.self)
        if fileSize > maximumBytes {
            text = "…仅显示最后 4 MB…\n" + text
        }

        let rendered = ANSITextRenderer.render(
            text,
            colors: settings.ansiColors,
            fontSize: settings.logFontSize
        )
        textView.textStorage?.setAttributedString(rendered)
        statusLabel.stringValue = ByteCountFormatter.string(
            fromByteCount: Int64(fileSize),
            countStyle: .file
        )
        if autoScrollCheckbox.state == .on {
            textView.scrollToEndOfDocument(nil)
        }
    }
}

private final class BuildChecker {
    private var process: Process?

    var isRunning: Bool {
        process?.isRunning == true
    }

    var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/NotesApp/build-check.log")
    }

    func run(
        settings: SettingsStore,
        completion: @escaping (Int32, String, URL) -> Void
    ) {
        guard !isRunning else { return }
        let directoryURL = URL(fileURLWithPath: settings.directory, isDirectory: true)
        let executableURL = directoryURL.appendingPathComponent(".venv/bin/mkdocs")
        guard FileManager.default.isExecutableFile(atPath: executableURL.path),
              let configURL = ProjectInspector.configURL(for: settings.directory) else {
            completion(1, "没有找到 MkDocs 可执行文件或配置。", logURL)
            return
        }

        let arguments = ["build", "-f", configURL.path, "--strict"]
        let pipe = Pipe()
        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        process.currentDirectoryURL = directoryURL
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            self.process = process
        } catch {
            completion(1, error.localizedDescription, logURL)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let command = "$ mkdocs \(arguments.joined(separator: " "))\n\n"
            let output = command + String(decoding: data, as: UTF8.self)
            let logURL = self?.logURL ?? FileManager.default.temporaryDirectory
                .appendingPathComponent("build-check.log")
            try? FileManager.default.createDirectory(
                at: logURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try? Data(output.utf8).write(to: logURL, options: .atomic)

            DispatchQueue.main.async {
                self?.process = nil
                completion(process.terminationStatus, output, logURL)
            }
        }
    }
}

private final class BuildResultWindowController: NSWindowController {
    private let settings: SettingsStore
    private let statusImage = NSImageView()
    private let statusLabel = NSTextField(labelWithString: "")
    private let textView = NSTextView()
    private var logURL: URL?

    init(settings: SettingsStore) {
        self.settings = settings
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 820, height: 540),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "文档检查"
        window.center()
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("NotesBuildResultWindow")
        super.init(window: window)
        buildInterface()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show(status: Int32, output: String, logURL: URL) {
        self.logURL = logURL
        let succeeded = status == 0
        statusLabel.stringValue = succeeded ? "检查通过" : "检查失败（退出码 \(status)）"
        statusLabel.textColor = succeeded ? .systemGreen : .systemRed
        statusImage.image = NSImage(
            systemSymbolName: succeeded ? "checkmark.circle.fill" : "xmark.circle.fill",
            accessibilityDescription: statusLabel.stringValue
        )
        statusImage.contentTintColor = succeeded ? .systemGreen : .systemRed
        textView.textStorage?.setAttributedString(
            ANSITextRenderer.render(
                output,
                colors: settings.ansiColors,
                fontSize: settings.logFontSize
            )
        )
        textView.scrollToBeginningOfDocument(nil)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildInterface() {
        guard let contentView = window?.contentView else { return }
        statusImage.imageScaling = .scaleProportionallyDown
        statusImage.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = .systemFont(ofSize: 15, weight: .semibold)

        let header = NSStackView(views: [statusImage, statusLabel, NSView()])
        header.translatesAutoresizingMaskIntoConstraints = false
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 8

        textView.frame = NSRect(x: 0, y: 0, width: 780, height: 430)
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = true
        textView.textContainer?.containerSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.textContainer?.widthTracksTextView = false
        textView.textContainerInset = NSSize(width: 10, height: 10)

        let scrollView = NSScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.borderType = .bezelBorder
        scrollView.documentView = textView

        let openLogButton = NSButton(
            title: "在 Finder 中显示日志",
            target: self,
            action: #selector(revealLog)
        )
        let closeButton = NSButton(
            title: "关闭",
            target: self,
            action: #selector(closeWindow)
        )
        closeButton.keyEquivalent = "\r"
        let footer = NSStackView(views: [openLogButton, NSView(), closeButton])
        footer.translatesAutoresizingMaskIntoConstraints = false
        footer.orientation = .horizontal
        footer.alignment = .centerY

        contentView.addSubview(header)
        contentView.addSubview(scrollView)
        contentView.addSubview(footer)
        NSLayoutConstraint.activate([
            statusImage.widthAnchor.constraint(equalToConstant: 22),
            statusImage.heightAnchor.constraint(equalToConstant: 22),
            header.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
            header.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
            header.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 14),
            scrollView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 14),
            scrollView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -14),
            scrollView.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 12),
            scrollView.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -12),
            footer.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
            footer.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
            footer.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -14),
        ])
    }

    @objc private func revealLog() {
        if let logURL {
            NSWorkspace.shared.activateFileViewerSelecting([logURL])
        }
    }

    @objc private func closeWindow() {
        close()
    }
}

private final class LegacySettingsWindowController: NSWindowController {
    private let settings: SettingsStore
    private let onSave: (Bool) -> Void

    private let tabs = NSSegmentedControl(
        labels: ["常规", "服务", "外观"],
        trackingMode: .selectOne,
        target: nil,
        action: nil
    )
    private let directoryField = NSTextField()
    private let browserPopup = NSPopUpButton()
    private let autoStartCheckbox = NSButton(
        checkboxWithTitle: "自动启动服务",
        target: nil,
        action: nil
    )
    private let autoOpenBrowserCheckbox = NSButton(
        checkboxWithTitle: "服务启动后打开网页",
        target: nil,
        action: nil
    )
    private let portField = NSTextField()
    private let timeoutField = NSTextField()
    private let timeoutStepper = NSStepper()
    private let liveReloadCheckbox = NSButton(
        checkboxWithTitle: "实时刷新",
        target: nil,
        action: nil
    )
    private let dirtyReloadCheckbox = NSButton(
        checkboxWithTitle: "仅重建改动文件",
        target: nil,
        action: nil
    )
    private let strictModeCheckbox = NSButton(
        checkboxWithTitle: "将警告视为错误",
        target: nil,
        action: nil
    )
    private let appearancePopup = NSPopUpButton()
    private let ansiColorsCheckbox = NSButton(
        checkboxWithTitle: "显示 ANSI 日志颜色",
        target: nil,
        action: nil
    )
    private let logFontSizePopup = NSPopUpButton()
    private var pages: [NSView] = []

    init(settings: SettingsStore, onSave: @escaping (Bool) -> Void) {
        self.settings = settings
        self.onSave = onSave

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 680, height: 430),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Notes 设置"
        window.center()
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("NotesSettingsWindow")
        super.init(window: window)
        buildInterface()
        reload()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func reload() {
        directoryField.stringValue = settings.directory
        portField.integerValue = settings.port
        timeoutField.integerValue = settings.startupTimeout
        timeoutStepper.integerValue = settings.startupTimeout
        autoStartCheckbox.state = settings.autoStart ? .on : .off
        autoOpenBrowserCheckbox.state = settings.autoOpenBrowser ? .on : .off
        liveReloadCheckbox.state = settings.liveReload ? .on : .off
        dirtyReloadCheckbox.state = settings.dirtyReload ? .on : .off
        strictModeCheckbox.state = settings.strictMode ? .on : .off
        ansiColorsCheckbox.state = settings.ansiColors ? .on : .off

        browserPopup.selectItem(at: BrowserChoice.allCases.firstIndex(of: settings.browser) ?? 0)
        appearancePopup.selectItem(
            at: AppearanceChoice.allCases.firstIndex(of: settings.appearance) ?? 0
        )
        let fontSize = Int(settings.logFontSize)
        logFontSizePopup.selectItem(withTag: fontSize)
    }

    private func buildInterface() {
        guard let contentView = window?.contentView else { return }

        configureNumericFields()
        browserPopup.addItems(withTitles: BrowserChoice.allCases.map(\.title))
        appearancePopup.addItems(withTitles: AppearanceChoice.allCases.map(\.title))
        for size in [10, 11, 12, 13, 14, 16, 18, 20] {
            logFontSizePopup.addItem(withTitle: "\(size) pt")
            logFontSizePopup.lastItem?.tag = size
        }

        tabs.selectedSegment = 0
        tabs.target = self
        tabs.action = #selector(changePage)
        tabs.translatesAutoresizingMaskIntoConstraints = false

        let pageContainer = NSView()
        pageContainer.translatesAutoresizingMaskIntoConstraints = false
        pages = [makeGeneralPage(), makeServerPage(), makeAppearancePage()]
        for page in pages {
            page.translatesAutoresizingMaskIntoConstraints = false
            pageContainer.addSubview(page)
            NSLayoutConstraint.activate([
                page.leadingAnchor.constraint(equalTo: pageContainer.leadingAnchor),
                page.trailingAnchor.constraint(equalTo: pageContainer.trailingAnchor),
                page.topAnchor.constraint(equalTo: pageContainer.topAnchor),
                page.bottomAnchor.constraint(lessThanOrEqualTo: pageContainer.bottomAnchor),
            ])
        }

        let cancelButton = NSButton(
            title: "取消",
            target: self,
            action: #selector(cancel)
        )
        let saveButton = NSButton(
            title: "保存",
            target: self,
            action: #selector(save)
        )
        saveButton.keyEquivalent = "\r"
        let buttonRow = NSStackView(views: [NSView(), cancelButton, saveButton])
        buttonRow.translatesAutoresizingMaskIntoConstraints = false
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8

        let separator = NSBox()
        separator.translatesAutoresizingMaskIntoConstraints = false
        separator.boxType = .separator

        contentView.addSubview(tabs)
        contentView.addSubview(pageContainer)
        contentView.addSubview(separator)
        contentView.addSubview(buttonRow)
        NSLayoutConstraint.activate([
            tabs.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
            tabs.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 18),
            tabs.widthAnchor.constraint(equalToConstant: 280),
            pageContainer.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 28),
            pageContainer.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -28),
            pageContainer.topAnchor.constraint(equalTo: tabs.bottomAnchor, constant: 24),
            pageContainer.bottomAnchor.constraint(equalTo: separator.topAnchor, constant: -14),
            separator.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            separator.bottomAnchor.constraint(equalTo: buttonRow.topAnchor, constant: -12),
            buttonRow.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 20),
            buttonRow.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -20),
            buttonRow.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -16),
        ])
        updateVisiblePage()
    }

    private func configureNumericFields() {
        let portFormatter = NumberFormatter()
        portFormatter.numberStyle = .none
        portFormatter.minimum = 1
        portFormatter.maximum = 65_535
        portFormatter.allowsFloats = false
        portField.formatter = portFormatter
        portField.alignment = .right
        portField.widthAnchor.constraint(equalToConstant: 100).isActive = true

        let timeoutFormatter = NumberFormatter()
        timeoutFormatter.numberStyle = .none
        timeoutFormatter.minimum = 5
        timeoutFormatter.maximum = 60
        timeoutFormatter.allowsFloats = false
        timeoutField.formatter = timeoutFormatter
        timeoutField.alignment = .right
        timeoutField.widthAnchor.constraint(equalToConstant: 64).isActive = true

        timeoutStepper.minValue = 5
        timeoutStepper.maxValue = 60
        timeoutStepper.increment = 1
        timeoutStepper.target = self
        timeoutStepper.action = #selector(timeoutChanged)
    }

    private func makeGeneralPage() -> NSView {
        let chooseButton = NSButton(
            title: "选择…",
            target: self,
            action: #selector(chooseDirectory)
        )
        let directoryRow = NSStackView(views: [directoryField, chooseButton])
        directoryRow.orientation = .horizontal
        directoryRow.spacing = 8
        directoryField.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let grid = makeGrid([
            ("笔记目录", directoryRow),
            ("浏览器", browserPopup),
        ])
        let hint = secondaryLabel("目录需包含 mkdocs/mkdocs.yml 和 .venv/bin/mkdocs。")
        return makePage(
            title: "常规",
            views: [grid, autoStartCheckbox, autoOpenBrowserCheckbox, hint]
        )
    }

    private func makeServerPage() -> NSView {
        let address = NSTextField(labelWithString: "127.0.0.1")
        let seconds = NSTextField(labelWithString: "秒")
        seconds.textColor = .secondaryLabelColor
        let timeoutRow = NSStackView(views: [timeoutField, timeoutStepper, seconds, NSView()])
        timeoutRow.orientation = .horizontal
        timeoutRow.alignment = .centerY
        timeoutRow.spacing = 6

        let grid = makeGrid([
            ("监听地址", address),
            ("端口", portField),
            ("启动超时", timeoutRow),
        ])
        let hint = secondaryLabel("服务仅监听本机，不会暴露到局域网。")
        return makePage(
            title: "MkDocs 服务",
            views: [
                grid,
                liveReloadCheckbox,
                dirtyReloadCheckbox,
                strictModeCheckbox,
                hint,
            ]
        )
    }

    private func makeAppearancePage() -> NSView {
        let grid = makeGrid([
            ("主题", appearancePopup),
            ("日志字号", logFontSizePopup),
        ])
        let hint = secondaryLabel("日志窗口最多显示最近 4 MB，原始文件仍完整保留。")
        return makePage(
            title: "外观与日志",
            views: [grid, ansiColorsCheckbox, hint]
        )
    }

    private func makePage(title: String, views: [NSView]) -> NSView {
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        let stack = NSStackView(views: [titleLabel] + views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 15
        for view in views {
            if view is NSGridView {
                view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            }
        }
        return stack
    }

    private func makeGrid(_ rows: [(String, NSView)]) -> NSGridView {
        let grid = NSGridView(views: rows.map {
            [NSTextField(labelWithString: $0.0), $0.1]
        })
        grid.rowSpacing = 14
        grid.columnSpacing = 14
        grid.column(at: 0).xPlacement = .trailing
        grid.column(at: 1).xPlacement = .fill
        return grid
    }

    private func secondaryLabel(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.textColor = .secondaryLabelColor
        return label
    }

    @objc private func changePage() {
        updateVisiblePage()
    }

    private func updateVisiblePage() {
        for (index, page) in pages.enumerated() {
            page.isHidden = index != tabs.selectedSegment
        }
    }

    @objc private func timeoutChanged() {
        timeoutField.integerValue = timeoutStepper.integerValue
    }

    @objc private func chooseDirectory() {
        guard let window else { return }
        let panel = NSOpenPanel()
        panel.title = "选择笔记目录"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: directoryField.stringValue)
        panel.beginSheetModal(for: window) { [weak self] response in
            if response == .OK, let path = panel.url?.path {
                self?.directoryField.stringValue = path
            }
        }
    }

    @objc private func cancel() {
        close()
    }

    @objc private func save() {
        let directory = directoryField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let port = portField.integerValue
        let timeout = timeoutField.integerValue

        guard !directory.isEmpty else {
            showValidationError("请选择笔记目录。")
            return
        }
        guard (1...65_535).contains(port) else {
            showValidationError("端口必须介于 1 和 65535。")
            return
        }
        guard (5...60).contains(timeout) else {
            showValidationError("启动超时必须介于 5 和 60 秒。")
            return
        }

        guard ProjectInspector.configURL(for: directory) != nil else {
            showValidationError("所选目录中没有 MkDocs 配置。")
            return
        }

        let liveReload = liveReloadCheckbox.state == .on
        let dirtyReload = dirtyReloadCheckbox.state == .on
        let strictMode = strictModeCheckbox.state == .on
        let serverChanged =
            settings.directory != directory
            || settings.port != port
            || settings.liveReload != liveReload
            || settings.dirtyReload != dirtyReload
            || settings.strictMode != strictMode
            || settings.startupTimeout != timeout

        settings.directory = directory
        settings.port = port
        settings.autoStart = autoStartCheckbox.state == .on
        settings.autoOpenBrowser = autoOpenBrowserCheckbox.state == .on
        settings.browser = BrowserChoice.allCases[browserPopup.indexOfSelectedItem]
        settings.liveReload = liveReload
        settings.dirtyReload = dirtyReload
        settings.strictMode = strictMode
        settings.startupTimeout = timeout
        settings.appearance = AppearanceChoice.allCases[appearancePopup.indexOfSelectedItem]
        settings.ansiColors = ansiColorsCheckbox.state == .on
        settings.logFontSize = Double(logFontSizePopup.selectedTag())

        onSave(serverChanged)
        close()
    }

    private func showValidationError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "无法保存设置"
        alert.informativeText = message
        alert.alertStyle = .warning
        if let window {
            alert.beginSheetModal(for: window)
        }
    }
}

private enum SettingsSection: String, CaseIterable, Identifiable {
    case general
    case server
    case appearance

    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: return "常规"
        case .server: return "服务"
        case .appearance: return "外观与日志"
        }
    }

    var subtitle: String {
        switch self {
        case .general: return "笔记位置与打开方式"
        case .server: return "MkDocs 启动与刷新选项"
        case .appearance: return "界面主题与日志显示"
        }
    }

    var symbolName: String {
        switch self {
        case .general: return "gearshape"
        case .server: return "network"
        case .appearance: return "paintbrush"
        }
    }
}

private struct NotesSettingsView: View {
    private static let portFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .none
        formatter.usesGroupingSeparator = false
        formatter.minimum = 1
        formatter.maximum = 65_535
        formatter.allowsFloats = false
        return formatter
    }()

    private let settings: SettingsStore
    private let onSave: (Bool) -> Void
    private let onClose: () -> Void

    @State private var section: SettingsSection = .general
    @State private var directory: String
    @State private var browser: BrowserChoice
    @State private var editor: EditorChoice
    @State private var autoStart: Bool
    @State private var autoOpenBrowser: Bool
    @State private var port: Int
    @State private var startupTimeout: Int
    @State private var liveReload: Bool
    @State private var dirtyReload: Bool
    @State private var strictMode: Bool
    @State private var appearance: AppearanceChoice
    @State private var ansiColors: Bool
    @State private var logFontSize: Double
    @State private var validationError = ""
    @State private var showsValidationError = false

    init(
        settings: SettingsStore,
        onSave: @escaping (Bool) -> Void,
        onClose: @escaping () -> Void
    ) {
        self.settings = settings
        self.onSave = onSave
        self.onClose = onClose
        let requestedSection = CommandLine.arguments
            .first { $0.hasPrefix("--settings-section=") }?
            .replacingOccurrences(of: "--settings-section=", with: "")
        _section = State(
            initialValue: SettingsSection(rawValue: requestedSection ?? "") ?? .general
        )
        _directory = State(initialValue: settings.directory)
        _browser = State(initialValue: settings.browser)
        _editor = State(initialValue: settings.editor)
        _autoStart = State(initialValue: settings.autoStart)
        _autoOpenBrowser = State(initialValue: settings.autoOpenBrowser)
        _port = State(initialValue: settings.port)
        _startupTimeout = State(initialValue: settings.startupTimeout)
        _liveReload = State(initialValue: settings.liveReload)
        _dirtyReload = State(initialValue: settings.dirtyReload)
        _strictMode = State(initialValue: settings.strictMode)
        _appearance = State(initialValue: settings.appearance)
        _ansiColors = State(initialValue: settings.ansiColors)
        _logFontSize = State(initialValue: settings.logFontSize)
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            detail
        }
        .frame(minWidth: 720, minHeight: 460)
        .alert("无法保存设置", isPresented: $showsValidationError) {
            Button("好", role: .cancel) {}
        } message: {
            Text(validationError)
        }
    }

    private var sidebar: some View {
        List(selection: $section) {
            Section {
                ForEach(SettingsSection.allCases) { item in
                Label(item.title, systemImage: item.symbolName)
                    .tag(item)
                    .padding(.vertical, 2)
                }
            }
        }
        .listStyle(.sidebar)
        .frame(width: 164)
    }

    private var detail: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(section.title)
                        .font(.system(size: 20, weight: .semibold))
                    Text(section.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)

            Divider()

            Group {
                switch section {
                case .general:
                    generalPage
                case .server:
                    serverPage
                case .appearance:
                    appearancePage
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()

            HStack(spacing: 10) {
                Spacer()
                Button("取消", action: onClose)
                    .keyboardShortcut(.cancelAction)
                Button("保存", action: save)
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var generalPage: some View {
        Form {
            Section("笔记位置") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("笔记目录")
                        .font(.callout)
                    HStack(spacing: 8) {
                        TextField("选择笔记目录", text: $directory)
                            .frame(maxWidth: .infinity)
                        Button("选择…", action: chooseDirectory)
                    }
                }
            }

            Section("打开方式") {
                Picker("浏览器", selection: $browser) {
                    ForEach(BrowserChoice.allCases, id: \.self) {
                        Text($0.title).tag($0)
                    }
                }
                .pickerStyle(.menu)

                Picker("编辑器", selection: $editor) {
                    ForEach(EditorChoice.allCases, id: \.self) {
                        Text($0.title).tag($0)
                    }
                }
                .pickerStyle(.menu)

                Toggle("自动启动服务", isOn: $autoStart)
                    .toggleStyle(.switch)

                Toggle("启动后打开网页", isOn: $autoOpenBrowser)
                    .toggleStyle(.switch)
                    .disabled(!autoStart)
            }
        }
        .formStyle(.grouped)
    }

    private var serverPage: some View {
        Form {
            Section("连接") {
                LabeledContent("监听地址") {
                    Text("127.0.0.1")
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }

                LabeledContent("端口") {
                    TextField(
                        "",
                        value: $port,
                        formatter: Self.portFormatter
                    )
                    .labelsHidden()
                    .multilineTextAlignment(.trailing)
                    .frame(width: 100)
                }

                LabeledContent("启动超时") {
                    Stepper(
                        "\(startupTimeout) 秒",
                        value: $startupTimeout,
                        in: 5...60
                    )
                    .fixedSize()
                }
            }

            Section("构建") {
                Toggle("实时刷新", isOn: $liveReload)
                    .toggleStyle(.switch)
                Toggle("仅重建改动文件", isOn: $dirtyReload)
                    .toggleStyle(.switch)
                Toggle("将警告视为错误", isOn: $strictMode)
                    .toggleStyle(.switch)
            }
        }
        .formStyle(.grouped)
    }

    private var appearancePage: some View {
        Form {
            Section("界面") {
                Picker("主题", selection: $appearance) {
                    ForEach(AppearanceChoice.allCases, id: \.self) {
                        Text($0.title).tag($0)
                    }
                }
                .pickerStyle(.segmented)
            }

            Section("日志") {
                Toggle("ANSI 颜色", isOn: $ansiColors)
                    .toggleStyle(.switch)

                Picker("字号", selection: $logFontSize) {
                    ForEach([10, 11, 12, 13, 14, 16, 18, 20], id: \.self) {
                        Text("\($0) pt").tag(Double($0))
                    }
                }
                .pickerStyle(.menu)
            }
        }
        .formStyle(.grouped)
    }

    private func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.title = "选择笔记目录"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: directory, isDirectory: true)
        if panel.runModal() == .OK, let path = panel.url?.path {
            directory = path
        }
    }

    private func save() {
        let trimmedDirectory = directory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedDirectory.isEmpty else {
            showError("请选择笔记目录。")
            return
        }
        guard (1...65_535).contains(port) else {
            showError("端口必须介于 1 和 65535。")
            return
        }
        guard (5...60).contains(startupTimeout) else {
            showError("启动超时必须介于 5 和 60 秒。")
            return
        }

        guard ProjectInspector.configURL(for: trimmedDirectory) != nil else {
            showError("没有找到 MkDocs 配置。")
            return
        }

        let serverChanged =
            settings.directory != trimmedDirectory
            || settings.port != port
            || settings.liveReload != liveReload
            || settings.dirtyReload != dirtyReload
            || settings.strictMode != strictMode
            || settings.startupTimeout != startupTimeout

        settings.directory = trimmedDirectory
        settings.port = port
        settings.autoStart = autoStart
        settings.autoOpenBrowser = autoOpenBrowser
        settings.browser = browser
        settings.editor = editor
        settings.liveReload = liveReload
        settings.dirtyReload = dirtyReload
        settings.strictMode = strictMode
        settings.startupTimeout = startupTimeout
        settings.appearance = appearance
        settings.ansiColors = ansiColors
        settings.logFontSize = logFontSize

        onSave(serverChanged)
        onClose()
    }

    private func showError(_ message: String) {
        validationError = message
        showsValidationError = true
    }
}

private final class SettingsWindowController: NSWindowController {
    private let settings: SettingsStore
    private let onSave: (Bool) -> Void
    private var hostingController: NSHostingController<NotesSettingsView>?

    init(settings: SettingsStore, onSave: @escaping (Bool) -> Void) {
        self.settings = settings
        self.onSave = onSave

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 500),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Notes 设置"
        window.center()
        window.minSize = NSSize(width: 760, height: 500)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("NotesSettingsWindowV2")
        super.init(window: window)
        reload()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func reload() {
        let view = NotesSettingsView(
            settings: settings,
            onSave: onSave,
            onClose: { [weak self] in self?.close() }
        )
        if let hostingController {
            hostingController.rootView = view
        } else {
            let controller = NSHostingController(rootView: view)
            hostingController = controller
            window?.contentViewController = controller
        }
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let settings = SettingsStore()
    private lazy var server = ServerManager(settings: settings)
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let menu = NSMenu()
    private let buildChecker = BuildChecker()
    private var settingsWindowController: SettingsWindowController?
    private var logWindowController: LogWindowController?
    private var buildResultWindowController: BuildResultWindowController?

    private let statusMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let portMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let themeMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let errorMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let toggleMenuItem = NSMenuItem(title: "", action: #selector(toggleServer), keyEquivalent: "")
    private let buildCheckMenuItem = NSMenuItem(
        title: "检查文档",
        action: #selector(runBuildCheck),
        keyEquivalent: ""
    )

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        applyAppearance()
        menu.delegate = self
        statusItem.menu = menu
        server.onChange = { [weak self] in
            self?.updateInterface()
        }
        buildMenu()
        updateInterface()

        if CommandLine.arguments.contains("--show-settings") || settings.directory.isEmpty {
            DispatchQueue.main.async { [weak self] in
                self?.showSettings()
            }
        }
        if CommandLine.arguments.contains("--run-build-check") {
            DispatchQueue.main.async { [weak self] in
                self?.runBuildCheck()
            }
        }

        if settings.autoStart, !settings.directory.isEmpty {
            if settings.autoOpenBrowser {
                server.ensureRunning { [weak self] success in
                    guard success, let self, let url = self.server.webURL else { return }
                    self.openInConfiguredBrowser(url)
                }
            } else {
                server.start()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        server.shutdown()
    }

    func menuWillOpen(_ menu: NSMenu) {
        updateInterface()
    }

    private func buildMenu() {
        statusMenuItem.isEnabled = false
        portMenuItem.isEnabled = false
        themeMenuItem.isEnabled = false
        errorMenuItem.isEnabled = false
        toggleMenuItem.target = self
        buildCheckMenuItem.target = self

        menu.addItem(statusMenuItem)
        menu.addItem(portMenuItem)
        menu.addItem(themeMenuItem)
        menu.addItem(errorMenuItem)
        menu.addItem(.separator())
        menu.addItem(toggleMenuItem)

        let openWebItem = NSMenuItem(
            title: "用网页打开",
            action: #selector(openWeb),
            keyEquivalent: ""
        )
        openWebItem.target = self
        menu.addItem(openWebItem)

        let openEditorItem = NSMenuItem(
            title: "用编辑器打开",
            action: #selector(openEditor),
            keyEquivalent: ""
        )
        openEditorItem.target = self
        menu.addItem(openEditorItem)

        let openFinderItem = NSMenuItem(
            title: "在 Finder 中打开",
            action: #selector(openFinder),
            keyEquivalent: ""
        )
        openFinderItem.target = self
        menu.addItem(openFinderItem)

        let openConfigItem = NSMenuItem(
            title: "打开 MkDocs 配置",
            action: #selector(openConfiguration),
            keyEquivalent: ""
        )
        openConfigItem.target = self
        menu.addItem(openConfigItem)

        menu.addItem(.separator())
        menu.addItem(buildCheckMenuItem)

        let openLogsItem = NSMenuItem(
            title: "查看日志",
            action: #selector(openLogs),
            keyEquivalent: ""
        )
        openLogsItem.target = self
        menu.addItem(openLogsItem)

        menu.addItem(.separator())

        let settingsItem = NSMenuItem(
            title: "设置…",
            action: #selector(showSettings),
            keyEquivalent: ","
        )
        settingsItem.target = self
        menu.addItem(settingsItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(
            title: "退出 Notes",
            action: #selector(quit),
            keyEquivalent: "q"
        )
        quitItem.target = self
        menu.addItem(quitItem)
    }

    private func updateInterface() {
        let state = server.state
        statusMenuItem.title = "状态：\(state.title)"
        portMenuItem.title = "端口：\(settings.port)"
        themeMenuItem.title = "主题：\(ProjectInspector.themeName(for: settings.directory))"
        buildCheckMenuItem.title = buildChecker.isRunning ? "正在检查…" : "检查文档"
        buildCheckMenuItem.isEnabled = !buildChecker.isRunning && !settings.directory.isEmpty

        if case .failed(let message) = state {
            errorMenuItem.title = "原因：\(message)"
            errorMenuItem.isHidden = false
        } else {
            errorMenuItem.isHidden = true
        }

        switch state {
        case .stopped, .failed:
            toggleMenuItem.title = "启动服务"
            toggleMenuItem.isEnabled = true
        case .starting:
            toggleMenuItem.title = "正在启动…"
            toggleMenuItem.isEnabled = false
        case .running(let managed):
            toggleMenuItem.title = managed ? "停止服务" : "外部服务运行中"
            toggleMenuItem.isEnabled = managed
        }

        if let button = statusItem.button {
            button.image = NSImage(
                systemSymbolName: state.symbolName,
                accessibilityDescription: "Notes：\(state.title)"
            )
            button.image?.isTemplate = true
            button.toolTip = "Notes — \(state.title) — 端口 \(settings.port)"
        }
    }

    @objc private func toggleServer() {
        switch server.state {
        case .running:
            server.stop()
        case .stopped, .failed:
            server.start()
        case .starting:
            break
        }
    }

    @objc private func openWeb() {
        server.ensureRunning { [weak self] success in
            guard let self else { return }
            if success, let url = self.server.webURL {
                self.openInConfiguredBrowser(url)
            } else {
                self.showAlert(
                    title: "无法打开笔记",
                    message: "MkDocs 服务未能启动。请查看状态栏中的错误或打开日志。"
                )
            }
        }
    }

    @objc private func openEditor() {
        guard !settings.directory.isEmpty else {
            showSettings()
            return
        }
        openInConfiguredEditor(
            URL(fileURLWithPath: settings.directory, isDirectory: true)
        )
    }

    @objc private func openFinder() {
        guard !settings.directory.isEmpty else {
            showSettings()
            return
        }
        let directoryURL = URL(fileURLWithPath: settings.directory, isDirectory: true)
        NSWorkspace.shared.open(directoryURL)
    }

    @objc private func openConfiguration() {
        guard let configURL = ProjectInspector.configURL(for: settings.directory) else {
            showAlert(title: "没有找到配置", message: "请在设置中选择有效的 MkDocs 项目。")
            return
        }
        openInConfiguredEditor(configURL)
    }

    @objc private func runBuildCheck() {
        guard !buildChecker.isRunning else { return }
        buildCheckMenuItem.title = "正在检查…"
        buildCheckMenuItem.isEnabled = false
        buildChecker.run(settings: settings) { [weak self] status, output, logURL in
            guard let self else { return }
            self.updateInterface()
            if self.buildResultWindowController == nil {
                self.buildResultWindowController = BuildResultWindowController(
                    settings: self.settings
                )
            }
            self.buildResultWindowController?.show(
                status: status,
                output: output,
                logURL: logURL
            )
        }
    }

    @objc private func openLogs() {
        if logWindowController == nil {
            logWindowController = LogWindowController(server: server, settings: settings)
        }
        logWindowController?.showWindow(nil)
        logWindowController?.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func showSettings() {
        if settingsWindowController == nil {
            settingsWindowController = SettingsWindowController(settings: settings) {
                [weak self] serverChanged in
                guard let self else { return }
                self.applyAppearance()
                self.logWindowController?.reloadPreferences()
                if serverChanged {
                    self.server.applyUpdatedConfiguration()
                }
                self.updateInterface()
            }
        }
        settingsWindowController?.reload()
        settingsWindowController?.showWindow(nil)
        settingsWindowController?.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func openInConfiguredBrowser(_ url: URL) {
        guard let bundleIdentifier = settings.browser.bundleIdentifier else {
            NSWorkspace.shared.open(url)
            return
        }

        let workspace = NSWorkspace.shared
        guard let applicationURL = workspace.urlForApplication(
            withBundleIdentifier: bundleIdentifier
        ) else {
            showAlert(
                title: "没有找到浏览器",
                message: "请在设置中选择已安装的浏览器。"
            )
            return
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = [url.absoluteString]
        configuration.activates = true
        workspace.openApplication(
            at: applicationURL,
            configuration: configuration
        ) { [weak self] _, error in
            if let error {
                DispatchQueue.main.async {
                    self?.showAlert(title: "无法打开网页", message: error.localizedDescription)
                }
            }
        }
    }

    private func openInConfiguredEditor(_ url: URL) {
        if settings.editor == .system {
            NSWorkspace.shared.open(url)
            return
        }

        if settings.editor == .obsidian {
            var components = URLComponents()
            components.scheme = "obsidian"
            components.host = "open"
            components.queryItems = [URLQueryItem(name: "path", value: url.path)]
            if let obsidianURL = components.url, NSWorkspace.shared.open(obsidianURL) {
                return
            }
        }

        let workspace = NSWorkspace.shared
        guard let applicationURL = settings.editor.bundleIdentifiers.compactMap({
            workspace.urlForApplication(withBundleIdentifier: $0)
        }).first else {
            showAlert(
                title: "没有找到编辑器",
                message: "请在设置中选择已安装的编辑器。"
            )
            return
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = [url.path]
        configuration.activates = true
        workspace.openApplication(
            at: applicationURL,
            configuration: configuration
        ) { [weak self] _, error in
            if let error {
                DispatchQueue.main.async {
                    self?.showAlert(title: "无法打开编辑器", message: error.localizedDescription)
                }
            }
        }
    }

    private func applyAppearance() {
        switch settings.appearance {
        case .system:
            NSApp.appearance = nil
        case .light:
            NSApp.appearance = NSAppearance(named: .aqua)
        case .dark:
            NSApp.appearance = NSAppearance(named: .darkAqua)
        }
    }

    private func showAlert(title: String, message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }
}

let application = NSApplication.shared
private let appDelegate = AppDelegate()
application.delegate = appDelegate
application.run()
