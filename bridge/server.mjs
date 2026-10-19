/**
 * dsh-copilot 桥接 MCP server（stdio）。
 *
 * 给 DSH 提供浏览器/桌面操控的横切工具（模型侧名称 mcp__copilot__*）：
 *   status          状态自检（Edge CDP / windows-mcp / 视觉配置 / 截图目录）
 *   launch_browser  启动或复用「专用 profile + 远程调试端口」的 Edge，供 Playwright 接管
 *   wake_browser    同 launch_browser；浏览器面懒挂载时，host 会在探测到 CDP 后自动补挂 playwright-mcp
 *   stop_browser    停止专用浏览器：优先 CDP Browser.close（优雅），失败按进程树回收
 *                   （仅杀命令行含 --user-data-dir=<专用 profile> 的浏览器进程，绝不误杀）
 *   capture         全屏截图：默认仅内存返回（diskless）；落盘模式带滚动清理
 *   vision          识图问答：图片发给轻量视觉模型（默认 deepseek-v4.1-flash @ 你的 LLM 网关）
 *
 * 配置全部经 COPILOT_* 环境变量注入（host 插件负责组装；视觉 key 亦可回退读
 * ~/.dsh/.credentials.yaml，与 voice-input 的 test-asr.mjs 同款方式，key 永不打印）。
 * 协议通道是 stdout（换行分隔 JSON-RPC），日志一律走 stderr。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const req = createRequire(path.join(here, "noop.js"));
const { Server } = req("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = req("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = req("@modelcontextprotocol/sdk/types.js");

const HOME = os.homedir();
const ENV = {
  windowsUrl: process.env.COPILOT_WINDOWS_MCP_URL || "",
  windowsExpectUrl: process.env.COPILOT_WINDOWS_MCP_EXPECT_URL || "",
  windowsKey: process.env.COPILOT_WINDOWS_MCP_KEY || "",
  cdpPort: Number(process.env.COPILOT_BROWSER_CDP_PORT || 9222),
  browserExe: process.env.COPILOT_BROWSER_EXE || "",
  browserProfile: process.env.COPILOT_BROWSER_PROFILE || path.join(HOME, ".dsh", "browser-profile"),
  startUrl: process.env.COPILOT_BROWSER_START_URL || "",
  screenshotDir: process.env.COPILOT_SCREENSHOT_DIR || path.join(HOME, ".dsh", "copilot-screenshots"),
  maxScreenshots: Number(process.env.COPILOT_MAX_SCREENSHOTS || 50),
  maxAgeHours: Number(process.env.COPILOT_MAX_AGE_HOURS || 72),
  visionBaseUrl: process.env.COPILOT_VISION_BASE_URL || "https://your-llm-gateway.example.com/v1",
  visionModel: process.env.COPILOT_VISION_MODEL || "deepseek-v4.1-flash-aliyunbailian",
  visionKey: process.env.COPILOT_VISION_API_KEY || "",
  visionTimeoutMs: Number(process.env.COPILOT_VISION_TIMEOUT_MS || 90000)
};

const INSTRUCTIONS = [
  "dsh-copilot 工具路由约定（能力按需激活，避免常驻开销）：",
  "- 网页/URL 任务（读取内容、填表、点击、多标签）优先用 mcp__browser__*（Playwright，结构化 a11y 树，最快最准）。它接管的是「专用 profile」的 Edge。",
  "  · 浏览器面懒挂载：DSH 启动时若 CDP 离线则不挂 playwright-mcp（省内存）；调 mcp__copilot__launch_browser / wake_browser 启动浏览器后，host 会在数秒内自动补挂 browser 面，稍候重试 mcp__browser__* 即可。",
  "  · 用完浏览器可调 mcp__copilot__stop_browser 释放内存（登录态保留在专用 profile，重启无损）；浏览器空闲（无工具调用）超过配置的 idleTimeoutMinutes 也会被自动回收。",
  "- Windows 桌面应用任务（非浏览器窗口）用 mcp__desktop__*（Windows-MCP）：先 Snapshot 拿 UI 元素树（可加 use_dom=True 只取网页内容、use_vision=True 附截图），再按元素 id/坐标 Click/Type；App 工具按开始菜单名启动应用。",
  "  · 桌面面门控挂载：mcp__desktop__* 不存在时，先调 mcp__copilot__wake_desktop（或加载 dsh-copilot Skill），就绪后该工具面才会出现；不要反复重试不存在的工具。",
  "- 桌面操控观察规程（必须遵守）：① 动作前必须 Snapshot 最新 UI 树，动作后重新 Snapshot 确认；② 优先元素 id/名称，坐标仅作兜底且必须来自最近一次 Snapshot；③ 超过 2 分钟的旧观察视为过期，动作前重新 Snapshot；④ 动作后界面无变化先判断是否真失败，再次操作前重新 Snapshot，禁止盲目重试；⑤ 高危操作（删除/发送/提交/支付）前用 ask_user_question 明确确认。",
  "- 需要把屏幕画面落盘、或用便宜快速的视觉模型回答「屏幕上是什么」类问题：mcp__copilot__capture / mcp__copilot__vision（默认不落盘，目录带滚动清理，不会无限增长）。",
  "- AI 操控桌面期间屏幕边缘发光；用户动鼠标即接管（best-effort）。遇验证码、短信、扫码登录等必须人工的环节，用 ask_user_question 请用户在浏览器里完成后继续。",
  "- 写代码/改文件仍用 DSH 原生文件工具，不要用桌面 Type 工具在 IDE 里打字。"
].join("\n");

function log() {
  const args = Array.prototype.slice.call(arguments);
  args.unshift("[dsh-copilot-bridge]");
  console.error.apply(console, args);
}

async function fetchTimeout(url, options, ms) {
  const ac = new AbortController();
  const t = setTimeout(function () { ac.abort(); }, ms);
  try {
    return await fetch(url, Object.assign({}, options, { signal: ac.signal }));
  } finally {
    clearTimeout(t);
  }
}

async function cdpVersion() {
  try {
    const r = await fetchTimeout("http://127.0.0.1:" + ENV.cdpPort + "/json/version", { method: "GET" }, 1500);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

async function waitCdp(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cdpVersion()) return true;
    await new Promise(function (r) { setTimeout(r, 500); });
  }
  return false;
}

// ---------- 浏览器停止：CDP 优雅关闭 + 进程树兜底 ----------

/** 经 CDP WebSocket 发 Browser.close（Node ≥21 内置全局 WebSocket；不可用返回 false 走兜底）。 */
function cdpBrowserClose(wsUrl, timeoutMs) {
  return new Promise(function (resolve) {
    if (typeof WebSocket !== "function") { resolve(false); return; }
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) { resolve(false); return; }
    const done = function (ok) {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) { /* 忽略 */ }
      resolve(ok);
    };
    const timer = setTimeout(function () { done(false); }, timeoutMs || 5000);
    ws.onopen = function () {
      try { ws.send(JSON.stringify({ id: 1, method: "Browser.close" })); } catch (e) { done(false); }
    };
    ws.onclose = function () { clearTimeout(timer); done(true); };   // 浏览器关闭 → 连接断开
    ws.onerror = function () { clearTimeout(timer); done(false); };
    ws.onmessage = function () { /* Browser.close 正常不回包，忽略 */ };
  });
}

