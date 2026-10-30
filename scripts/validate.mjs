/**
 * dsh-copilot 分层验证脚本（借鉴 dsh-computer-use 的 validate lane 习惯，按本机内网/慢机器做轻量化裁剪）。
 *
 * 用法：
 *   node scripts/validate.mjs --lane local     # 秒级：语法 + 模块导出 + 包元数据 + 工具清单静态校验（不联网、不开浏览器）
 *   node scripts/validate.mjs --lane bridge    # 本机端到端：桥接面 8 项断言（会真实打开专用 Edge，跳过识图）
 *   node scripts/validate.mjs --lane model     # 识图实调：视觉网关 deepseek-v4.1-flash（需要 key 与测试图）
 *   node scripts/validate.mjs --lane release   # local + bridge + model 全跑
 *
 * 退出码 0 = 该 lane 全部通过。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const pluginDir = path.join(here, "..");
const argv = process.argv.slice(2);
const laneIdx = argv.indexOf("--lane");
const lane = laneIdx >= 0 ? (argv[laneIdx + 1] || "local") : "local";

let pass = 0;
let fail = 0;
function ok(step, detail) {
  pass += 1;
  console.log("PASS | " + step + (detail ? " | " + detail : ""));
}
function bad(step, detail) {
  fail += 1;
  console.log("FAIL | " + step + (detail ? " | " + detail : ""));
}

function run(args, cwd, timeoutMs) {
  return new Promise(function (resolve) {
    const child = spawn(process.execPath, args, { cwd: cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(function () { try { child.kill(); } catch (e) { /* 忽略 */ } }, timeoutMs || 300000);
    child.stdout.on("data", function (d) { out += d; });
    child.stderr.on("data", function (d) { out += d; });
    child.on("error", function (e) { clearTimeout(timer); resolve({ code: -1, out: String(e) }); });
    child.on("close", function (code) { clearTimeout(timer); resolve({ code: code, out: out }); });
  });
}

async function laneLocal() {
  // 1) 语法检查
  for (const rel of ["lib/index.js", "lib/client.js", "bridge/server.mjs", "scripts/test-bridge.mjs"]) {
    const r = await run(["--check", path.join(pluginDir, rel)], pluginDir, 30000);
    if (r.code === 0) ok("syntax " + rel);
    else bad("syntax " + rel, r.out.slice(0, 300));
  }

  // 2) host 半导出面（模块顶层无副作用，可安全 import）
  try {
    const mod = await import(pathToFileURL(path.join(pluginDir, "lib/index.js")).href);
    const checks = [
      ["name", mod.name === "dsh-copilot"],
      ["inject", Array.isArray(mod.inject) && mod.inject.indexOf("webServer") >= 0 && mod.inject.indexOf("commands") >= 0],
      ["apply", typeof mod.apply === "function"],
      ["Config", mod.Config !== undefined && (typeof mod.Config === "object" || typeof mod.Config === "function")]
    ];
    for (const c of checks) {
      if (c[1]) ok("host export " + c[0]);
      else bad("host export " + c[0]);
    }
  } catch (e) {
    bad("host 半 import", String(e && e.message ? e.message : e).slice(0, 400));
  }

  // 3) client 半关键契约（list 型槽位必须带 id；Skill 门控的关键字存在）
  try {
    const clientSrc = fs.readFileSync(path.join(pluginDir, "lib/client.js"), "utf8");
    if (/id:\s*"dsh-copilot"/.test(clientSrc) && /conversation\.input\.right/.test(clientSrc)) ok("client slot 注册参数（含 id）");
    else bad("client slot 注册参数（含 id）");
  } catch (e) {
    bad("client 半读取", String(e));
  }
  try {
    const hostSrc = fs.readFileSync(path.join(pluginDir, "lib/index.js"), "utf8");
    const checks = [
      ["Skill 注册", /skills\.register\(/.test(hostSrc) && /name:\s*"dsh-copilot"/.test(hostSrc)],
      ["Skill source 已传（加载校验必填，缺则会注册成功但加载失败）", /source:\s*"runtime"/.test(hostSrc)],
      ["tools/result 观测", /ctx\.on\("tools\/result"/.test(hostSrc)],
      ["desktop 门控懒挂载", /mountDesktopFace/.test(hostSrc) && /wakeDesktop/.test(hostSrc)],
      ["孤儿治理含 windows-mcp", /windows-mcp\.toml/.test(hostSrc)]
    ];
    for (const c of checks) {
      if (c[1]) ok("host 特性 " + c[0]);
      else bad("host 特性 " + c[0]);
    }
  } catch (e) {
    bad("host 半读取", String(e));
  }

  // 4) bridge 工具清单静态校验（应含 7 个工具）
  try {
    const src = fs.readFileSync(path.join(pluginDir, "bridge/server.mjs"), "utf8");
    const expected = ["status", "launch_browser", "wake_browser", "wake_desktop", "stop_browser", "capture", "vision"];
    const missing = expected.filter(function (n) { return src.indexOf('name: "' + n + '"') < 0; });
    if (missing.length === 0) ok("bridge 工具清单", expected.join(","));
    else bad("bridge 工具清单", "缺 " + missing.join(","));
  } catch (e) {
    bad("bridge 读取", String(e));
  }

  // 5) 包元数据与挂载契约
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
    const checks = [
      ["bundle.patch 存在", pkg.dsh && pkg.dsh.bundle && fs.existsSync(path.join(pluginDir, pkg.dsh.bundle.patch))],
      ["client 导出存在", pkg.exports && pkg.exports["./client"] && fs.existsSync(path.join(pluginDir, "lib/client.js"))],
      ["compatibility 声明", Boolean(pkg.dsh && pkg.dsh.compatibility)],
      ["validate scripts", Boolean(pkg.scripts && pkg.scripts["test:local"] && pkg.scripts.validate)]
    ];
    for (const c of checks) {
      if (c[1]) ok("package " + c[0]);
      else bad("package " + c[0]);
    }
  } catch (e) {
    bad("package.json", String(e));
  }
}

async function laneBridge() {
  const r = await run([path.join(pluginDir, "scripts", "test-bridge.mjs"), "--skip-vision"], pluginDir, 300000);
  console.log(r.out.split("\n").filter(function (l) { return /^(PASS|FAIL)/.test(l); }).join("\n"));
  const m = /==== 汇总: (\d+)\/(\d+) 通过 ====/.exec(r.out);
  if (m && m[1] === m[2]) ok("bridge lane", m[1] + "/" + m[2]);
  else bad("bridge lane", m ? m[1] + "/" + m[2] : "无汇总输出（退出码 " + r.code + "）");
}

async function laneModel() {
  const r = await run([path.join(pluginDir, "scripts", "test-bridge.mjs"), "--vision-only"], pluginDir, 180000);
  console.log(r.out.split("\n").filter(function (l) { return /^(PASS|FAIL)/.test(l); }).join("\n"));
  if (/PASS \| vision/.test(r.out)) ok("model lane（vision 实调）");
  else bad("model lane（vision 实调）", "退出码 " + r.code);
}

const lanes = lane === "release" ? ["local", "bridge", "model"] : [lane];
if (lanes.indexOf("local") >= 0) await laneLocal();
if (lanes.indexOf("bridge") >= 0) await laneBridge();
if (lanes.indexOf("model") >= 0) await laneModel();

console.log("\n==== lane=" + lane + " 汇总: " + pass + " 通过 / " + fail + " 失败 ====");
process.exit(fail ? 1 : 0);
