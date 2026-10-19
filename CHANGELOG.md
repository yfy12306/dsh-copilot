# CHANGELOG

## 0.3.0 — 2026-10-19

能力门控（对齐 dsh-computer-use 的渐进曝光范式，按 Windows/单用户场景适配）：

- **Skill「dsh-copilot」**：插件启动时经 `skills.register` 注册（可选注入，skills 服务缺失时跳过，其它能力不受影响）。
  内容含能力路由与**桌面操控观察规程**（动作前 Snapshot、动作后重新确认、>2 分钟观察过期、坐标仅兜底、高危先确认）。
- **桌面面门控懒挂载**（`desktopLazy` 默认 true）：启动不再拉 windows-mcp；加载 Skill / 调 `wake_desktop` /
  点 UI「▶ 启动桌面服务」三选一激活。激活后默认常驻（`desktopIdleReclaimMinutes=0`），可配 >0 做空闲卸载。
- **`tools/result` 观测**：Skill 加载自动挂载桌面面；`wake_browser` 调用即时补挂浏览器面；
  `mcp__browser__*` / `mcp__desktop__*` 每次调用刷新活动时间——空闲回收改为按真实工具调用计时。
- **bridge 新增 `wake_desktop` 工具**：阻塞等待 windows-mcp 就绪（≤20s），解决「工具不存在→模型反复重试」。
- 首启预占桌面端口并注入 bridge 预期地址（`COPILOT_WINDOWS_MCP_EXPECT_URL`），唤醒路径端口一致。

工程：

- `package.json` 增加 `dsh.compatibility`（已验证的 DSH 版本与 API 假设）与 `test:local|bridge|model` / `validate` scripts。
- 新增 `scripts/validate.mjs`：分 lane 验证（local 秒级静态 / bridge 本机端到端 / model 识图实调 / release 全跑）。
- 新增 CHANGELOG；README 增补 Skill、桌面生命周期、配置项与排错。

## 0.2.0 — 2026-10-16

芯片与资源/稳健性优化（P0-P3）：

- 修复输入框右侧芯片不显示：`conversation.input.right` 为 list 型槽位，注册参数必须含 `id`
  （原实现缺 id 被 slots 核心拒绝，仅控制台报错）。
- 浏览器生命周期：`stop_browser` 工具 + `/copilot/stop-browser` 路由 + 芯片停止按钮；
  优先 CDP `Browser.close`，失败按 `--user-data-dir=<专用 profile>` 进程树精确回收；`idleTimeoutMinutes` 空闲自动回收；
  `shutdownPolicy: keep|stop`。
- 浏览器面懒挂载：CDP 离线 0 进程 0 工具；上线自动补挂、掉线自动卸载；`wake_browser` 入口；
  `--config` capabilities 白名单 + `--no-webmcp` + `--idle-timeout`。
- desktop 面：挂载前等端口就绪（修 `startup failed: fetch failed` 竞争）；TOML 只写 windows-mcp 0.8.8 有效键。
- `capture` 默认 diskless + 截图目录滚动清理（`maxScreenshots`/`maxAgeHours`）；`vision` 默认 diskless 取图。
- 芯片轮询：60s 默认、隐藏暂停、弹层 5s、操作后主动刷新。
- 孤儿治理：启动回收遗留 bridge/playwright-mcp/windows-mcp 子进程；`sup.stop()` 改进程树杀。
- 验收：沙箱实测 9 个 Edge（2.8GB）→0、空闲回收 reason=idle、3 轮起停 0 孤儿、bridge e2e 10/10。

## 0.1.0 — 2026-10-16

初版：三个 MCP 面（browser=playwright-mcp / desktop=windows-mcp / copilot=bridge）、
`/copilot/*` 同源路由、`/copilot` 斜杠命令、状态芯片与操控面板、零改 DSH 核心挂载。