/** 按命令行特征精确回收「专用 profile」浏览器进程树（绝不碰用户正常浏览器）。 */
function killBrowserProcessTree() {
  return new Promise(function (resolve) {
    if (!ENV.browserProfile) { resolve(0); return; }
    const exeName = ENV.browserExe ? path.basename(ENV.browserExe) : "msedge.exe";
    const script =
      "$profile = [System.IO.Path]::GetFullPath('" + ENV.browserProfile.replace(/'/g, "''") + "'); " +
      "$procs = Get-CimInstance Win32_Process -Filter \"Name='" + exeName + "'\" | " +
      "Where-Object { $_.CommandLine -and ($_.CommandLine -like ('*' + $profile + '*')) }; " +
      "$killed = 0; foreach ($p in $procs) { taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null; $killed++ }; " +
      "Write-Output $killed";
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true });
    } catch (e) { resolve(-1); return; }
    let so = "";
    child.stdout.on("data", function (d) { so += d; });
    child.stderr.on("data", function () {});
    child.on("error", function () { resolve(-1); });
    child.on("close", function () {
      const n = parseInt(String(so).trim(), 10);
      resolve(Number.isFinite(n) ? n : -1);
    });
  });
}

/** 停止专用浏览器：优先 CDP Browser.close，5 秒未掉线再按进程树回收。 */
async function stopBrowser() {
  const before = await cdpVersion();
  if (!before) {
    return { ok: true, alreadyStopped: true, via: "none" };
  }
  let via = "";
  const wsUrl = before.webSocketDebuggerUrl || ("ws://127.0.0.1:" + ENV.cdpPort + "/devtools/browser");
  const graceful = await cdpBrowserClose(wsUrl, 5000);
  if (graceful) {
    // 等 CDP 真正掉线（最多 5 秒）
    for (let i = 0; i < 10; i++) {
      if (!(await cdpVersion())) break;
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    via = "cdp";
  }
  if (await cdpVersion()) {
    const killed = await killBrowserProcessTree();
    via = "process-tree(killed " + killed + ")";
    for (let i = 0; i < 10; i++) {
      if (!(await cdpVersion())) break;
      await new Promise(function (r) { setTimeout(r, 500); });
    }
  }
  const stopped = !(await cdpVersion());
  return { ok: stopped, via: via || "cdp", browser: before.Browser || null };
}

function resolveVisionKey() {
  if (ENV.visionKey) return ENV.visionKey;
  try {
    const t = fs.readFileSync(path.join(HOME, ".dsh", ".credentials.yaml"), "utf8");
    const m = /ALIYUNBAILIAN_API_KEY\s*:\s*"?([^"\n,}]+)"?/.exec(t);
    if (m) return m[1].trim();
  } catch (e) { /* 忽略 */ }
  return "";
}

