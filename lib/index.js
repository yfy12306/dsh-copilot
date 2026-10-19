/**
 * dsh-copilot（host 半）：给 DSH 装上「浏览器 + Windows 桌面」操控能力（Codex computer-use 等价）。
 *
 * 三个 MCP 工具面（全部经 @deepseek-ai/dsh-mcp-client 挂载，模型侧名称 mcp__<server>__<tool>）：
 *   browser → @playwright/mcp（stdio）：CDP 接管「专用 profile」Edge，a11y 树结构化操控网页
 *             【懒挂载】DSH 启动时探测 CDP，离线则不挂（0 进程 0 工具）；CDP 上线后自动补挂，
 *             掉线后自动卸载。工具目录经 --config capabilities 白名单收窄（core 操控系列），
 *             另传 --idle-timeout 让 playwright-mcp 空闲自关浏览器（尽力而为，host 侧兜底）。
 *   desktop → windows-mcp（常驻 streamable-http 实例，本插件监督进程）：UIA 树 + 截图 + 鼠标键盘 + 控制权接管
 *             【启动竞争修复】挂面前等待端口就绪，避免「mcp-client(desktop): startup failed: fetch failed」。
 *   copilot → 本插件桥接 server（stdio）：status / launch_browser / wake_browser / stop_browser /
 *             capture（diskless + 滚动清理）/ vision 识图（deepseek-v4.1-flash）
 *
 * host 职责：
 *   1) 孤儿治理：启动时按命令行特征回收上一轮遗留的 bridge / playwright-mcp 子进程（防双实例累积）
 *   2) 浏览器生命周期：launch / stop（CDP Browser.close 优雅关闭 → 进程树精确回收兜底）/
 *      空闲自动回收（idleTimeoutMinutes）/ dispose 策略（shutdownPolicy: keep|stop，默认 keep）
 *   3) windows-mcp 常驻进程监督（随机 Bearer key、崩溃指数退避重启、dispose 清理）
 *   4) 同源路由 /copilot/*（status、launch-browser、stop-browser、screenshot、desktop-control）供 client UI 使用，仅回环
 *   5) /copilot 斜杠命令：状态自检文本
 *   6) 凭据解析：视觉 key 经 ctx.credentials（host 侧），失败回退读 ~/.dsh/.credentials.yaml；key 永不打日志
 *
 * 挂载方式与 serena-mcp.mjs / voice-input 相同，零改 DSH 核心。
 */
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";

const nativeRequire = createRequire(fs.realpathSync(fileURLToPath(import.meta.url)));

const name = "dsh-copilot";
const inject = ["webServer", "commands"];

const DEFAULT_TOOLS =
  "Screenshot,Snapshot,Click,Type,Scroll,Move,Shortcut,Wait,WaitFor,ControlStatus," +
  "DisplayInventory,App,PowerShell,FileSystem,Scrape,MultiSelect,MultiEdit,Clipboard";

/** playwright-mcp 工具白名单（capabilities 分组，见 @playwright/mcp 0.0.83 config.d.ts）：
 *  只保留浏览器操控必需项；network 拦截 / storage / pdf / devtools / testing / install 均不启用。 */
const PW_CAPABILITIES = ["core", "core-navigation", "core-tabs", "core-input"];

const DEFAULTS = {
  browserEnabled: true,
  browserChannel: "msedge",
  browserExe: "",
  browserProfileDir: "",
  browserCdpPort: 9222,
  browserStartUrl: "",
  idleTimeoutMinutes: 15,
  shutdownPolicy: "keep",
  desktopEnabled: true,
  desktopExe: "",
  desktopPort: 8765,
  desktopTools: DEFAULT_TOOLS,
  desktopControlPolicy: "relaxed",
  desktopIdleTimeout: 10,
  desktopLazy: true,
  desktopIdleReclaimMinutes: 0,
  skillEnabled: true,
  visionEnabled: true,
  visionBaseURL: "https://your-llm-gateway.example.com/v1",
  visionModel: "deepseek-v4.1-flash-aliyunbailian",
  visionApiKeyEnv: "ALIYUNBAILIAN_API_KEY",
  visionTimeoutMs: 90000,
  bridgeEnabled: true,
  nodeExe: "",
  screenshotDir: "",
  maxScreenshots: 50,
  maxAgeHours: 72,
  routePrefix: "/copilot",
  toolCallTimeoutMs: 120000
};

const Config = z.object({
  browserEnabled: z.boolean().default(true),
  browserChannel: z.string().default("msedge"),
  browserExe: z.string().default(""),
  browserProfileDir: z.string().default(""),
  browserCdpPort: z.number().default(9222),
  browserStartUrl: z.string().default(""),
  idleTimeoutMinutes: z.number().default(15),
  shutdownPolicy: z.string().default("keep"),
  desktopEnabled: z.boolean().default(true),
  desktopExe: z.string().default(""),
  desktopPort: z.number().default(8765),
  desktopTools: z.string().default(DEFAULT_TOOLS),
  desktopControlPolicy: z.string().default("relaxed"),
  desktopIdleTimeout: z.number().default(10),
  desktopLazy: z.boolean().default(true),
  desktopIdleReclaimMinutes: z.number().default(0),
  skillEnabled: z.boolean().default(true),
  visionEnabled: z.boolean().default(true),
  visionBaseURL: z.string().default("https://your-llm-gateway.example.com/v1"),
  visionModel: z.string().default("deepseek-v4.1-flash-aliyunbailian"),
  visionApiKeyEnv: z.string().default("ALIYUNBAILIAN_API_KEY"),
  visionTimeoutMs: z.number().default(90000),
  bridgeEnabled: z.boolean().default(true),
  nodeExe: z.string().default(""),
  screenshotDir: z.string().default(""),
  maxScreenshots: z.number().default(50),
  maxAgeHours: z.number().default(72),
  routePrefix: z.string().default("/copilot"),
  toolCallTimeoutMs: z.number().default(120000)
});

// ---------- 探测工具 ----------

function detectBrowserExe(channel) {
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const cands =
    channel === "chrome"
      ? [pf + "\\Google\\Chrome\\Application\\chrome.exe", pf86 + "\\Google\\Chrome\\Application\\chrome.exe"]
      : [pf86 + "\\Microsoft\\Edge\\Application\\msedge.exe", pf + "\\Microsoft\\Edge\\Application\\msedge.exe"];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* 忽略 */ }
  }
  return "";
}

function detectWindowsMcpExe(home) {
  const cands = [
    path.join(home, ".local", "bin", "windows-mcp.exe"),
    path.join(home, ".dsh", "windows-mcp-env", "Scripts", "windows-mcp.exe")
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* 忽略 */ }
  }
  return cands[0];
}

