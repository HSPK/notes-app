# Notes App

原生 macOS 状态栏应用，用于管理本地 MkDocs 项目。

## 功能

- 启动、停止和监控本地 MkDocs 服务
- 管理端口、热更新、严格模式和启动超时
- ANSI 彩色日志、自动刷新和可靠清空
- 使用浏览器、编辑器或 Finder 打开项目
- 识别当前 MkDocs 主题并打开配置文件
- 运行严格构建检查
- 原生 macOS 设置界面与明暗主题

## 构建

需要 macOS 13 或更高版本、Swift 工具链和 Python Pillow。

```bash
make app
make install
```

应用生成在 `build/Notes.app`，安装目标为 `~/Applications/Notes.app`。

## 数据位置

- 偏好设置：`~/Library/Preferences/local.hangxing.notes.plist`
- 日志：`~/Library/Logs/NotesApp/`

App 不包含文档内容，也不会在构建时写死任何 MkDocs 项目路径。首次使用时在设置中选择项目目录。