async function windowsCall(toolName, args, timeoutMs) {
  const { Client } = req("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = req("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const headers = {};
  if (ENV.windowsKey) headers["Authorization"] = "Bearer " + ENV.windowsKey;
  const transport = new StreamableHTTPClientTransport(new URL(ENV.windowsUrl), { requestInit: { headers } });
  const client = new Client({ name: "dsh-copilot-bridge", version: "0.2.0" });
  try {
    await client.connect(transport);
    return await client.callTool({ name: toolName, arguments: args || {} }, undefined, { timeout: timeoutMs || 30000 });
  } finally {
    try { await client.close(); } catch (e) { /* 忽略 */ }
  }
}

function captureViaPowerShell(outPath) {
  return new Promise(function (resolve, reject) {
    const safe = outPath.replace(/'/g, "''");
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
      "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; " +
      "$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); " +
      "$g=[System.Drawing.Graphics]::FromImage($bmp); " +
      "$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size); $g.Dispose(); " +
      "$bmp.Save('" + safe + "',[System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); Write-Output OK";
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    let so = "";
    let se = "";
    child.stdout.on("data", function (d) { so += d; });
    child.stderr.on("data", function (d) { se += d; });
    child.on("error", reject);
    child.on("close", function (code) {
      if (code === 0 && fs.existsSync(outPath)) resolve();
      else reject(new Error("powershell exit " + code + " " + (se || so).slice(0, 200)));
    });
  });
}

// ---------- 截图目录滚动清理（每次 capture 后顺手清一次） ----------

function cleanupScreenshots() {
  try {
    const names = fs.readdirSync(ENV.screenshotDir).filter(function (n) { return /\.png$/i.test(n); });
    if (!names.length) return { removed: 0 };
    const now = Date.now();
    const maxAgeMs = Math.max(0, ENV.maxAgeHours) * 3600 * 1000;
    const entries = [];
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(ENV.screenshotDir, n));
        entries.push({ name: n, mtime: st.mtimeMs, size: st.size });
      } catch (e) { /* 竞态删除，忽略 */ }
    }
    let removed = 0;
    // 1) 超龄清理
    const keep = entries.filter(function (e) {
      if (maxAgeMs > 0 && now - e.mtime > maxAgeMs) {
        try { fs.unlinkSync(path.join(ENV.screenshotDir, e.name)); removed += 1; } catch (err) { /* 忽略 */ }
        return false;
      }
      return true;
    });
    // 2) 数量上限：按 mtime 新→旧保留 maxScreenshots 个
    keep.sort(function (a, b) { return b.mtime - a.mtime; });
    for (let i = ENV.maxScreenshots; i < keep.length; i++) {
      try { fs.unlinkSync(path.join(ENV.screenshotDir, keep[i].name)); removed += 1; } catch (err) { /* 忽略 */ }
    }
    return { removed: removed };
  } catch (e) {
    return { removed: 0, error: String(e && e.message ? e.message : e) };
  }
}