function detectNodeExe() {
  try {
    const r = spawnSync("where.exe", ["node"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
    const first = String(r.stdout || "").split(/\r?\n/)[0].trim();
    if (first && fs.existsSync(first)) return first;
  } catch (e) { /* 忽略 */ }
  const guess = "C:\\Program Files\\nodejs\\node.exe";
  try { if (fs.existsSync(guess)) return guess; } catch (e) { /* 忽略 */ }
  return "node";
}

function resolvePlaywrightCli() {
  try {
    const pkgPath = nativeRequire.resolve("@playwright/mcp/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    let bin = "";
    if (typeof pkg.bin === "string") bin = pkg.bin;
    else if (pkg.bin && typeof pkg.bin === "object") {
      bin = pkg.bin.mcp || pkg.bin["playwright-mcp"] || Object.values(pkg.bin)[0] || "";
    }
    if (bin) return path.resolve(path.dirname(pkgPath), bin);
  } catch (e) { /* 忽略 */ }
  return "";
}

function readKeyFromCredentialsFile(envName) {
  try {
    const t = fs.readFileSync(path.join(os.homedir(), ".dsh", ".credentials.yaml"), "utf8");
    const re = new RegExp(envName + "\\s*:\\s*\"?([^\"\\n,}]+)\"?");
    const m = re.exec(t);
    if (m) return m[1].trim();
  } catch (e) { /* 忽略 */ }
  return "";
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

async function probeJson(url, ms) {
  try {
    const r = await fetchTimeout(url, { method: "GET" }, ms);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

function portFree(port) {
  return new Promise(function (resolve) {
    const srv = net.createServer();
    srv.once("error", function () { resolve(false); });
    srv.once("listening", function () { srv.close(function () { resolve(true); }); });
    srv.listen(port, "127.0.0.1");
  });
}

/** TCP 端口是否可连（用于等服务就绪，区别于 portFree 的「端口空闲」）。 */
function portReachable(port, timeoutMs) {
  return new Promise(function (resolve) {
    const socket = new net.Socket();
    const done = function (ok) {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs || 1500);
    socket.once("connect", function () { done(true); });
    socket.once("timeout", function () { done(false); });
    socket.once("error", function () { done(false); });
    socket.connect(port, "127.0.0.1");
  });
}

async function findFreePort(start, count) {
  for (let p = start; p < start + count; p++) {
    if (await portFree(p)) return p;
  }
  return -1;
}

// ---------- HTTP 路由小件（与 voice-input 同款） ----------

function isLoopbackAddr(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr === undefined;
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

// ---------- PowerShell 辅助（-EncodedCommand 避免引号地狱） ----------

function runPowerShellEncoded(script, timeoutMs) {
  return new Promise(function (resolve) {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true });
    } catch (e) { resolve({ code: -1, stdout: "", error: String(e) }); return; }
    let so = "";
    let se = "";
    const timer = setTimeout(function () { try { child.kill(); } catch (e) { /* 忽略 */ } }, timeoutMs || 15000);
    child.stdout.on("data", function (d) { so += d; });
    child.stderr.on("data", function (d) { se += d; });
    child.on("error", function (e) { clearTimeout(timer); resolve({ code: -1, stdout: so, error: String(e) }); });
    child.on("close", function (code) { clearTimeout(timer); resolve({ code: code, stdout: so, stderr: se }); });
  });
}

// ---------- 孤儿治理：回收上一轮遗留的 bridge / playwright-mcp / windows-mcp 子进程 ----------
// 按命令行特征精确匹配本插件路径（node.exe + dsh-copilot\bridge\server.mjs 或 dsh-copilot\...\@playwright\mcp\cli.js；
// python.exe/windows-mcp.exe + 本插件生成的 ~/.dsh/copilot/windows-mcp.toml 配置路径）。
// 注意：若同时运行多个 DSH 实例（罕见），后启动的会回收先启动实例的这几类子进程——属预期行为。
function reapOrphanChildren(pluginDir) {
  return new Promise(function (resolve) {
    // 命令行 -like 通配匹配（路径含 \ 需转义为 \\ 供通配符语义使用）
    const m1 = path.join(pluginDir, "bridge", "server.mjs").replace(/'/g, "''").replace(/\\/g, "\\");
    const m2 = path.join(pluginDir, "node_modules", "@playwright", "mcp", "cli.js").replace(/'/g, "''").replace(/\\/g, "\\");
    const toml = path.join(os.homedir(), ".dsh", "copilot", "windows-mcp.toml").replace(/'/g, "''").replace(/\\/g, "\\");
    const simple =
      "$m1 = '*" + m1 + "*'; " +
      "$m2 = '*" + m2 + "*'; " +
      "$m3 = '*" + toml + "*'; " +
      "$nodeHits = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and ($_.CommandLine -like $m1 -or $_.CommandLine -like $m2) }; " +
      "$winHits = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('python.exe','pythonw.exe','windows-mcp.exe') -and $_.CommandLine -and ($_.CommandLine -like '*windows-mcp*' -and $_.CommandLine -like $m3) }; " +
      "$killed = 0; foreach ($p in ($nodeHits + $winHits)) { taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null; $killed++ }; " +
      "Write-Output $killed";
    runPowerShellEncoded(simple, 20000).then(function (r) {
      const n = parseInt(String(r.stdout || "").trim(), 10);
      resolve(Number.isFinite(n) ? n : 0);
    });
  });
}

// ---------- windows-mcp 常驻监督 ----------

function createDesktopSupervisor(cfg, desktopExe) {
  const state = {
    child: null,
    port: 0,
    key: crypto.randomBytes(24).toString("base64url"),
    restarts: 0,
    stopped: false,
    givingUp: false,
    timer: null,
    lastError: ""
  };

  function buildEnv() {
    return {
      ANONYMIZED_TELEMETRY: "false",
      WINDOWS_MCP_AUTH_KEY: state.key,
      PATH: process.env.PATH || "",
      SystemRoot: process.env.SystemRoot || "C:\\Windows",
      USERPROFILE: process.env.USERPROFILE || os.homedir(),
      APPDATA: process.env.APPDATA || "",
      LOCALAPPDATA: process.env.LOCALAPPDATA || "",
      TEMP: process.env.TEMP || "",
      TMP: process.env.TMP || process.env.TEMP || "",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1"
    };
  }

  function writeConfigFile() {
    const dir = path.join(os.homedir(), ".dsh", "copilot");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "windows-mcp.toml");
    // 说明：windows-mcp 0.8.8 的 [control] 仅识别 mouse_takeover_units / mouse_takeover_pixels；
    // 早期版本写入的 policy / idle_timeout_seconds / enabled 是无效键（进程不会按空闲自退出），
    // 故不再写入。desktopControlPolicy / desktopIdleTimeout 配置项保留仅为兼容旧配置，当前无副作用。
    const lines = [
      "# 由 dsh-copilot 生成；auth_key 经环境变量 WINDOWS_MCP_AUTH_KEY 注入，不落盘",
      "[server]",
      'transport = "streamable-http"',
      'host = "127.0.0.1"',
      "port = " + state.port,
      "",
      "[control]",
      "mouse_takeover_units = 120",
      "mouse_takeover_pixels = 120"
    ];
    fs.writeFileSync(file, lines.join("\n"), "utf8");
    return file;
  }

  function spawnOnce() {
    if (state.stopped || state.givingUp) return;
    const args = [
      "serve",
      "--config", writeConfigFile(),
      "--tools", cfg.desktopTools
    ];
    let child;
    try {
      child = spawn(desktopExe, args, { env: buildEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      state.lastError = String(e && e.message ? e.message : e);
      console.warn("[dsh-copilot] windows-mcp spawn 失败:", state.lastError);
      scheduleRestart();
      return;
    }
    state.child = child;
    let stderrTail = "";
    child.stderr.on("data", function (d) { stderrTail = (stderrTail + d).slice(-2000); });
    child.stdout.on("data", function () { /* 丢弃，避免管道阻塞 */ });
    child.on("error", function (e) {
      state.lastError = String(e && e.message ? e.message : e);
      console.warn("[dsh-copilot] windows-mcp 进程错误:", state.lastError);
    });
    child.on("exit", function (code, signal) {
      state.child = null;
      if (state.stopped) return;
      state.lastError = "exit code=" + code + " signal=" + signal + " stderr:" + stderrTail.slice(-300);
      console.warn("[dsh-copilot] windows-mcp 退出（" + state.lastError.slice(0, 200) + "）");
      scheduleRestart();
    });
  }

  function scheduleRestart() {
    if (state.stopped || state.givingUp) return;
    state.restarts += 1;
    if (state.restarts > 8) {
      state.givingUp = true;
      console.warn("[dsh-copilot] windows-mcp 连续重启超限，放弃；可用 POST " + cfg.routePrefix + "/desktop-control {action:restart} 重试");
      return;
    }
    const delay = Math.min(500 * Math.pow(2, state.restarts - 1), 15000);
    state.timer = setTimeout(function () { state.timer = null; spawnOnce(); }, delay);
  }

  /** 等端口就绪（python 启动需数秒），就绪后再挂 mcp-client 面，消除启动竞争。 */
  async function waitReady(timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || 15000)) {
      if (state.child && await portReachable(state.port, 1000)) return true;
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    return false;
  }

  return {
    state: state,
    url: function () { return "http://127.0.0.1:" + state.port + "/mcp/"; },
    waitReady: waitReady,
    start: async function (preferredPort) {
      const p = await findFreePort(preferredPort, 20);
      if (p < 0) throw new Error("8765 起 20 个端口均被占用");
      state.port = p;
      state.stopped = false;
      state.givingUp = false;
      state.restarts = 0;
      spawnOnce();
      return p;
    },
    stop: function () {
      state.stopped = true;
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      if (state.child) {
        // Windows 下 child.kill() 只终止直接子进程（venv python 启动器），
        // 其再派生的工作进程会成孤儿——改用 taskkill /T 树杀整个进程树
        try {
          spawnSync("taskkill", ["/PID", String(state.child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 });
        } catch (e) { /* 忽略 */ }
        try { state.child.kill(); } catch (e) { /* 忽略 */ }
      }
    },
    restart: async function (preferredPort) {
      this.stop();
      await new Promise(function (r) { setTimeout(r, 300); });
      const p = await this.start(preferredPort || state.port || cfg.desktopPort);
      await waitReady(15000);
      return p;
    }
  };
}

// ---------- 浏览器启动 / 停止（host 侧，与 bridge 同逻辑） ----------

function launchBrowserProcess(browserExe, profileDir, cdpPort, url) {
  const args = [
    "--user-data-dir=" + profileDir,
    "--remote-debugging-port=" + cdpPort,
    "--no-first-run",
    "--no-default-browser-check"
  ];
  if (url) args.push(url);
  const child = spawn(browserExe, args, { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

async function waitCdpAlive(cdpPort, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await probeJson("http://127.0.0.1:" + cdpPort + "/json/version", 1500);
    if (v) return v;
    await new Promise(function (r) { setTimeout(r, 500); });
  }
  return null;
}

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
    ws.onclose = function () { clearTimeout(timer); done(true); };
    ws.onerror = function () { clearTimeout(timer); done(false); };
    ws.onmessage = function () { /* Browser.close 正常不回包，忽略 */ };
  });
}

/** 按命令行特征精确回收「专用 profile」浏览器进程树（绝不碰用户正常浏览器）。 */
function killBrowserProcessTree(browserExe, profileDir) {
  return new Promise(function (resolve) {
    if (!profileDir) { resolve(0); return; }
    const exeName = browserExe ? path.basename(browserExe) : "msedge.exe";
    const script =
      "$profile = [System.IO.Path]::GetFullPath('" + profileDir.replace(/'/g, "''") + "'); " +
      "$procs = Get-CimInstance Win32_Process -Filter \"Name='" + exeName + "'\" | " +
      "Where-Object { $_.CommandLine -and ($_.CommandLine -like ('*' + $profile + '*')) }; " +
      "$killed = 0; foreach ($p in $procs) { taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null; $killed++ }; " +
      "Write-Output $killed";
    runPowerShellEncoded(script, 20000).then(function (r) {
      const n = parseInt(String(r.stdout || "").trim(), 10);
      resolve(Number.isFinite(n) ? n : -1);
    });
  });
}

// ---------- 截图目录滚动清理（与 bridge 同逻辑，供 UI 截图路由使用） ----------

function cleanupScreenshots(dir, maxScreenshots, maxAgeHours) {
  try {
    const names = fs.readdirSync(dir).filter(function (n) { return /\.png$/i.test(n); });
    if (!names.length) return { removed: 0 };
    const now = Date.now();
    const maxAgeMs = Math.max(0, maxAgeHours) * 3600 * 1000;
    const entries = [];
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(dir, n));
        entries.push({ name: n, mtime: st.mtimeMs });
      } catch (e) { /* 竞态删除，忽略 */ }
    }
    let removed = 0;
    let expired = 0;
    const keep = entries.filter(function (e) {
      if (maxAgeMs > 0 && now - e.mtime > maxAgeMs) {
        expired += 1;
        try { fs.unlinkSync(path.join(dir, e.name)); removed += 1; } catch (err) { /* 忽略 */ }
        return false;
      }
      return true;
    });
    keep.sort(function (a, b) { return b.mtime - a.mtime; });
    for (let i = maxScreenshots; i < keep.length; i++) {
      try { fs.unlinkSync(path.join(dir, keep[i].name)); removed += 1; } catch (err) { /* 忽略 */ }
    }
    return { removed: removed, debug: { names: names.length, entries: entries.length, expired: expired, kept: keep.length, maxAgeMs: maxAgeMs, now: now, sample: entries.length ? { name: entries[0].name, mtime: entries[0].mtime } : null } };
  } catch (e) {
    return { removed: 0, error: String(e && e.message ? e.message : e) };
  }
}

// ---------- PowerShell 截图（UI 预览用） ----------

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
    } catch (e) { reject(e); return; }
    let se = "";
    child.stderr.on("data", function (d) { se += d; });
    child.stdout.on("data", function () {});
    child.on("error", reject);
    child.on("close", function (code) {
      if (code === 0 && fs.existsSync(outPath)) resolve();
      else reject(new Error("powershell exit " + code + " " + se.slice(0, 200)));
    });
  });
}

