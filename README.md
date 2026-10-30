# dsh-copilot — DSH 浏览器 + Windows 桌面操控插件

给 DSH 装上 Codex computer-use 等价能力：**浏览器面**（Playwright/CDP 结构化操控专用 profile Edge）+
**桌面面**（Windows-MCP UIA 树 + 鼠标键盘 + 截图 + 控制权接管）+ **桥接面**（状态自检 / 启动·唤醒·停止浏览器 /
唤醒桌面 / 截图（diskless + 滚动清理）/ deepseek-v4.1-flash 识图）。全部经 @deepseek-ai/dsh-mcp-client 挂载，零改 DSH 核心。

**能力按需激活（Skill 门控）**：浏览器面与桌面面默认都不挂载——模型加载 `dsh-copilot` Skill、
或调用 `wake_browser` / `wake_desktop` 入口工具、或点 UI 按钮，才拉起对应的 MCP 面。
常驻的只有桥接面（入口工具）和一行 Skill 描述。

## 架构

    DSH harness（决策循环 · 视觉模型 · approval）
      └─ dsh-copilot host（lib/index.js）
           ├─ mcp__browser__*   ← @playwright/mcp（stdio）──CDP──▶ 专用 profile Edge（:9222）
           │    【懒挂载】启动时探测 CDP：离线则不挂（0 进程 0 工具）；上线自动补挂，掉线自动卸载
           │    --config 白名单（capabilities: core 系列）+ --no-webmcp + --idle-timeout 空闲自关
           ├─ mcp__desktop__*   ← windows-mcp 实例（streamable-http :8765/mcp/，Bearer 随机 key，
           │                       崩溃指数退避重启，ANONYMIZED_TELEMETRY=false，--tools 白名单，
           │                       挂面前等端口就绪，消除启动竞争）
           │    【门控懒挂载】desktopLazy=true（默认）：启动不拉 windows-mcp；
           │    加载 dsh-copilot Skill / 调 wake_desktop / 点 UI 按钮后拉起，激活后常驻
           │    （desktopIdleReclaimMinutes=0 不回收到首次激活的响应速度；>0 时空闲自动卸）
           ├─ mcp__copilot__*   ← bridge/server.mjs（stdio）：status / launch_browser / wake_browser /
           │                       wake_desktop / stop_browser / capture（diskless + 滚动清理）/ vision
           ├─ Skill「dsh-copilot」（skills.register）：模型可见的能力说明 + 桌面操控观察规程；
           │    tools/result 观测到 Skill 加载 → 自动挂载桌面面（渐进曝光）
           ├─ 浏览器生命周期：stop（CDP Browser.close 优雅 → 进程树精确回收兜底）/ 空闲自动回收 /
           │                 dispose 策略（shutdownPolicy）
           ├─ 孤儿治理：启动时按命令行特征回收上一轮遗留的 bridge / playwright-mcp / windows-mcp 子进程
           ├─ 同源路由 /copilot/*（status、launch-browser、stop-browser、screenshot、desktop-control，仅回环）
           ├─ /copilot 斜杠命令（状态自检）
           └─ client UI（lib/client.js）：输入框右侧状态芯片 + 操控面板（启动/停止浏览器、启动/重启桌面服务）

## 依赖安装（一次性）

    # 桌面面（Python 3.14 经 uv；两个镜像环境变量在本机网络下必需）
    set UV_PYTHON_INSTALL_MIRROR=https://registry.npmmirror.com/-/binary/python-build-standalone
    set UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple/
    uv tool install windows-mcp --python 3.14
    # → 生成 %USERPROFILE%\.local\bin\windows-mcp.exe
    #
    # 若公司 EDR 拦截 uv 在 %TEMP% 生成 trampoline exe（报「拒绝访问 os error -2147024891」），改用 venv+pip：
    #   uv venv --seed --python 3.14 %USERPROFILE%\.dsh\windows-mcp-env
    #   %USERPROFILE%\.dsh\windows-mcp-env\Scripts\python.exe -m pip install -i https://mirrors.aliyun.com/pypi/simple/ windows-mcp
    #   → 生成 %USERPROFILE%\.dsh\windows-mcp-env\Scripts\windows-mcp.exe（插件会自动探测这两个候选路径）

    # 插件自身依赖（@playwright/mcp、@modelcontextprotocol/sdk）
    cd %USERPROFILE%\.dsh\profiles\desktop\dsh-copilot && npm install

## 使用

1. 重启 DSH 后，输入框右侧出现 🖥 芯片（两个状态点：浏览器 CDP / 桌面服务）。
   浏览器未开时 browser 面不挂载（省内存），芯片弹层会显示「懒挂载」状态。
2. 点芯片 → [🌐 启动专用浏览器]：打开专用 profile 的 Edge（带调试端口 9222），host 自动补挂 playwright-mcp。
   在该窗口人工登录目标站点（公网等），登录态长期保存在 %USERPROFILE%\.dsh\browser-profile。
3. 对 DSH 说「打开 xx 页面，读取 yy」→ 模型自动走 mcp__browser__* 工具。
4. 用完浏览器 → 弹层 [⏹ 停止浏览器] 或模型调 mcp__copilot__stop_browser 立即释放内存
   （登录态保留，下次启动无损恢复）；浏览器空闲超过 idleTimeoutMinutes 也会被自动回收，
   芯片弹层显示「已自动回收（空闲）」。
5. 桌面应用任务 → mcp__desktop__*（先 Snapshot 拿 UI 树再 Click/Type）；AI 操控时屏幕边缘发光，
   动物理鼠标即接管（Ctrl+Alt+Shift+Backspace 亦可）。
6. 验证码/短信/扫码 → 模型会用 ask_user_question 请你人工处理。
7. /copilot → 文本状态自检。

## 浏览器生命周期（资源开销核心）

| 场景 | 行为 |
|---|---|
| DSH 启动、浏览器未开 | msedge.exe（专用 profile）0 进程；playwright-mcp 0 进程、0 工具；模型侧有 mcp__copilot__wake_browser 占位入口 |
| 启动浏览器 | UI 按钮 / mcp__copilot__launch_browser / wake_browser 任一入口；CDP 就绪后 host 立即补挂 playwright-mcp |
| 停止浏览器 | UI 按钮 / mcp__copilot__stop_browser；优先 CDP Browser.close（优雅），失败按进程树回收——**仅杀命令行含 --user-data-dir=<专用 profile> 的浏览器进程，绝不误杀用户正常浏览器**；随后自动卸载 playwright-mcp |
| 空闲自动回收 | 双保险：playwright-mcp `--idle-timeout`（无完成的工具调用 N 毫秒后自关浏览器）+ host 每 10s 监督兜底（距上次活动超时即回收）。idleTimeoutMinutes=0 禁用 |
| DSH 正常退出 | shutdownPolicy=keep（默认，保持现状不惊喜，浏览器独立存活）；=stop 时 dispose 回收浏览器 |
| 上一轮孤儿 | host 启动时按命令行特征（本插件路径的 bridge/server.mjs、@playwright/mcp cli.js、windows-mcp.toml）回收遗留子进程，防双实例累积。注意：同时运行多个 DSH 实例时，后启动实例会回收先启动实例的这几类子进程 |

## 桌面面生命周期（门控懒挂载）

| 场景 | 行为 |
|---|---|
| DSH 启动 | desktopLazy=true（默认）：不拉 windows-mcp、不挂 mcp__desktop__*（0 进程 0 工具）；host 只预占端口供唤醒使用 |
| 激活 | ① 模型加载 `dsh-copilot` Skill（自动）② 调 `mcp__copilot__wake_desktop`（阻塞等到就绪，≤20s）③ UI 芯片「▶ 启动桌面服务」；三选一即拉起 windows-mcp 并挂载工具面 |
| 激活后 | 默认常驻（desktopIdleReclaimMinutes=0）：看桌面/操控即时响应；配置 >0 时按无 mcp__desktop__* 调用的空闲分钟数自动卸载，下次 wake 再拉起 |
| 回退旧行为 | `desktopLazy: false`：启动即挂载（等同 v0.2.0） |
| 观察规程 | Skill 内容与 bridge 常驻说明都写明：动作前必须 Snapshot、动作后重新确认、>2 分钟的观察视为过期、坐标仅兜底、高危操作先确认——防「看到旧的、点错位置」 |

## 模型侧工具目录收窄（browser 面）

`@playwright/mcp` 0.0.83（当前最新版）无 `--tools` 单工具白名单参数，采用等价收窄：

- `--config`（host 生成 `%USERPROFILE%\.dsh\copilot\playwright-mcp.config.json`）声明 `capabilities: ["core", "core-navigation", "core-tabs", "core-input"]`——只保留核心操控/导航/标签/输入工具；
  network 拦截（route/route_list/unroute/network_state_set）、storage（cookie/localStorage/sessionStorage）、pdf、devtools、testing、browser_install 均不启用
  （其中 network/storage/pdf/devtools 本就是 opt-in 未启用，白名单用于显式锁定，防后续版本默认膨胀）。
- `webmcp: false`（--no-webmcp）：不收集页面经 WebMCP API 注册的动态工具。
- 核心组内的 browser_network_request(s) 为只读网络排查工具，保留。

## 配置（cordis.patch.yml 的 config 段，全部有默认值）

| 键 | 默认 | 说明 |
|---|---|---|
| browserEnabled / browserChannel | true / msedge | 浏览器面开关与通道（msedge、chrome） |
| browserExe | 自动探测 | 浏览器可执行文件路径 |
| browserProfileDir | ~/.dsh/browser-profile | 专用 profile 目录（登录态所在） |
| browserCdpPort | 9222 | 远程调试端口 |
| browserStartUrl | 空 | launch_browser 默认打开的 URL |
| **idleTimeoutMinutes** | **15** | 浏览器空闲自动回收阈值（分钟）；0 = 禁用 |
| **shutdownPolicy** | **keep** | DSH 退出时浏览器处置：keep（独立存活，现状）/ stop（dispose 时回收） |
| desktopEnabled / desktopExe | true / ~/.local/bin/windows-mcp.exe | 桌面面开关与 exe |
| desktopPort | 8765 | 常驻实例端口（占用时自动 +1 探测 20 个） |
| desktopTools | Screenshot,Snapshot,Click,Type,... | windows-mcp 工具白名单 |
| desktopControlPolicy / desktopIdleTimeout | relaxed / 10 | 兼容保留。注：windows-mcp 0.8.8 的 [control] 仅识别 mouse_takeover_units/pixels，这两个键不落 TOML、无运行效果 |
| **desktopLazy** | **true** | 桌面面门控懒挂载：启动不拉 windows-mcp，Skill 加载 / wake_desktop / UI 按钮激活；false = 启动即常驻（旧行为） |
| **desktopIdleReclaimMinutes** | **0** | 桌面面空闲自动卸载阈值（分钟，按无 mcp__desktop__* 调用计）；0 = 激活后常驻（推荐，看桌面要即时响应） |
| **skillEnabled** | **true** | 注册 `dsh-copilot` Skill（模型可见的能力说明 + 桌面观察规程；加载后自动挂载桌面面） |
| visionEnabled / visionModel | true / deepseek-v4.1-flash-aliyunbailian | 识图开关与模型 |
| visionBaseURL / visionApiKeyEnv | 视觉网关/v1 / ALIYUNBAILIAN_API_KEY | 网关与凭据名 |
| bridgeEnabled / nodeExe | true / 自动探测 | 桥接面开关与 node 路径 |
| screenshotDir | ~/.dsh/copilot-screenshots | 截图落盘目录 |
| **maxScreenshots** | **50** | 截图目录滚动清理：最多保留张数（每次 capture/UI 截图后顺手清） |
| **maxAgeHours** | **72** | 截图目录滚动清理：最大保留时长（小时） |
| routePrefix / toolCallTimeoutMs | /copilot / 120000 | 路由前缀与 MCP 调用超时 |

### 配置示例

    - insert:
        - id: dsh-copilot
          name: 'dsh-copilot'
          config:
            browserCdpPort: 9222
            desktopPort: 8765
            idleTimeoutMinutes: 15      # 浏览器空闲 15 分钟自动回收；0 禁用
            shutdownPolicy: keep        # DSH 退出时浏览器 keep（独立存活）/ stop（回收）
            desktopLazy: true            # 桌面面门控懒挂载（Skill/wake/UI 激活）；false=启动即常驻
            desktopIdleReclaimMinutes: 0 # 桌面激活后常驻；>0 时空闲 N 分钟自动卸载
            skillEnabled: true           # 注册 dsh-copilot Skill
            maxScreenshots: 50          # 截图目录上限（张）
            maxAgeHours: 72             # 截图最大保留时长（小时）
            visionModel: deepseek-v4.1-flash-aliyunbailian

## Skill（能力门控与操作说明书）

插件启动时通过 `skills.register` 注册名为 `dsh-copilot` 的 Skill（services 可选注入，缺失时不注册、其它功能不受影响）：

- **description/whenToUse**：告诉模型何时该加载（需要操作网页、查看/分析桌面画面、控制 Windows 应用时）。
- **content**：能力路由（网页→browser 面、桌面→desktop 面、看屏幕→vision）+ **桌面操控观察规程**
  （动作前 Snapshot、动作后重新确认、>2 分钟观察过期、坐标仅兜底、高危先确认）+ 资源语义。
- **渐进曝光**：host 监听 `tools/result`；模型加载该 Skill 后**自动挂载桌面面**（无需额外调用），
  与 wake_desktop / UI 按钮构成三选一的激活入口。会话重启后再次加载 Skill 即可恢复。

## 桥接工具（mcp__copilot__*）

| 工具 | 说明 |
|---|---|
| status | 状态自检（CDP / windows-mcp / 视觉配置 / 截图策略） |
| launch_browser | 启动或复用专用 Edge，等待 CDP 就绪；host 随即自动补挂 browser 面 |
| wake_browser | 同 launch_browser（懒挂载场景的显式唤醒入口；就绪后数秒内 browser 面可用） |
| **wake_desktop** | 唤醒桌面面：host 拉起 windows-mcp 并挂载 mcp__desktop__*；本工具阻塞等待就绪（≤20s），mcp__desktop__* 不存在时先调它 |
| stop_browser | 停止专用浏览器（CDP 优雅关闭 → 进程树精确回收兜底）；登录态保留 |
| capture | 全屏截图；**默认 diskless=true 仅内存返回不落盘**，diskless=false 落盘（带滚动清理） |
| vision | 识图问答（deepseek-v4.1-flash）；缺省先 diskless 截图 |

## 同源路由（/copilot/*，仅回环）

| 路由 | 说明 |
|---|---|
| POST /copilot/status | 状态 JSON（含 ui.pollIntervalMs 供芯片轮询节奏、desktop.lazy/mounted、skill.registered） |
| POST /copilot/launch-browser | 启动浏览器（body 可带 {url}），返回后 host 已即时补挂 browser 面 |
| POST /copilot/stop-browser | 停止浏览器 |
| POST /copilot/screenshot | UI 截图预览（dataUrl；顺手滚动清理） |
| POST /copilot/desktop-control | {action: **wake**\|start\|stop\|restart}；wake/start 拉起并挂载，restart=卸了重挂，stop 卸载 |

## 状态芯片（client 半）

- 轮询：默认 60s（随 status.ui.pollIntervalMs 下发）；页面隐藏时暂停；弹层打开立即刷一次并临时提高到 5s；
  launch/stop 等操作返回后主动刷新。
- 弹层：浏览器/桌面/识图/桥接状态明细、上次停止原因（「已自动回收（空闲）」等）、
  [启动专用浏览器] [停止浏览器] [截图预览] [启动/重启桌面服务（按挂载状态自动切换）] [刷新]。

## 测试（分 lane）

    npm run test:local     # 秒级：语法 + 模块导出 + 包元数据 + 工具清单静态校验（不联网、不开浏览器）
    npm run test:bridge    # 本机端到端：桥接面 8 项断言（真实打开专用 Edge，跳过识图）
    npm run test:model     # 识图实调：视觉网关 deepseek-v4.1-flash（需要 key 与测试图）
    npm run validate       # local + bridge + model 全跑（release lane）

等价的原生命令：`node scripts/validate.mjs --lane local|bridge|model|release`；
单项调试仍可直接跑 `node scripts/test-bridge.mjs [--skip-browser|--skip-vision|--vision-only]`。
升级 DSH 版本后先跑 `test:local`——它校验的是本插件对 DSH 内部 API 的假设（skills.register / tools/result / slot 契约）。

## 排错

- **输入框右侧没有芯片** → 看浏览器控制台（F12）；常见为 slot 注册参数问题——list 型槽位（conversation.input.right）注册必须带 `id` 字段，缺 id 会被 slots 核心拒绝（"list slot ... requires options.id"）且仅在控制台报错。
- 浏览器工具报 CDP 连接失败 / 工具不存在 → 先调 mcp__copilot__launch_browser（或 UI 按钮）启动专用 Edge；懒挂载补挂需要数秒。
- **桌面工具 mcp__desktop__* 不存在** → 桌面面是门控懒挂载：先加载 `dsh-copilot` Skill 或调 mcp__copilot__wake_desktop（或点芯片「▶ 启动桌面服务」），就绪后工具才出现。
- **Skill 未注册**（/copilot 显示"Skill 未注册"）→ 当前 profile 缺 skills 服务（检查 dsh-base 的 skill-filesystem/tool-skill 是否启用），或 skillEnabled=false；其它能力不受影响。
- 桌面面未挂载 → 确认 %USERPROFILE%\.local\bin\windows-mcp.exe 存在；看 DSH 日志 [dsh-copilot]。
- 端口冲突 → desktopPort/browserCdpPort 可改（config）。
- 遥测 → 已强制 ANONYMIZED_TELEMETRY=false。
- 截图黑屏 → 部分 GPU 环境 dxcam 异常，capture 会自动走 PowerShell 兜底（via=powershell）。

## 安全说明

- /copilot/* 路由仅接受回环地址请求。
- windows-mcp 常驻实例绑定 127.0.0.1，Bearer key 每次启动随机生成，仅注入给本插件挂载的客户端与桥接进程。
- 浏览器进程树回收严格按 `--user-data-dir=<专用 profile 路径>` 命令行特征匹配，不触碰用户正常浏览器。
- 视觉 key 经 ctx.credentials 在 host 侧解析（回退读 ~/.dsh/.credentials.yaml），永不写日志。
- 桌面控制权接管为 best-effort（windows-mcp 官方语义），敏感操作仍受 DSH approval/sandbox 约束。