function textBlock(t) { return { type: "text", text: t }; }
function errResult(msg) { return { content: [textBlock(msg)], isError: true }; }

async function toolStatus() {
  const cdp = await cdpVersion();
  const win = { configured: Boolean(ENV.windowsUrl), reachable: false, detail: "" };
  if (ENV.windowsUrl) {
    try {
      const res = await windowsCall("ControlStatus", {}, 8000);
      win.reachable = !res.isError;
      const txt = (res.content || []).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join(" ");
      win.detail = txt.slice(0, 300);
    } catch (e) {
      win.detail = String(e && e.message ? e.message : e).slice(0, 200);
    }
  }
  const key = resolveVisionKey();
  const payload = {
    browser: {
      cdpPort: ENV.cdpPort,
      cdpAlive: Boolean(cdp),
      cdpBrowserVersion: cdp && cdp.Browser ? cdp.Browser : null,
      exe: ENV.browserExe,
      exeFound: Boolean(ENV.browserExe) && fs.existsSync(ENV.browserExe),
      profileDir: ENV.browserProfile
    },
    desktop: win,
    vision: { keyConfigured: Boolean(key), model: ENV.visionModel, baseURL: ENV.visionBaseUrl },
    screenshotDir: ENV.screenshotDir,
    screenshotPolicy: { maxScreenshots: ENV.maxScreenshots, maxAgeHours: ENV.maxAgeHours }
  };
  return { content: [textBlock(JSON.stringify(payload, null, 2))] };
}

