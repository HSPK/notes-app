# Notes App

macOS 与 Windows 原生托盘应用，用于管理本地 MkDocs 项目。

## 功能

- 启动、停止和监控本地 MkDocs 服务
- 管理端口、热更新、严格模式和启动超时
- ANSI 彩色日志、自动刷新和可靠清空
- 使用浏览器、编辑器或系统文件管理器打开项目
- 识别当前 MkDocs 主题并打开配置文件
- 运行严格构建检查
- 原生 macOS / Windows 设置界面与明暗主题

## macOS 构建

需要 macOS 13 或更高版本、Swift 工具链和 Python Pillow。

```bash
make app
make install
```

应用生成在 `build/Notes.app`，安装目标为 `~/Applications/Notes.app`。

## Windows 构建

Windows 版本使用 .NET 8、WinUI 3 和 Windows App SDK 1.8，不包含第三方 UI 包。设置、日志和构建结果全部使用原生 XAML 控件、Mica、系统主题与无障碍语义；系统托盘使用 `Shell_NotifyIconW` 和 Win32 原生菜单，不进行 GDI 自绘。需要 Windows 10 1809 或更高版本和 .NET 8 SDK。

```powershell
.\Windows\Scripts\build.ps1
```

也可用 `-Runtime win-x64` 或 `-Runtime win-arm64` 指定目标架构。构建生成单文件、自包含的 `build\windows\<架构>\Notes.exe`，目标电脑无需预装 .NET。WinUI 原生依赖会在首次启动时由 .NET 单文件加载器解压到当前用户的临时目录。

## 数据位置

- 偏好设置：`~/Library/Preferences/local.hangxing.notes.plist`
- 日志：`~/Library/Logs/NotesApp/`
- Windows 偏好设置：`%LOCALAPPDATA%\NotesApp\settings.json`
- Windows 日志：`%LOCALAPPDATA%\NotesApp\Logs\`

App 不包含文档内容，也不会在构建时写死任何 MkDocs 项目路径。首次使用时在设置中选择项目目录。

## 代码结构

- `macOS\`：macOS AppKit / SwiftUI 源码、平台资源和构建脚本
- `Windows\`：WinUI 3 / Windows App SDK 源码、Win32 托盘集成、清单和构建脚本
- `Shared\Resources\`：两端共用的品牌图标，不包含平台代码
