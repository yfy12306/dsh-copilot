/**
 * dsh-copilot 桥接 server 离线端到端测试（不依赖 DSH 运行时）。
 *
 * 用法：
 *   node scripts/test-bridge.mjs                        # 全流程（会真实打开专用 Edge 窗口）
 *   node scripts/test-bridge.mjs --skip-browser         # 跳过浏览器启动/CDP 验证
 *   node scripts/test-bridge.mjs --windows <url> <key>  # 指定常驻 windows-mcp（验证 capture 走 UIA 通道）
 *
 * 流程：initialize → tools/list → status → launch_browser → status(CDP 应在线)
 *       → capture(截图落盘+图像块) → vision(research/vision-test.png 识图，实调 视觉网关)
 * 退出码 0 = 全部通过。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const bridgePath = path.join(here, "..", "bridge", "server.mjs");
const argv = process.argv.slice(2);
const skipBrowser = argv.includes("--skip-browser");
const skipVision = argv.includes("--skip-vision");
const visionOnly = argv.includes("--vision-only");
let winUrl = "";
let winKey = "";
const wi = argv.indexOf("--windows");
if (wi >= 0) {
  winUrl = argv[wi + 1] || "";
  winKey = argv[wi + 2] || "";
}

const edgeCandidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];
const browserExe = edgeCandidates.find(function (p) { return fs.existsSync(p); }) || "";

const env = Object.assign({}, process.env, {
  COPILOT_WINDOWS_MCP_URL: winUrl,
  COPILOT_WINDOWS_MCP_KEY: winKey,
  COPILOT_BROWSER_CDP_PORT: "9222",
  COPILOT_BROWSER_EXE: browserExe,
  COPILOT_BROWSER_PROFILE: path.join(os.homedir(), ".dsh", "browser-profile"),
  COPILOT_BROWSER_START_URL: "",
  COPILOT_SCREENSHOT_DIR: "C:\\Users\\user\\Desktop\\deepseek\\research\\test-shots",
  COPILOT_VISION_BASE_URL: "https://your-llm-gateway.example.com/v1",
  COPILOT_VISION_MODEL: "deepseek-v4.1-flash-aliyunbailian",
  COPILOT_VISION_API_KEY: "",
  COPILOT_VISION_TIMEOUT_MS: "90000"
});

const child = spawn(process.execPath, [bridgePath], { env: env, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", function (d) { process.stderr.write("[bridge] " + d); });

let buf = "";
const pending = new Map();
child.stdout.on("data", function (d) {
  buf += d.toString("utf8");
  let idx = buf.indexOf("\n");
  while (idx >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    idx = buf.indexOf("\n");
    if (!line) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p.resolve(msg);
    }
  }
});

let seq = 0;
function send(method, params, isNotification) {
  const msg = { jsonrpc: "2.0", method: method };
  if (!isNotification) { seq += 1; msg.id = seq; }
  if (params !== undefined) msg.params = params;
  child.stdin.write(JSON.stringify(msg) + "\n");
  if (isNotification) return Promise.resolve(null);
  const id = msg.id;
  return new Promise(function (resolve, reject) {
    pending.set(id, { resolve: resolve });
    setTimeout(function () {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("请求超时: " + method));
      }
    }, 150000);
  });
}

const results = [];
function record(step, ok, detail) {
  results.push({ step: step, ok: ok, detail: String(detail || "").slice(0, 300) });
  console.log((ok ? "PASS" : "FAIL") + " | " + step + " | " + String(detail || "").slice(0, 300));
}

function textOf(res) {
  const c = (res && res.result && res.result.content) || [];
  return c.filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("\n");
}
function imageOf(res) {
  const c = (res && res.result && res.result.content) || [];
  return c.find(function (b) { return b.type === "image"; }) || null;
}
function isErr(res) {
  return Boolean(res && res.result && res.result.isError);
}

async function callTool(name, args) {
  return send("tools/call", { name: name, arguments: args || {} });
}

async function main() {
  // 1) initialize
  const init = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-bridge", version: "0.0.1" }
  });
  const serverInfo = (init && init.result && init.result.serverInfo) || {};
  const instructions = (init && init.result && init.result.instructions) || "";
  record("initialize", serverInfo.name === "copilot", "server=" + serverInfo.name + " v" + serverInfo.version + " instructions=" + instructions.length + "B");
  await send("notifications/initialized", undefined, true);

  // 2) tools/list（七工具：status/launch_browser/wake_browser/wake_desktop/stop_browser/capture/vision）
  const list = await send("tools/list", {});
  const tools = (list && list.result && list.result.tools) || [];
  const names = tools.map(function (t) { return t.name; }).sort().join(",");
  record("tools/list", names === "capture,launch_browser,status,stop_browser,vision,wake_browser,wake_desktop", names);

  // visionOnly（model lane）：只验证识图链路，其余步骤跳过
  if (visionOnly) {
    const testPng = "C:\\Users\\user\\Desktop\\deepseek\\research\\vision-test.png";
    if (fs.existsSync(testPng)) {
      const vis = await callTool("vision", { question: "图片背景什么颜色？写了什么文字？文字什么颜色？简短回答。", imagePath: testPng });
      const ans = textOf(vis);
      const ok = !isErr(vis) && /蓝/.test(ans) && /DSH-42/.test(ans) && /黄/.test(ans);
      record("vision(deepseek-v4.1-flash 识图)", ok, ans.replace(/\s+/g, " ").slice(0, 220));
    } else {
      record("vision(deepseek-v4.1-flash 识图)", false, "测试图不存在: " + testPng);
    }
    const failedVision = results.filter(function (r) { return !r.ok; });
    console.log("\n==== 汇总: " + (results.length - failedVision.length) + "/" + results.length + " 通过 ====");
    child.kill();
    process.exit(failedVision.length ? 1 : 0);
  }

  // 3) status（浏览器可能离线，desktop 未配置——只验证工具本身工作）
  const st1 = await callTool("status", {});
  record("status(初始)", !isErr(st1), textOf(st1).replace(/\s+/g, " ").slice(0, 220));

  if (!skipBrowser) {
    // 4) launch_browser（真实打开专用 Edge）
    if (!browserExe) {
      record("launch_browser", false, "未找到 Edge 可执行文件");
    } else {
      const lb = await callTool("launch_browser", {});
      record("launch_browser", !isErr(lb), textOf(lb).replace(/\s+/g, " ").slice(0, 220));
      // 5) 轮询 status 直到 CDP 在线
      let alive = false;
      for (let i = 0; i < 30 && !alive; i++) {
        await new Promise(function (r) { setTimeout(r, 1000); });
        const st = await callTool("status", {});
        try { alive = JSON.parse(textOf(st)).browser.cdpAlive === true; } catch (e) { alive = false; }
      }
      record("status(CDP 在线)", alive, alive ? "专用 Edge CDP 9222 就绪" : "20+ 秒内 CDP 未就绪");
    }
  }

  // 6) capture（默认 diskless：仅内存返回不落盘）
  const cap = await callTool("capture", {});
  const img = imageOf(cap);
  let capMeta = null;
  try { capMeta = JSON.parse(textOf(cap)); } catch (e) { /* 忽略 */ }
  const capOk = !isErr(cap) && Boolean(img && img.data && img.data.length > 1000) && capMeta && capMeta.diskless === true && !capMeta.file;
  record("capture(diskless 默认仅内存)", capOk, "meta=" + (capMeta ? JSON.stringify({ diskless: capMeta.diskless, via: capMeta.via, bytes: capMeta.bytes, cleanup: capMeta.cleanup }) : textOf(cap).slice(0, 160)));

  // 6b) capture 落盘模式（diskless:false，带滚动清理）
  const cap2 = await callTool("capture", { diskless: false });
  const img2 = imageOf(cap2);
  let cap2File = "";
  try { cap2File = JSON.parse(textOf(cap2)).file || ""; } catch (e) { /* 忽略 */ }
  const cap2Ok = !isErr(cap2) && Boolean(img2 && img2.data && img2.data.length > 1000) && cap2File !== "" && fs.existsSync(cap2File);
  record("capture(落盘+滚动清理)", cap2Ok, "file=" + (cap2File || textOf(cap2).slice(0, 160)));

  // 7) vision（实调 视觉网关 deepseek-v4.1-flash；缺省 diskless 截图或指定图）——bridge lane 用 --skip-vision 跳过
  const testPng = "C:\\Users\\user\\Desktop\\deepseek\\research\\vision-test.png";
  if (skipVision) {
    record("vision(跳过)", true, "--skip-vision：识图由 model lane 单独验证");
  } else if (fs.existsSync(testPng)) {
    const vis = await callTool("vision", { question: "图片背景什么颜色？写了什么文字？文字什么颜色？简短回答。", imagePath: testPng });
    const ans = textOf(vis);
    const ok = !isErr(vis) && /蓝/.test(ans) && /DSH-42/.test(ans) && /黄/.test(ans);
    record("vision(deepseek-v4.1-flash 识图)", ok, ans.replace(/\s+/g, " ").slice(0, 220));
  } else {
    record("vision(deepseek-v4.1-flash 识图)", false, "测试图不存在: " + testPng);
  }

  // 8) stop_browser（启动过浏览器才停；验证 CDP 关闭 + 进程回收）
  if (!skipBrowser && browserExe) {
    const sb = await callTool("stop_browser", {});
    let sbMeta = null;
    try { sbMeta = JSON.parse(textOf(sb)); } catch (e) { /* 忽略 */ }
    const stAfter = await callTool("status", {});
    let cdpAfter = null;
    try { cdpAfter = JSON.parse(textOf(stAfter)).browser.cdpAlive; } catch (e) { /* 忽略 */ }
    const sbOk = !isErr(sb) && sbMeta && sbMeta.ok === true && cdpAfter === false;
    record("stop_browser(CDP 关闭)", sbOk, "meta=" + (sbMeta ? JSON.stringify({ ok: sbMeta.ok, via: sbMeta.via, alreadyStopped: !!sbMeta.alreadyStopped }) : textOf(sb).slice(0, 160)) + " cdpAfter=" + cdpAfter);
  }

  // 9) wake_browser（懒挂载场景唤醒入口；跳过浏览器时仅验证工具不报错）
  if (!skipBrowser && browserExe) {
    const wk = await callTool("wake_browser", {});
    let wkMeta = null;
    try { wkMeta = JSON.parse(textOf(wk)); } catch (e) { /* 忽略 */ }
    const wkOk = !isErr(wk) && wkMeta && (wkMeta.started === true || wkMeta.alreadyRunning === true);
    record("wake_browser(唤醒)", wkOk, "meta=" + (wkMeta ? JSON.stringify({ started: wkMeta.started, alreadyRunning: !!wkMeta.alreadyRunning }) : textOf(wk).slice(0, 160)));
    // 测试收尾：停掉，恢复现场
    await callTool("stop_browser", {});
  }

  // 汇总
  const failed = results.filter(function (r) { return !r.ok; });
  console.log("\n==== 汇总: " + (results.length - failed.length) + "/" + results.length + " 通过 ====");
  child.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch(function (e) {
  console.error("测试异常:", e);
  try { child.kill(); } catch (e2) { /* 忽略 */ }
  process.exit(2);
});