async function toolLaunchBrowser(args) {
  if (!ENV.browserExe || !fs.existsSync(ENV.browserExe)) {
    return errResult("未找到浏览器可执行文件：" + (ENV.browserExe || "(空)") + "。请在插件配置里设置 browserExe。");
  }
  const url = (args && args.url) || ENV.startUrl || "";
  const alive = await cdpVersion();
  if (alive) {
    if (url) {
      const c = spawn(ENV.browserExe, ["--user-data-dir=" + ENV.browserProfile, url], { detached: true, stdio: "ignore" });
      c.unref();
    }
    return { content: [textBlock(JSON.stringify({
      alreadyRunning: true, openedUrl: url || null,
      cdp: "http://127.0.0.1:" + ENV.cdpPort,
      browser: alive.Browser || null,
      hint: "Playwright（mcp__browser__*）可直接接管；用户可在该窗口人工登录"
    }, null, 2))] };
  }
  const spawnArgs = [
    "--user-data-dir=" + ENV.browserProfile,
    "--remote-debugging-port=" + ENV.cdpPort,
    "--no-first-run",
    "--no-default-browser-check"
  ];
  if (url) spawnArgs.push(url);
  const c = spawn(ENV.browserExe, spawnArgs, { detached: true, stdio: "ignore" });
  c.unref();
  const ready = await waitCdp(20000);
  if (!ready) {
    return errResult("浏览器已启动（pid " + c.pid + "）但 CDP 端口 " + ENV.cdpPort + " 在 20 秒内未就绪。可能端口被占用或浏览器启动失败。");
  }
  return { content: [textBlock(JSON.stringify({
    started: true, pid: c.pid,
    cdp: "http://127.0.0.1:" + ENV.cdpPort,
    profileDir: ENV.browserProfile,
    openedUrl: url || null,
    hint: "浏览器已就绪；host 会在数秒内自动补挂 playwright-mcp（browser 面），随后即可使用 mcp__browser__* 工具。用户可在此窗口人工登录（登录态持久保存在专用 profile）"
  }, null, 2))] };
}

async function toolWakeDesktop() {
  const url = ENV.windowsUrl || ENV.windowsExpectUrl;
  if (!url) {
    return errResult("桌面面未配置：host 未注入 windows-mcp 地址（检查 desktopEnabled，或 windows-mcp 是否已安装：uv tool install windows-mcp --python 3.14）。");
  }
  const t0 = Date.now();
  let lastErr = "";
  while (Date.now() - t0 < 20000) {
    try {
      const res = await windowsCall("ControlStatus", {}, 3000);
      if (!res.isError) {
        const txt = (res.content || []).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join(" ");
        return { content: [textBlock(JSON.stringify({
          ok: true,
          waitedMs: Date.now() - t0,
          url: url,
          detail: txt.slice(0, 200),
          hint: "桌面服务已就绪：现在可以使用 mcp__desktop__* 工具（先 Snapshot 再操作；动作后重新 Snapshot 确认）。"
        }, null, 2))] };
      }
      lastErr = "ControlStatus 返回错误";
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
    }
    await new Promise(function (r) { setTimeout(r, 1000); });
  }
  return errResult("桌面服务 20 秒内未就绪（" + lastErr.slice(0, 160) + "）。host 可能仍在拉起 windows-mcp；可稍后再调 wake_desktop，或查看 /copilot 状态。");
}

async function toolStopBrowser() {
  const r = await stopBrowser();
  if (!r.ok) {
    return errResult("停止浏览器失败：CDP 关闭与进程树回收后浏览器仍在线，请手动检查（仅影响专用 profile 的浏览器）。via=" + r.via);
  }
  return { content: [textBlock(JSON.stringify(Object.assign({}, r, {
    hint: r.alreadyStopped
      ? "浏览器本就未运行"
      : "已停止（登录态保留在专用 profile，下次 launch_browser 无损恢复）；host 检测到 CDP 离线后会自动卸载 playwright-mcp 释放内存"
  }), null, 2))] };
}

