# CodexU Windows

## 0.2.1 版本说明

这个版本是针对 Codex 取消原有 5h 额度窗口所做的兼容性修改。额度区域不再固定显示 5h/7d 双窗口，而是根据 Codex 实际返回的数据动态渲染；当前仅返回 7d 窗口时，界面只显示一个 7d 圆环。应用也不会继续沿用已经消失的旧 5h 缓存数据。

CodexU Windows 是一个 Windows 桌面小组件，用于查看 Codex 额度、本地 token 用量、估算价值和今日任务看板。

本项目受 [shanggqm/codexU](https://github.com/shanggqm/codexU) 启发，是面向 Windows 的移植与重新实现版本。原项目主要面向 macOS；本项目保留“桌面小组件查看 Codex 使用情况”的核心思路，并针对 Windows 托盘、窗口行为和本地 Codex 数据路径做了适配。

## 功能

- Windows 托盘图标与无边框透明桌面窗口。
- `Ctrl + Alt + U` 显示/隐藏窗口。
- 可拖动窗口、刷新按钮、关闭隐藏按钮。
- 紧凑液态玻璃风格仪表盘。
- 展示 Codex 账号额度窗口（可用时）。
- 读取本机 Codex SQLite 状态库中的线程和 token 统计。
- 解析 Codex session JSONL 中的 `token_count` 事件，估算 API 等效价值。
- 在后台 Worker 中读取数据，并按文件修改时间与字节偏移增量解析 session 日志。
- 今日任务看板：进行中、待处理、定时、完成。
- 不展示或输出 `auth.json` 中的 token 值。
- 只允许界面打开当前快照中的工作区目录；定时任务文件仅在资源管理器中定位。

## 数据来源

- 账号额度：`codex app-server` JSON-RPC。
- 本地用量：`%USERPROFILE%\.codex\state_5.sqlite` 或 `%USERPROFILE%\.codex\sqlite\state_5.sqlite`。
- 详细 token：`%USERPROFILE%\.codex\sessions` 与 `archived_sessions` 中的 JSONL 事件。
- 定时任务：`%USERPROFILE%\.codex\automations\*.toml`。
- 若系统 PATH / WindowsApps 中的 `codex` 不可执行，应用会优先使用随依赖安装的 `@openai/codex` CLI。

## 开发运行

需要 Node.js 与 pnpm。

```powershell
pnpm install
pnpm run dev
```

验证数据读取：

```powershell
pnpm run smoke
```

运行单元测试、代码检查和格式检查：

```powershell
pnpm run check
```

首次刷新会扫描现有 session 日志；后续刷新只读取新增或变化的内容。模型无法识别时仍统计 token，但不会套用默认价格，界面会将该部分标记为未估价。

构建 Windows 便携版：

```powershell
pnpm run dist
```

构建输出位于 `dist/`，不会提交到 Git。

## 项目结构

```text
src/
  main.js                 Electron 主进程、托盘、窗口与 IPC
  preload.js              安全暴露 renderer API
  renderer/
    index.html            渲染入口
    app.js                UI 渲染与交互
    styles.css            UI 样式
  services/
    codexData.js          Codex 数据读取与统计
scripts/
  smoke-test.js           数据读取 smoke test
```

## 许可

MIT