// ---------- 插件主体 ----------

async function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  const home = os.homedir();
  const pluginDir = path.dirname(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))));

  const browserProfile = cfg.browserProfileDir || path.join(home, ".dsh", "browser-profile");
  const screenshotDir = cfg.screenshotDir || path.join(home, ".dsh", "copilot-screenshots");
  try { fs.mkdirSync(browserProfile, { recursive: true }); } catch (e) { /* 忽略 */ }
  try { fs.mkdirSync(screenshotDir, { recursive: true }); } catch (e) { /* 忽略 */ }

  const browserExe = cfg.browserExe || detectBrowserExe(cfg.browserChannel);
  const nodeExe = cfg.nodeExe || detectNodeExe();
  const desktopExe = cfg.desktopExe || detectWindowsMcpExe(home);
  const playwrightCli = resolvePlaywrightCli();
  const bridgeScript = path.join(pluginDir, "bridge", "server.mjs");

  // ---- 孤儿治理：回收上一轮遗留的 bridge / playwright-mcp 子进程（在自己 spawn 之前） ----
  try {
    const reaped = await reapOrphanChildren(pluginDir);
    if (reaped > 0) console.info("[dsh-copilot] 已回收上一轮遗留子进程 " + reaped + " 个");
  } catch (e) {
    console.warn("[dsh-copilot] 孤儿治理扫描失败（忽略）：", String(e && e.message ? e.message : e));
  }

  // 视觉 key：ctx.credentials 优先，回退凭据文件（key 永不打印）
  let visionKey = "";
  try {
    const credentials = ctx.credentials ?? ctx[Symbol.for("cordis.inject")]?.credentials;
    if (credentials && typeof credentials.resolve === "function") {
      const record = await credentials.resolve(cfg.visionApiKeyEnv);
      visionKey = (record && record.value) || "";
    }
  } catch (e) {
    console.warn("[dsh-copilot] ctx.credentials 解析失败，回退凭据文件：", String(e && e.message ? e.message : e));
  }
  if (!visionKey) visionKey = readKeyFromCredentialsFile(cfg.visionApiKeyEnv);

  // ---- desktop 面：门控懒挂载 ----
  // 激活入口三选一：① 模型加载 dsh-copilot Skill（tools/result 监听）② mcp__copilot__wake_desktop
  // ③ UI 芯片「启动桌面服务」按钮。desktopLazy=false 时回退为启动即常驻（旧行为）。
  // 激活后默认常驻（desktopIdleReclaimMinutes=0，看桌面要即时响应）；
  // 配置为正数时空闲 N 分钟自动卸载回收（下次 wake 再拉起）。
  const sup = createDesktopSupervisor(cfg, desktopExe);
  const desktopExeFound = fs.existsSync(desktopExe);
  const desktopFace = {
    fiber: null,
    mounted: false,
    mounting: false,
    lazy: Boolean(cfg.desktopLazy),
    expectedPort: 0,
    lastActivityAt: Date.now()
  };

  // lazy 模式：预占端口（只探测不 spawn），让 bridge 的 wake_desktop 能轮询预期地址、host 挂载时复用同端口
  if (cfg.desktopEnabled && desktopExeFound && desktopFace.lazy) {
    try { desktopFace.expectedPort = await findFreePort(cfg.desktopPort, 20); } catch (e) { /* 忽略 */ }
  }
  function desktopExpectUrl() {
    return desktopFace.expectedPort ? "http://127.0.0.1:" + desktopFace.expectedPort + "/mcp/" : "";
  }

  async function mountDesktopFace(reason) {
    if (desktopFace.mounted || desktopFace.mounting) return desktopFace.mounted;
    if (!cfg.desktopEnabled || !desktopExeFound) return false;
    desktopFace.mounting = true;
    try {
      const port = await sup.start(desktopFace.expectedPort || cfg.desktopPort);
      desktopFace.expectedPort = port;
      const ready = await sup.waitReady(15000);
      if (!ready) console.warn("[dsh-copilot] windows-mcp 端口 " + port + " 15 秒内未就绪，仍尝试挂载（mcp-client 自带重连兜底）");
      const fiber = ctx.plugin(mcpClient, {
        transport: "streamable-http",
        serverName: "desktop",
        url: sup.url(),
        headers: { Authorization: "Bearer " + sup.state.key },
        toolCallTimeoutMs: cfg.toolCallTimeoutMs,
        failOnStartupError: false
      });
      await fiber;
      desktopFace.fiber = fiber;
      desktopFace.mounted = true;
      desktopFace.lastActivityAt = Date.now();
      console.info("[dsh-copilot] desktop 面已挂载（" + reason + "）：windows-mcp @ 127.0.0.1:" + port + "（就绪等待 " + (ready ? "通过" : "超时") + "）");
      return true;
    } catch (e) {
      console.warn("[dsh-copilot] desktop 面挂载失败（" + reason + "）：", String(e && e.message ? e.message : e));
      return false;
    } finally {
      desktopFace.mounting = false;
    }
  }

  async function unmountDesktopFace(reason) {
    if (!desktopFace.mounted || !desktopFace.fiber) return;
    desktopFace.mounted = false;
    const fiber = desktopFace.fiber;
    desktopFace.fiber = null;
    try { await fiber.dispose(); } catch (e) { /* 忽略 */ }
    sup.stop();
    try { desktopFace.expectedPort = await findFreePort(cfg.desktopPort, 20); } catch (e) { /* 忽略 */ }
    console.info("[dsh-copilot] desktop 面已卸载（" + reason + "）");
  }

  /** 唤醒桌面面（幂等）；bridge 的 wake_desktop 工具与 Skill 加载都会走到这里。 */
  async function wakeDesktop(reason) {
    if (!cfg.desktopEnabled) return { ok: false, port: sup.state.port, error: "桌面面未启用（desktopEnabled=false）" };
    if (!desktopExeFound) return { ok: false, port: sup.state.port, error: "windows-mcp 未安装（探测了 ~/.local/bin 与 ~/.dsh/windows-mcp-env/Scripts）" };
    const ok = await mountDesktopFace(reason || "wake");
    return { ok: ok, port: sup.state.port };
  }

  if (cfg.desktopEnabled && desktopExeFound) {
    if (desktopFace.lazy) {
      console.info("[dsh-copilot] desktop 面门控懒挂载：模型加载 dsh-copilot Skill / 调用 wake_desktop / UI 按钮后拉起 windows-mcp（预期端口 " + (desktopFace.expectedPort || "?") + "）");
    } else {
      await mountDesktopFace("startup");
    }
  } else if (cfg.desktopEnabled) {
    console.warn("[dsh-copilot] 未找到 windows-mcp（探测了 ~/.local/bin 与 ~/.dsh/windows-mcp-env/Scripts）。安装见插件 README：uv tool install windows-mcp --python 3.14（EDR 拦 Temp 时用 uv venv --seed + pip 方案）");
  }

  // ---- browser 面：懒挂载（CDP 离线不挂，上线自动补挂，掉线自动卸载） ----
  // playwright-mcp 启动参数收窄：--config 携带 capabilities 白名单 + webmcp:false；
  // --idle-timeout 让 playwright-mcp 在无工具调用 N 毫秒后自行关闭浏览器（尽力而为，host 侧 idle 兜底补刀）。
  const browserFace = { fiber: null, mounted: false, mounting: false, lastStopReason: "", lastActivityAt: Date.now() };

  function writePlaywrightConfig() {
    const dir = path.join(home, ".dsh", "copilot");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "playwright-mcp.config.json");
    const conf = {
      browser: {
        cdpEndpoint: "http://127.0.0.1:" + cfg.browserCdpPort,
        cdpTimeout: 20000
      },
      capabilities: PW_CAPABILITIES,
      webmcp: false
    };
    fs.writeFileSync(file, JSON.stringify(conf, null, 2), "utf8");
    return file;
  }

  async function mountBrowserFace() {
    if (browserFace.mounted || browserFace.mounting) return;
    if (!playwrightCli || !fs.existsSync(playwrightCli)) return;
    browserFace.mounting = true;
    try {
      const pwConfigFile = writePlaywrightConfig();
      const idleMs = Math.max(0, cfg.idleTimeoutMinutes) * 60 * 1000;
      const args = [playwrightCli, "--config", pwConfigFile];
      // playwright-mcp 自带空闲回收：N 毫秒无完成的工具调用即关浏览器（0 = 禁用）
      if (idleMs > 0) args.push("--idle-timeout", String(idleMs));
      const fiber = ctx.plugin(mcpClient, {
        transport: "stdio",
        serverName: "browser",
        command: nodeExe,
        args: args,
        env: {},
        toolCallTimeoutMs: cfg.toolCallTimeoutMs,
        failOnStartupError: false
      });
      await fiber;
      browserFace.fiber = fiber;
      browserFace.mounted = true;
      browserFace.lastActivityAt = Date.now();
      console.info("[dsh-copilot] browser 面已挂载：playwright-mcp → CDP 127.0.0.1:" + cfg.browserCdpPort + "（capabilities: " + PW_CAPABILITIES.join(",") + "）");
    } catch (e) {
      console.warn("[dsh-copilot] browser 面挂载失败：", String(e && e.message ? e.message : e));
    } finally {
      browserFace.mounting = false;
    }
  }

  async function unmountBrowserFace() {
    if (!browserFace.mounted || !browserFace.fiber) return;
    browserFace.mounted = false;
    const fiber = browserFace.fiber;
    browserFace.fiber = null;
    try {
      await fiber.dispose();
      console.info("[dsh-copilot] browser 面已卸载（playwright-mcp 进程回收）");
    } catch (e) {
      console.warn("[dsh-copilot] browser 面卸载失败（忽略）：", String(e && e.message ? e.message : e));
    }
  }

  /** 停止专用浏览器：CDP Browser.close 优雅 → 进程树精确回收兜底 → 卸载 browser 面。 */
  async function stopBrowser(reason) {
    const before = await probeJson("http://127.0.0.1:" + cfg.browserCdpPort + "/json/version", 1500);
    if (!before) {
      browserFace.lastStopReason = browserFace.lastStopReason || reason;
      await unmountBrowserFace();
      return { ok: true, alreadyStopped: true, via: "none" };
    }
    let via = "";
    const wsUrl = before.webSocketDebuggerUrl || ("ws://127.0.0.1:" + cfg.browserCdpPort + "/devtools/browser");
    const graceful = await cdpBrowserClose(wsUrl, 5000);
    if (graceful) {
      for (let i = 0; i < 10; i++) {
        if (!(await probeJson("http://127.0.0.1:" + cfg.browserCdpPort + "/json/version", 1000))) break;
        await new Promise(function (r) { setTimeout(r, 500); });
      }
      via = "cdp";
    }
    if (await probeJson("http://127.0.0.1:" + cfg.browserCdpPort + "/json/version", 1500)) {
      const killed = await killBrowserProcessTree(browserExe, browserProfile);
      via = "process-tree(killed " + killed + ")";
      for (let i = 0; i < 10; i++) {
        if (!(await probeJson("http://127.0.0.1:" + cfg.browserCdpPort + "/json/version", 1000))) break;
        await new Promise(function (r) { setTimeout(r, 500); });
      }
    }
    const stopped = !(await probeJson("http://127.0.0.1:" + cfg.browserCdpPort + "/json/version", 1500));
    browserFace.lastStopReason = reason;
    await unmountBrowserFace();
    console.info("[dsh-copilot] 浏览器已停止（reason=" + reason + ", via=" + via + "）");
    return { ok: stopped, via: via || "cdp", browser: before.Browser || null };
  }

  // 启动探测：CDP 在线才立即挂载；离线走 poller 懒补挂
  const cdpAliveAtBoot = await probeJson("http://127.0.0.1:" + cfg.browserCdpPort + "/json/version", 1500);
  const browserFaceAvailable = Boolean(cfg.browserEnabled && playwrightCli && fs.existsSync(playwrightCli));
  if (!browserFaceAvailable && cfg.browserEnabled) {
    console.warn("[dsh-copilot] 未解析到 @playwright/mcp cli（在插件目录执行 npm install 后重启 DSH）");
  }
  if (browserFaceAvailable && cdpAliveAtBoot) {
    await mountBrowserFace();
  } else if (browserFaceAvailable) {
    console.info("[dsh-copilot] browser 面懒挂载：CDP 离线，playwright-mcp 暂不启动（wake_browser / UI 按钮启动浏览器后自动补挂）");
  }

  // 周期监督（10s）：CDP 上线→补挂；掉线→卸载；空闲超时→自动回收；desktop 面同理（按配置）
  let browserPollTimer = null;
  if (browserFaceAvailable || cfg.desktopIdleReclaimMinutes > 0) {
    browserPollTimer = setInterval(function () {
      Promise.resolve().then(async function () {
        // desktop 面空闲回收（默认关闭，desktopIdleReclaimMinutes=0 时跳过）
        if (desktopFace.mounted && cfg.desktopIdleReclaimMinutes > 0) {
          const dIdleMs = Date.now() - desktopFace.lastActivityAt;
          if (dIdleMs > cfg.desktopIdleReclaimMinutes * 60 * 1000) {
            console.info("[dsh-copilot] 桌面面空闲 " + Math.round(dIdleMs / 60000) + " 分钟，自动卸载");
            await unmountDesktopFace("idle");
          }
        }
        if (!browserFaceAvailable) return;
        const alive = await probeJson("http://127.0.0.1:" + cfg.browserCdpPort + "/json/version", 1500);
        if (alive && !browserFace.mounted) {
          await mountBrowserFace();
        } else if (!alive && browserFace.mounted) {
          console.info("[dsh-copilot] 检测到 CDP 离线，卸载 browser 面");
          await unmountBrowserFace();
        } else if (alive && cfg.idleTimeoutMinutes > 0) {
          // host 侧空闲兜底：距上次浏览器活动（含每次 mcp__browser__* 调用刷新）超过 idleTimeoutMinutes 即回收
          // （playwright-mcp 的 --idle-timeout 通常已先行关闭浏览器；此兜底覆盖面未挂载/异常路径）
          const idleMs = Date.now() - browserFace.lastActivityAt;
          if (idleMs > cfg.idleTimeoutMinutes * 60 * 1000) {
            console.info("[dsh-copilot] 浏览器空闲 " + Math.round(idleMs / 60000) + " 分钟，自动回收");
            await stopBrowser("idle");
          }
        }
      }).catch(function (e) {
        console.warn("[dsh-copilot] 监督周期异常（忽略）：", String(e && e.message ? e.message : e));
      });
    }, 10000);
    if (browserPollTimer.unref) browserPollTimer.unref();
  }

  // ---- copilot 面：桥接 server ----
  let bridgeMounted = false;
  if (cfg.bridgeEnabled && fs.existsSync(bridgeScript)) {
    try {
      ctx.plugin(mcpClient, {
        transport: "stdio",
        serverName: "copilot",
        command: nodeExe,
        args: [bridgeScript],
        env: {
          // URL 用「预期地址」：desktop 懒挂载时 windows-mcp 尚未启动，bridge 的 wake_desktop 靠它轮询就绪
          COPILOT_WINDOWS_MCP_URL: sup.state.port ? sup.url() : desktopExpectUrl(),
          COPILOT_WINDOWS_MCP_EXPECT_URL: desktopExpectUrl(),
          COPILOT_WINDOWS_MCP_KEY: sup.state.key,
          COPILOT_BROWSER_CDP_PORT: String(cfg.browserCdpPort),
          COPILOT_BROWSER_EXE: browserExe,
          COPILOT_BROWSER_PROFILE: browserProfile,
          COPILOT_BROWSER_START_URL: cfg.browserStartUrl,
          COPILOT_SCREENSHOT_DIR: screenshotDir,
          COPILOT_MAX_SCREENSHOTS: String(cfg.maxScreenshots),
          COPILOT_MAX_AGE_HOURS: String(cfg.maxAgeHours),
          COPILOT_VISION_BASE_URL: cfg.visionBaseURL,
          COPILOT_VISION_MODEL: cfg.visionModel,
          COPILOT_VISION_API_KEY: cfg.visionEnabled ? visionKey : "",
          COPILOT_VISION_TIMEOUT_MS: String(cfg.visionTimeoutMs)
        },
        toolCallTimeoutMs: cfg.toolCallTimeoutMs,
        failOnStartupError: false
      });
      bridgeMounted = true;
      console.info("[dsh-copilot] copilot 桥接面已挂载");
    } catch (e) {
      console.warn("[dsh-copilot] copilot 桥接面挂载失败：", String(e && e.message ? e.message : e));
    }
  }

  // ---- dsh-copilot Skill + 渐进曝光（Skill 门控） ----
  // 借鉴 dsh-computer-use 的 progressive exposure：能力清单不一次摊开，模型加载本 Skill
  // （或直接调 wake_desktop / wake_browser）后才按需拉起对应的 MCP 面。
  // 落地差异（个性化适配）：不隐藏入口工具、不按 agent 隔离——本插件是 host 单实例、
  // 单用户桌面场景，面级挂载已足够，隐藏入口反而增加找不到工具的风险。
  const SKILL_CONTENT = [
    "# dsh-copilot（浏览器 + Windows 桌面操控 + 屏幕识图）",
    "",
    "按需激活的能力包：本 Skill 加载后，桌面工具面（mcp__desktop__*）会被自动挂载；浏览器面随 CDP 状态自动补挂。",
    "",
    "## 何时用哪个能力（按此优先级选择）",
    "1. 网页任务（读页面/填表/点击/多标签）→ mcp__browser__*。若工具不存在或报 CDP 失败：先调 mcp__copilot__wake_browser，等 10~20 秒后重试。",
    "2. Windows 桌面应用（非浏览器窗口）→ mcp__desktop__*（加载本 Skill 后自动可用）。若 mcp__desktop__* 仍不存在：先调 mcp__copilot__wake_desktop，等就绪后重试。",
    "3. 只需「看屏幕/识图」：mcp__copilot__vision（默认不落盘，便宜快速）；需要留存截图才用 mcp__copilot__capture（diskless:false）。",
    "4. 纯文本/文件/代码任务不要用本插件，用 DSH 原生工具。",
    "",
    "## 桌面操控观察规程（必须遵守，防止「看到旧的、点错位置」）",
    "- 动作前必须先 Snapshot 拿最新 UI 元素树；动作后重新 Snapshot 确认结果，不要凭记忆连续点击。",
    "- 优先按元素 id/名称定位；只有元素无法定位时才用坐标，且坐标必须来自最近一次 Snapshot。",
    "- 超过 2 分钟的旧观察视为过期：动作前必须重新 Snapshot，禁止复用。",
    "- 动作后界面无变化时：先判断是否真的失败（可能只是视觉变化），再次操作前必须重新 Snapshot，不要盲目重试。",
    "- 高危操作（删除文件、发送消息、提交表单、支付类）前，必须用 ask_user_question 明确确认。",
    "- 遇验证码/短信/扫码登录：请用户在专用浏览器窗口人工完成后继续。",
    "",
    "## 资源语义",
    "- 浏览器用完可调 mcp__copilot__stop_browser 立即释放内存；空闲超过 idleTimeoutMinutes 自动回收（登录态保留在专用 profile）。",
    "- 桌面服务激活后常驻，桌面任务结束无需手动停止（除非用户要求释放内存）。"
  ].join("\n");

  let skillRegistered = false;
  if (cfg.skillEnabled) {
    try {
      // 可选注入：skills 服务缺失时本插件的其它能力照常工作，只是不注册 Skill
      ctx.inject(["skills"], function (skillCtx) {
        try {
          skillCtx.effect(function* () {
            yield skillCtx.skills.register({
              name: "dsh-copilot",
              description: "浏览器操控（网页读取/填表/点击）、Windows 桌面应用操控（UIA 树+鼠标键盘）、屏幕截图与识图。当任务需要看当前屏幕、操作网页、或用鼠标键盘控制本机 Windows 应用时加载。",
              whenToUse: "需要操作网页、查看/分析当前桌面画面、或控制 Windows 桌面应用时。",
              content: SKILL_CONTENT
            });
          }, "dsh-copilot: skill");
          skillRegistered = true;
          console.info("[dsh-copilot] Skill 已注册：dsh-copilot（加载后自动挂载桌面面）");
        } catch (e) {
          console.warn("[dsh-copilot] Skill 注册失败（不影响其它能力）：", String(e && e.message ? e.message : e));
        }
      });
    } catch (e) {
      console.warn("[dsh-copilot] skills 服务注入失败（跳过 Skill 注册）：", String(e && e.message ? e.message : e));
    }
  }

  // 观测所有工具调用：Skill 加载 → 拉起桌面面；wake_* → 尽早补挂；*_ 调用 → 刷新活动时间（供空闲回收）
  ctx.on("tools/result", function (exec, result) {
    try {
      if (!exec || typeof exec.name !== "string") return;
      const toolName = exec.name;
      const args = exec.arguments || {};
      const ok = !result || result.isError !== true;
      if (toolName === "skill" && args.name === "dsh-copilot" && ok) {
        wakeDesktop("skill-loaded").catch(function (e) {
          console.warn("[dsh-copilot] Skill 触发桌面面挂载失败：", String(e && e.message ? e.message : e));
        });
        return;
      }
      if (toolName === "mcp__copilot__wake_desktop") {
        wakeDesktop("wake-tool").catch(function () { /* 已在 mountDesktopFace 内告警 */ });
        return;
      }
      if (toolName === "mcp__copilot__wake_browser" || toolName === "mcp__copilot__launch_browser") {
        browserFace.lastActivityAt = Date.now();
        probeJson("http://127.0.0.1:" + cfg.browserCdpPort + "/json/version", 1500).then(function (alive) {
          if (alive && !browserFace.mounted) return mountBrowserFace();
          return undefined;
        }).catch(function () { /* 忽略 */ });
        return;
      }
      if (toolName.indexOf("mcp__desktop__") === 0) {
        desktopFace.lastActivityAt = Date.now();
        return;
      }
      if (toolName.indexOf("mcp__browser__") === 0) {
        browserFace.lastActivityAt = Date.now();
      }
    } catch (e) {
      /* 观察者失败不影响工具结果 */
    }
  });

  // ---- 状态汇总 ----
  async function collectStatus() {
    const cdp = await probeJson("http://127.0.0.1:" + cfg.browserCdpPort + "/json/version", 1500);
    return {
      browser: {
        enabled: cfg.browserEnabled,
        mounted: browserFace.mounted,
        lazy: !cdpAliveAtBoot,
        channel: cfg.browserChannel,
        exe: browserExe,
        exeFound: Boolean(browserExe) && fs.existsSync(browserExe),
        profileDir: browserProfile,
        cdpPort: cfg.browserCdpPort,
        cdpAlive: Boolean(cdp),
        cdpBrowserVersion: cdp && cdp.Browser ? cdp.Browser : null,
        playwrightCli: playwrightCli,
        idleTimeoutMinutes: cfg.idleTimeoutMinutes,
        lastStopReason: browserFace.lastStopReason || null,
        lastActivityAt: new Date(browserFace.lastActivityAt).toISOString()
      },
      desktop: {
        enabled: cfg.desktopEnabled, mounted: desktopFace.mounted, lazy: desktopFace.lazy,
        expectPort: desktopFace.expectedPort || null,
        idleReclaimMinutes: cfg.desktopIdleReclaimMinutes,
        exe: desktopExe, exeFound: desktopExeFound,
        running: Boolean(sup.state.child), pid: sup.state.child ? sup.state.child.pid : null,
        port: sup.state.port, url: sup.state.port ? sup.url() : "",
        restarts: sup.state.restarts, givingUp: sup.state.givingUp,
        lastError: sup.state.lastError.slice(0, 300), controlPolicy: cfg.desktopControlPolicy
      },
      vision: { enabled: cfg.visionEnabled, model: cfg.visionModel, baseURL: cfg.visionBaseURL, keyConfigured: Boolean(visionKey) },
      bridge: { enabled: cfg.bridgeEnabled, mounted: bridgeMounted, nodeExe: nodeExe, scriptFound: fs.existsSync(bridgeScript) },
      skill: { enabled: cfg.skillEnabled, registered: skillRegistered, name: "dsh-copilot" },
      screenshotDir: screenshotDir,
      screenshotPolicy: { maxScreenshots: cfg.maxScreenshots, maxAgeHours: cfg.maxAgeHours },
      ui: { pollIntervalMs: 60000, popupPollIntervalMs: 5000 }
    };
  }

  function formatStatusText(st) {
    const mark = function (ok) { return ok ? "✓" : "✗"; };
    return [
      "dsh-copilot 状态：",
      "  浏览器面 " + mark(st.browser.mounted || st.browser.enabled) + " " +
        (st.browser.mounted ? "playwright-mcp 已挂载" : "懒挂载（CDP 上线自动补挂）") +
        (st.browser.cdpAlive ? "，CDP 在线（" + st.browser.cdpBrowserVersion + "）" : "，CDP 离线（用 /copilot 或 UI 按钮启动专用 Edge）") +
        (st.browser.lastStopReason ? "，上次停止：" + (st.browser.lastStopReason === "idle" ? "已自动回收（空闲）" : st.browser.lastStopReason) : ""),
      "  桌面面   " + mark(st.desktop.mounted && st.desktop.running) +
        (st.desktop.mounted && st.desktop.running
          ? " windows-mcp（pid " + st.desktop.pid + " @" + st.desktop.port + "，重启 " + st.desktop.restarts + " 次）"
          : st.desktop.lazy
            ? " 门控懒挂载（加载 dsh-copilot Skill / 调 wake_desktop / UI 按钮后拉起）"
            : st.desktop.exeFound ? "（未运行）" : "（未安装：uv tool install windows-mcp --python 3.14）"),
      "  识图     " + mark(st.vision.keyConfigured) + " " + st.vision.model + (st.vision.keyConfigured ? "" : "（key 未配置）"),
      "  桥接     " + mark(st.bridge.mounted) + " copilot 工具（status/launch/wake_browser/wake_desktop/stop_browser/capture/vision）",
      "  技能     " + mark(st.skill.registered) + (st.skill.registered ? " Skill 已注册：dsh-copilot（模型可按需加载）" : " Skill 未注册（skills 服务不可用或 skillEnabled=false）"),
      "  截图目录 " + st.screenshotDir + "（上限 " + st.screenshotPolicy.maxScreenshots + " 张 / " + st.screenshotPolicy.maxAgeHours + " 小时滚动清理）",
      "  空闲回收 " + (st.browser.idleTimeoutMinutes > 0 ? "浏览器 " + st.browser.idleTimeoutMinutes + " 分钟无使用自动关" : "浏览器回收已禁用") +
        (st.desktop.idleReclaimMinutes > 0 ? "；桌面 " + st.desktop.idleReclaimMinutes + " 分钟无使用自动卸" : "；桌面激活后常驻")
    ].join("\n");
  }

  // ---- 同源路由（仅回环） ----
  const guard = function (req, res) {
    if (!isLoopbackAddr(req.socket && req.socket.remoteAddress)) {
      sendJson(res, 403, { error: "loopback only" });
      return false;
    }
    return true;
  };

  const statusRoute = async function (req, res) {
    if (!guard(req, res)) return;
    sendJson(res, 200, await collectStatus());
  };

  const launchRoute = async function (req, res) {
    if (!guard(req, res)) return;
    let url = "";
    try {
      const raw = await readBody(req, 64 * 1024);
      const payload = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      url = typeof payload.url === "string" ? payload.url : "";
    } catch (e) { /* 空 body 视为无 url */ }
    if (!browserExe || !fs.existsSync(browserExe)) {
      sendJson(res, 500, { ok: false, error: "浏览器可执行文件未找到: " + browserExe });
      return;
    }
    const alive = await probeJson("http://127.0.0.1:" + cfg.browserCdpPort + "/json/version", 1500);
    if (alive) {
      if (url) launchBrowserProcess(browserExe, browserProfile, cfg.browserCdpPort, url);
      browserFace.lastActivityAt = Date.now();
      browserFace.lastStopReason = "";
      // 已在线但面未挂载（罕见竞态）：立即补挂
      if (!browserFace.mounted) await mountBrowserFace();
      sendJson(res, 200, { ok: true, alreadyRunning: true, cdpAlive: true, faceMounted: browserFace.mounted });
      return;
    }
    const pid = launchBrowserProcess(browserExe, browserProfile, cfg.browserCdpPort, url || cfg.browserStartUrl);
    const ready = await waitCdpAlive(cfg.browserCdpPort, 20000);
    if (ready) {
      browserFace.lastActivityAt = Date.now();
      browserFace.lastStopReason = "";
      await mountBrowserFace(); // 立即补挂，不等下个监督周期
    }
    sendJson(res, ready ? 200 : 504, { ok: Boolean(ready), pid: pid, cdpAlive: Boolean(ready), faceMounted: browserFace.mounted });
  };

  const stopBrowserRoute = async function (req, res) {
    if (!guard(req, res)) return;
    if (req.method !== "POST") { sendJson(res, 405, { error: "POST only" }); return; }
    try {
      const r = await stopBrowser("manual");
      sendJson(res, r.ok ? 200 : 500, { ok: r.ok, via: r.via, alreadyStopped: Boolean(r.alreadyStopped), faceMounted: browserFace.mounted });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  };

  const screenshotRoute = async function (req, res) {
    if (!guard(req, res)) return;
    if (req.method !== "POST") { sendJson(res, 405, { error: "POST only" }); return; }
    const file = path.join(screenshotDir, "ui-" + Date.now() + ".png");
    try {
      await captureViaPowerShell(file);
      const b64 = fs.readFileSync(file).toString("base64");
      const cleaned = cleanupScreenshots(screenshotDir, cfg.maxScreenshots, cfg.maxAgeHours);
      sendJson(res, 200, { ok: true, file: file, dataUrl: "data:image/png;base64," + b64, cleanup: cleaned });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  };

  const controlRoute = async function (req, res) {
    if (!guard(req, res)) return;
    if (req.method !== "POST") { sendJson(res, 405, { error: "POST only" }); return; }
    let action = "wake";
    try {
      const raw = await readBody(req, 64 * 1024);
      const payload = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      if (typeof payload.action === "string") action = payload.action;
    } catch (e) { /* 默认 wake */ }
    if (!desktopExeFound) { sendJson(res, 500, { ok: false, error: "windows-mcp 未安装" }); return; }
    try {
      if (action === "stop") {
        await unmountDesktopFace("manual");
      } else if (action === "start" || action === "wake") {
        await wakeDesktop("ui-" + action);
      } else if (action === "restart") {
        await unmountDesktopFace("restart");
        await wakeDesktop("ui-restart");
      } else {
        sendJson(res, 400, { ok: false, error: "未知 action：" + action });
        return;
      }
      sendJson(res, 200, {
        ok: true, action: action,
        mounted: desktopFace.mounted, running: Boolean(sup.state.child), port: sup.state.port
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  };

  ctx.effect(function* () {
    const disposers = [
      ctx.webServer.register({ kind: "exact", path: cfg.routePrefix + "/status", handler: statusRoute }),
      ctx.webServer.register({ kind: "exact", path: cfg.routePrefix + "/launch-browser", handler: launchRoute }),
      ctx.webServer.register({ kind: "exact", path: cfg.routePrefix + "/stop-browser", handler: stopBrowserRoute }),
      ctx.webServer.register({ kind: "exact", path: cfg.routePrefix + "/screenshot", handler: screenshotRoute }),
      ctx.webServer.register({ kind: "exact", path: cfg.routePrefix + "/desktop-control", handler: controlRoute })
    ];
    yield function () {
      for (const d of disposers) { try { if (typeof d === "function") d(); } catch (e) { /* 忽略 */ } }
    };
  }, "dsh-copilot: routes");

  // ---- /copilot 命令 ----
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: "copilot",
      description: "浏览器/桌面操控状态自检（dsh-copilot）",
      handler: async function () {
        try {
          const st = await collectStatus();
          return { kind: "success", text: formatStatusText(st) };
        } catch (error) {
          return { kind: "error", text: "状态自检失败：" + String(error && error.message ? error.message : error) };
        }
      }
    });
  }, "dsh-copilot: command");

  // ---- 监督清理 ----
  ctx.effect(function* () {
    yield function () {
      // 1) 停周期监督 2) 卸两个 MCP 面 3) shutdownPolicy=stop 时回收浏览器 4) 停 windows-mcp
      if (browserPollTimer) { clearInterval(browserPollTimer); browserPollTimer = null; }
      unmountBrowserFace().catch(function () { /* 忽略 */ });
      if (cfg.shutdownPolicy === "stop") {
        stopBrowser("shutdown").catch(function (e) {
          console.warn("[dsh-copilot] 退出回收浏览器失败（忽略）：", String(e && e.message ? e.message : e));
        });
      }
      desktopFace.mounted = false;
      desktopFace.fiber = null;
      sup.stop();
    };
  }, "dsh-copilot: supervisor cleanup");

  console.info(
    "[dsh-copilot] 就绪：browser=" + (browserFace.mounted ? "mounted" : browserFaceAvailable ? "lazy" : "off") +
    " desktop=" + (desktopFace.mounted ? "mounted" : desktopFace.lazy ? "lazy(skill-gated)" : "off") +
    " copilot=" + bridgeMounted +
    " skill=" + (skillRegistered ? "registered" : "off") +
    " visionKey=" + Boolean(visionKey) +
    " idleTimeout=" + (cfg.idleTimeoutMinutes > 0 ? cfg.idleTimeoutMinutes + "min" : "off") +
    " shutdownPolicy=" + cfg.shutdownPolicy
  );
}

export { Config, apply, inject, name };