async function toolCapture(args) {
  // 缺省 diskless=true（仅内存返回）；显式 diskless:false 才落盘
  const diskless = args && args.diskless !== undefined ? Boolean(args.diskless) : true;
  fs.mkdirSync(ENV.screenshotDir, { recursive: true });
  const source = (args && args.source) || "auto";
  let via = "";
  let summary = "";
  let b64 = "";
  let file = "";
  if (!diskless) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    file = path.join(ENV.screenshotDir, "copilot-" + stamp + ".png");
  }
  if (source !== "powershell" && ENV.windowsUrl) {
    try {
      const res = await windowsCall("Screenshot", {}, 30000);
      const blocks = (res && res.content) || [];
      const img = blocks.find(function (b) { return b.type === "image" && b.data; });
      const txt = blocks.filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("\n");
      if (img) {
        b64 = img.data;
        via = "windows-mcp";
        summary = txt.slice(0, 1500);
      } else if (source === "windows-mcp") {
        return errResult("windows-mcp 返回中没有图像块：" + txt.slice(0, 300));
      }
    } catch (e) {
      log("windows-mcp Screenshot 失败，准备兜底：", e && e.message ? e.message : e);
      if (source === "windows-mcp") return errResult("windows-mcp 截图失败：" + String(e && e.message ? e.message : e));
    }
  }
  if (!b64) {
    // PowerShell 通道必须先落盘再读；diskless 模式读完后删除临时文件
    const tmp = diskless ? path.join(ENV.screenshotDir, ".tmp-" + Date.now() + ".png") : file;
    try {
      await captureViaPowerShell(tmp);
      via = via || "powershell";
      b64 = fs.readFileSync(tmp).toString("base64");
      if (diskless) { try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ } }
    } catch (e) {
      return errResult("PowerShell 截图失败：" + String(e && e.message ? e.message : e));
    }
  } else if (!diskless) {
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
  }
  // 滚动清理：落盘与临时文件都顺手清一次
  const cleaned = cleanupScreenshots();
  const meta = {
    diskless: diskless,
    file: diskless ? null : file,
    via: via,
    bytes: Buffer.from(b64, "base64").length,
    cleanup: cleaned
  };
  if (summary) meta.desktopSummary = summary;
  return {
    content: [
      { type: "image", data: b64, mimeType: "image/png" },
      textBlock(JSON.stringify(meta, null, 2))
    ]
  };
}

async function toolVision(args) {
  const question = String((args && args.question) || "").trim();
  if (!question) return errResult("question 不能为空");
  const key = resolveVisionKey();
  if (!key) {
    return errResult("视觉模型 API key 未配置：host 未注入 COPILOT_VISION_API_KEY，且 ~/.dsh/.credentials.yaml 中未找到 ALIYUNBAILIAN_API_KEY。");
  }
  let b64 = "";
  let mime = "image/png";
  let from = "";
  if (args && args.imagePath) {
    const p = String(args.imagePath);
    if (!fs.existsSync(p)) return errResult("图片不存在：" + p);
    const ext = path.extname(p).toLowerCase();
    mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/png";
    b64 = fs.readFileSync(p).toString("base64");
    from = p;
  } else {
    // 识图场景默认 diskless：多数不需要落盘
    const cap = await toolCapture({ diskless: true });
    if (cap.isError) return cap;
    const img = cap.content.find(function (b) { return b.type === "image"; });
    if (!img) return errResult("截图失败：无图像块");
    b64 = img.data;
    from = "screenshot(diskless)";
  }
  const t0 = Date.now();
  let res;
  try {
    res = await fetchTimeout(ENV.visionBaseUrl.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({
        model: ENV.visionModel,
        stream: false,
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image_url", image_url: { url: "data:" + mime + ";base64," + b64 } }
          ]
        }]
      })
    }, ENV.visionTimeoutMs);
  } catch (e) {
    return errResult("视觉网关请求失败：" + String(e && e.message ? e.message : e));
  }
  const raw = await res.text();
  if (!res.ok) return errResult("视觉网关 HTTP " + res.status + "：" + raw.slice(0, 300));
  let j;
  try { j = JSON.parse(raw); } catch (e) { return errResult("视觉网关返回非 JSON：" + raw.slice(0, 200)); }
  const answer = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  return {
    content: [
      textBlock(answer),
      textBlock(JSON.stringify({ from: from, model: ENV.visionModel, elapsedMs: Date.now() - t0, usage: j.usage || null }))
    ]
  };
}

