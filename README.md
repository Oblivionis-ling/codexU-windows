# CodexU Windows

## 0.3.2 版本说明

0.3.2 增加 Full reset 到期时间。CodexU 会在不记录、不上传登录令牌的前提下，复用本机 Codex 登录信息，只读获取官方桌面端所使用的重置明细，并显示可用次数中最近一项的到期日期。比如服务端返回 `2026-08-12T17:42:35Z` 时，北京时间会显示为“最近到期 8月13日”。

app-server 仍是额度和 Full reset 次数的基础数据源；若到期明细接口暂时不可用，应用会保留次数并显示“有效期暂不可用”，不会根据 7d 窗口或固定天数推算。该明细属于当前 ChatGPT/Codex 桌面端使用的内部接口，未来发生变化时可能需要继续适配。

## 0.3.1 版本说明

0.3.1 修复窗口置顶层级，切换到其他窗口后仍保持置顶；去掉组件外围灰边，并将窗口从 420 × 220 缩小到 372 × 192。套餐名称现在按 Codex 返回的真实类型显示，`prolite` 会显示为独立的 `Pro Lite`，不再误判为 Plus；套餐价格无法从 app-server 获取，因此不再猜测，可在托盘菜单中手动选择美元月费。

“重置次数”已改为 OpenAI 返回的 full reset 可用次数，即 `rateLimitResetCredits.availableCount`，不再按普通 7d 额度窗口本地累计。0.3.1 当时仅使用 app-server，因此只能记录可用次数最近一次减少的日期；0.3.2 已补充官方桌面端使用的到期明细数据。

## 0.3.0 版本说明

0.3.0 将界面精简为接近 macOS 两格小组件大小的桌面组件，只保留额度圆环、重置倒计时与本地重置记录、最近一次重置日期，以及“已使用价值 / 套餐价格”的薅羊毛进度。窗口默认置顶，使用 `Ctrl + U` 全局快捷键显示或隐藏，并在显示时实时刷新额度。

## 0.2.1 版本说明

这个版本是针对 Codex 取消原有 5h 额度窗口所做的兼容性修改。额度区域不再固定显示 5h/7d 双窗口，而是根据 Codex 实际返回的数据动态渲染；当前仅返回 7d 窗口时，界面只显示一个 7d 圆环。应用也不会继续沿用已经消失的旧 5h 缓存数据。

CodexU Windows 是一个紧凑的 Windows 桌面小组件，用于查看 Codex 额度、重置状态和本月使用价值。

本项目受 [shanggqm/codexU](https://github.com/shanggqm/codexU) 启发，是面向 Windows 的移植与重新实现版本。原项目主要面向 macOS；本项目保留“桌面小组件查看 Codex 使用情况”的核心思路，并针对 Windows 托盘、窗口行为和本地 Codex 数据路径做了适配。

## 功能

- Windows 托盘图标与无边框透明桌面窗口。
- `Ctrl + U` 显示/隐藏窗口。
- 固定 372 × 192 双格比例，可拖动、刷新和关闭隐藏。
- 接近 macOS 小组件的深色玻璃、系统字体与简约信息层级。
- 展示 Codex 额度圆环与 OpenAI full reset 可用次数。
- 显示 full reset 可用次数和最近一项的真实到期日期；明细不可用时不会按固定天数推断。
- 解析 Codex session JSONL 中的 `token_count` 事件，显示“本月使用价值 / 套餐价格”。
- 根据账号返回值显示真实套餐类型，并允许在托盘菜单设置套餐价格。
- 在后台 Worker 中读取数据，并按文件修改时间与字节偏移增量解析 session 日志。
- 不展示或输出 `auth.json` 中的 token 值。

## 数据来源

- 账号额度：`codex app-server` JSON-RPC。
- 详细 token：`%USERPROFILE%\.codex\sessions` 与 `archived_sessions` 中的 JSONL 事件。
- Full reset 次数：`codex app-server` 返回的 `rateLimitResetCredits.availableCount`。
- Full reset 到期明细：复用 `%USERPROFILE%\.codex\auth.json` 中现有登录状态，只读请求当前 Codex 桌面端使用的 ChatGPT 后端接口；令牌不会进入 renderer、日志或 Git。
- Full reset 变化记录：应用用户数据目录中的 `full-reset-history.json`，只记录本机观察到的可用次数与最近减少时间；旧版 `reset-history.json` 不会被覆盖。
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
    resetHistory.js       本地额度重置记录
scripts/
  smoke-test.js           数据读取 smoke test
```

## 许可

MIT