const TOOL_DEFS = [
  {
    name: "status",
    description: "dsh-copilot 状态自检：专用 Edge 的 CDP 是否在线、windows-mcp 桌面服务是否可达、视觉模型配置、截图目录。开始浏览器/桌面任务前建议先调用确认环境就绪。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "launch_browser",
    description: "启动（或复用已运行的）专用 profile Edge 浏览器，带远程调试端口，供 mcp__browser__*（Playwright）接管。浏览器工具报 CDP 连接失败时先调用本工具。用户在此浏览器中人工登录，登录态长期保留在专用 profile。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "可选：启动后打开的 URL" } },
      additionalProperties: false
    }
  },
  {
    name: "wake_browser",
    description: "同 launch_browser：启动（或复用）专用 Edge 并等待 CDP 就绪。浏览器面为懒挂载（DSH 启动时浏览器未开则不挂 playwright-mcp 以省内存），本工具就绪后 host 会在数秒内自动补挂 browser 面；期间报「工具不存在」属正常，稍候重试即可。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "可选：启动后打开的 URL" } },
      additionalProperties: false
    }
  },
  {
    name: "wake_desktop",
    description: "唤醒 Windows 桌面操控面（mcp__desktop__*）：host 会拉起 windows-mcp 并挂载工具面，本工具阻塞等待其就绪（最多 20 秒）。桌面面为门控懒挂载——mcp__desktop__* 不存在时先调本工具，就绪后再用 mcp__desktop__*。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "stop_browser",
    description: "停止专用 profile 的 Edge 浏览器（优先 CDP Browser.close 优雅关闭，失败按进程树精确回收——仅杀命令行含专用 profile 路径的进程，不影响用户正常浏览器）。用完浏览器后调用可立即释放内存；登录态保留，下次 launch_browser 无损恢复。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "capture",
    description: "全屏截图并返回图像（优先经 windows-mcp 附带窗口/光标摘要，不可用时 PowerShell .NET 兜底）。默认 diskless 仅内存返回；diskless=false 落盘到截图目录（带滚动清理：maxScreenshots/maxAgeHours）。用于给用户/模型看当前屏幕，或为 vision 工具取图。",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["auto", "windows-mcp", "powershell"], description: "截图通道，默认 auto（windows-mcp 优先）" },
        diskless: { type: "boolean", description: "默认 true：仅内存返回不落盘；false 则落盘（用于需要留存截图的场景）" }
      },
      additionalProperties: false
    }
  },
  {
    name: "vision",
    description: "识图问答：把当前屏幕截图（或指定图片文件）交给轻量视觉模型（默认 deepseek-v4.1-flash @ 你的 LLM 网关）并返回文字答案。比主模型便宜快速，适合「屏幕上是什么/这个值是多少/界面什么状态」类问题。截图默认不落盘。",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "针对图片的问题" },
        imagePath: { type: "string", description: "可选：图片文件路径；缺省则先全屏截图（diskless）" }
      },
      required: ["question"],
      additionalProperties: false
    }
  }
];

const server = new Server(
  { name: "copilot", version: "0.2.0" },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async function () {
  return { tools: TOOL_DEFS };
});

server.setRequestHandler(CallToolRequestSchema, async function (request) {
  const tn = request.params.name;
  const args = request.params.arguments || {};
  try {
    if (tn === "status") return await toolStatus();
    if (tn === "launch_browser") return await toolLaunchBrowser(args);
    if (tn === "wake_browser") return await toolLaunchBrowser(args);
    if (tn === "wake_desktop") return await toolWakeDesktop();
    if (tn === "stop_browser") return await toolStopBrowser();
    if (tn === "capture") return await toolCapture(args);
    if (tn === "vision") return await toolVision(args);
    return errResult("未知工具：" + tn);
  } catch (e) {
    log("工具异常:", tn, e);
    return errResult("工具执行异常：" + String(e && e.message ? e.message : e));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log("ready (pid " + process.pid + ", windowsUrl=" + (ENV.windowsUrl || "(未配置)") + ", cdpPort=" + ENV.cdpPort + ", maxScreenshots=" + ENV.maxScreenshots + ", maxAgeHours=" + ENV.maxAgeHours + ")");
