/**
 * dsh-copilot（client 半）：输入框右侧「操控状态芯片」。
 * - 芯片上两个状态点：浏览器 CDP（绿=专用 Edge 在线）/ 桌面服务（绿=windows-mcp 运行中）
 * - 点击展开弹层：状态明细 + [启动专用浏览器] [停止浏览器] [截图预览] [重启桌面服务] [刷新]
 * - 全部走同源路由 /copilot/*（host 半注册，仅回环访问），与 voice-input 同模式
 * - 颜色全部使用主题 CSS 变量（带兜底值），适配 moon-flavor 等主题
 * - 轮询策略：默认 60s（随 status.ui.pollIntervalMs 下发）；页面隐藏时暂停；弹层打开时立即刷一次
 *   并临时提高到 5s；launch/stop 等操作返回后主动刷新（不必等下个周期）
 */
window.__ModuleLoader__.load({
  id: "dsh-copilot",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;

    // ---------- 样式 ----------
    if (typeof document !== "undefined") {
      var tagId = "dsh-copilot/style";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
        var styleTag = document.createElement("style");
        styleTag.setAttribute("data-plugin-css", tagId);
        styleTag.setAttribute("data-plugin", "dsh-copilot");
        styleTag.textContent = [
          ".dsh-copilot-wrap { position: relative; display: inline-flex; }",
          ".dsh-copilot-btn {",
          "  display: inline-flex; align-items: center; gap: 5px;",
          "  height: 28px; margin: 0 2px; padding: 0 7px;",
          "  border: none; border-radius: 8px; background: transparent;",
          "  color: var(--dsw-alias-label-secondary, #9a9aa2);",
          "  cursor: pointer; transition: background 120ms ease, color 120ms ease; flex: none;",
          "}",
          ".dsh-copilot-btn:hover { background: var(--dsw-alias-fill-quaternary, rgba(120,120,130,0.12)); color: var(--dsw-alias-label-primary, currentColor); }",
          ".dsh-copilot-btn svg { display: block; }",
          ".dsh-copilot-dots { display: inline-flex; gap: 3px; align-items: center; }",
          ".dsh-copilot-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-quaternary, #55555c); transition: background 200ms ease; }",
          ".dsh-copilot-dot-on { background: #30a46c; }",
          ".dsh-copilot-dot-warn { background: #f5a623; }",
          ".dsh-copilot-pop {",
          "  position: absolute; bottom: 34px; right: 0; width: 320px; z-index: 9999;",
          "  padding: 12px; border-radius: 12px;",
          "  background: var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-secondary, #26262b));",
          "  border: 1px solid var(--dsw-alias-border-l2, rgba(120,120,130,0.35));",
          "  box-shadow: 0 8px 28px rgba(0,0,0,0.35);",
          "  color: var(--dsw-alias-label-primary, #eaeaf0);",
          "  font-size: 12px; line-height: 1.5;",
          "}",
          ".dsh-copilot-pop h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }",
          ".dsh-copilot-row { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }",
          ".dsh-copilot-row .k { color: var(--dsw-alias-label-secondary, #9a9aa2); flex: none; }",
          ".dsh-copilot-row .v { text-align: right; word-break: break-all; }",
          ".dsh-copilot-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }",
          ".dsh-copilot-act {",
          "  padding: 4px 10px; border-radius: 8px; cursor: pointer; font-size: 12px;",
          "  border: 1px solid var(--dsw-alias-border-l2, rgba(120,120,130,0.35));",
          "  background: var(--dsw-alias-fill-quaternary, rgba(120,120,130,0.10));",
          "  color: var(--dsw-alias-label-primary, inherit);",
          "}",
          ".dsh-copilot-act:hover { background: var(--dsw-alias-fill-tertiary, rgba(120,120,130,0.20)); }",
          ".dsh-copilot-act:disabled { opacity: 0.55; cursor: progress; }",
          ".dsh-copilot-act-stop:hover { background: rgba(229,72,77,0.18); }",
          ".dsh-copilot-err { margin-top: 8px; color: #e5484d; word-break: break-all; }",
          ".dsh-copilot-note { margin-top: 8px; color: var(--dsw-alias-label-tertiary, #77777f); }",
          ".dsh-copilot-preview { margin-top: 10px; }",
          ".dsh-copilot-preview img { max-width: 100%; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(120,120,130,0.35)); }",
          ".dsh-copilot-hint { margin-top: 8px; color: var(--dsw-alias-label-tertiary, #77777f); }"
        ].join("\n");
        document.head.appendChild(styleTag);
      }
    }

    // ---------- 路由 ----------
    var ROUTE_STATUS = "/copilot/status";
    var ROUTE_LAUNCH = "/copilot/launch-browser";
    var ROUTE_STOP = "/copilot/stop-browser";
    var ROUTE_SHOT = "/copilot/screenshot";
    var ROUTE_CONTROL = "/copilot/desktop-control";

    function postJson(url, body) {
      return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {})
      }).then(function (response) {
        return response.json()
          .catch(function () { return { error: "HTTP " + response.status }; })
          .then(function (json) {
            if (!response.ok) throw new Error(json.error || ("HTTP " + response.status));
            return json;
          });
      });
    }

    function MonitorIcon() {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: "15", height: "15", fill: "none", stroke: "currentColor", strokeWidth: "2", "aria-hidden": "true" },
        h("rect", { x: "2.5", y: "4", width: "19", height: "12.5", rx: "1.5" }),
        h("path", { d: "M8 20.5h8M12 16.5v4" })
      );
    }

    function row(k, v) {
      return h("div", { className: "dsh-copilot-row" }, h("span", { className: "k" }, k), h("span", { className: "v" }, v));
    }

    function stopReasonText(reason) {
      if (!reason) return "";
      if (reason === "idle") return "已自动回收（空闲）";
      if (reason === "manual") return "手动停止";
      if (reason === "shutdown") return "DSH 退出时回收";
      return String(reason);
    }

    function makeChip() {
      return function CopilotChip() {
        var s1 = React.useState(null); var status = s1[0]; var setStatus = s1[1];
        var s2 = React.useState(false); var open = s2[0]; var setOpen = s2[1];
        var s3 = React.useState(""); var busy = s3[0]; var setBusy = s3[1];
        var s4 = React.useState(""); var error = s4[0]; var setError = s4[1];
        var s5 = React.useState(null); var preview = s5[0]; var setPreview = s5[1];
        var s6 = React.useState(typeof document !== "undefined" && document.hidden); var hidden = s6[0]; var setHidden = s6[1];
        var rootRef = React.useRef(null);

        var pollIntervalMs = 60000;
        var popupPollIntervalMs = 5000;
        if (status && status.ui) {
          if (status.ui.pollIntervalMs) pollIntervalMs = status.ui.pollIntervalMs;
          if (status.ui.popupPollIntervalMs) popupPollIntervalMs = status.ui.popupPollIntervalMs;
        }

        function refresh() {
          return fetch(ROUTE_STATUS, { method: "POST" })
            .then(function (r) { return r.json(); })
            .then(function (j) { setStatus(j); })
            .catch(function (e) { setError("状态获取失败：" + (e && e.message ? e.message : e)); });
        }

        // 轮询：默认 60s；页面隐藏暂停；弹层打开时提高到 5s
        React.useEffect(function () {
          if (hidden) return undefined;
          var interval = open ? popupPollIntervalMs : pollIntervalMs;
          var t = setInterval(refresh, interval);
          return function () { clearInterval(t); };
        }, [open, pollIntervalMs, hidden]);

        // 可见性变化：隐藏→暂停轮询（effect 依赖 hidden 自动清理），恢复→立即刷一次
        React.useEffect(function () {
          function onVis() {
            setHidden(Boolean(document.hidden));
            if (!document.hidden) refresh();
          }
          document.addEventListener("visibilitychange", onVis);
          return function () { document.removeEventListener("visibilitychange", onVis); };
        }, []);

        React.useEffect(function () {
          if (!open) return undefined;
          refresh(); // 弹层打开立即刷一次
          function onDoc(ev) {
            if (rootRef.current && !rootRef.current.contains(ev.target)) setOpen(false);
          }
          document.addEventListener("mousedown", onDoc);
          return function () { document.removeEventListener("mousedown", onDoc); };
        }, [open]);

        function act(kind) {
          setBusy(kind);
          setError("");
          var p;
          if (kind === "launch") {
            // 返回后主动刷新（host 已即时补挂 browser 面，不等下个周期）
            p = postJson(ROUTE_LAUNCH, {}).then(function () { return refresh(); });
          } else if (kind === "stop") {
            p = postJson(ROUTE_STOP, {}).then(function () { return refresh(); });
          } else if (kind === "shot") {
            p = postJson(ROUTE_SHOT, {}).then(function (j) {
              if (j && j.dataUrl) setPreview(j.dataUrl);
              else throw new Error((j && j.error) || "截图失败");
            });
          } else if (kind === "restart") {
            // 桌面面门控：未挂载时是「启动」，已挂载时是「重启」
            var isMounted = Boolean(status && status.desktop && status.desktop.mounted);
            var p0 = postJson(ROUTE_CONTROL, { action: isMounted ? "restart" : "wake" }).then(function () {
              return new Promise(function (r) { setTimeout(r, isMounted ? 2000 : 1200); });
            }).then(function () { return refresh(); });
            p = p0;
          } else {
            p = refresh();
          }
          p.catch(function (e) { setError(String((e && e.message) || e)); })
            .then(function () { setBusy(""); });
        }

        var browserOk = Boolean(status && status.browser && status.browser.cdpAlive);
        var browserMounted = Boolean(status && status.browser && status.browser.mounted);
        var browserLazy = Boolean(status && status.browser && status.browser.lazy && !browserMounted);
        var desktopOk = Boolean(status && status.desktop && status.desktop.running);
        var desktopLazy = Boolean(status && status.desktop && status.desktop.lazy && !status.desktop.mounted);
        var visionOk = Boolean(status && status.vision && status.vision.keyConfigured);
        var stopNote = status && status.browser && status.browser.lastStopReason
          ? stopReasonText(status.browser.lastStopReason)
          : "";

        var title =
          "dsh-copilot：" +
          "浏览器 " + (browserOk ? "CDP 在线" : browserMounted ? "CDP 离线（点击启动）" : browserLazy ? "懒挂载（未启动）" : "未挂载") +
          (stopNote ? "（" + stopNote + "）" : "") +
          " ｜ 桌面 " + (desktopOk ? "运行中" : desktopLazy ? "按需（未激活）" : "未运行") +
          " ｜ 识图 " + (visionOk ? "就绪" : "未配置");

        var pop = null;
        if (open) {
          var b = status ? status.browser : null;
          var d = status ? status.desktop : null;
          var v = status ? status.vision : null;
          var br = status ? status.bridge : null;
          pop = h("div", { className: "dsh-copilot-pop" },
            h("h4", null, "dsh-copilot 操控面板"),
            status === null
              ? h("div", null, "状态加载中…")
              : h("div", null,
                  row("浏览器面", (b && b.mounted ? "playwright-mcp ✓" : "懒挂载（启动浏览器后自动补挂）") + " ｜ CDP " + (b && b.cdpAlive ? "在线 " + (b.cdpBrowserVersion || "") : "离线") + " :" + (b ? b.cdpPort : "?")),
                  row("专用 profile", b && b.profileDir ? b.profileDir : "-"),
                  stopNote ? row("上次停止", stopNote) : null,
                  row("空闲回收", b && b.idleTimeoutMinutes > 0 ? b.idleTimeoutMinutes + " 分钟无使用自动关浏览器" : "已禁用"),
                  row("桌面面", d && d.mounted && d.running
                    ? "windows-mcp 运行中 (pid " + d.pid + " @" + d.port + ")"
                    : d && d.lazy
                      ? "门控懒挂载（加载 Skill / 点下方按钮后拉起）"
                      : d && d.exeFound ? "windows-mcp 未运行" : "windows-mcp 未安装"),
                  row("识图", v ? v.model + (v.keyConfigured ? " ✓" : "（key 未配置）") : "-"),
                  row("桥接工具", br && br.mounted ? "copilot ✓" : "未挂载"),
                  row("截图目录", (status.screenshotDir || "-") + "（≤" + (status.screenshotPolicy ? status.screenshotPolicy.maxScreenshots : "?") + " 张滚动清理）")
                ),
            h("div", { className: "dsh-copilot-acts" },
              h("button", { className: "dsh-copilot-act", disabled: busy !== "", onClick: function () { act("launch"); } }, busy === "launch" ? "启动中…" : "🌐 启动专用浏览器"),
              h("button", { className: "dsh-copilot-act dsh-copilot-act-stop", disabled: busy !== "", onClick: function () { act("stop"); } }, busy === "stop" ? "停止中…" : "⏹ 停止浏览器"),
              h("button", { className: "dsh-copilot-act", disabled: busy !== "", onClick: function () { act("shot"); } }, busy === "shot" ? "截图中…" : "📷 截图预览"),
              h("button", { className: "dsh-copilot-act", disabled: busy !== "", onClick: function () { act("restart"); } },
                busy === "restart"
                  ? "处理中…"
                  : (status && status.desktop && status.desktop.mounted ? "♻️ 重启桌面服务" : "▶ 启动桌面服务")),
              h("button", { className: "dsh-copilot-act", disabled: busy !== "", onClick: function () { act("refresh"); } }, "刷新")
            ),
            error !== "" ? h("div", { className: "dsh-copilot-err" }, error) : null,
            stopNote ? h("div", { className: "dsh-copilot-note" }, "浏览器" + stopNote + "；登录态保留在专用 profile，重启无损") : null,
            preview ? h("div", { className: "dsh-copilot-preview" }, h("img", { src: preview, alt: "屏幕截图预览" })) : null,
            h("div", { className: "dsh-copilot-hint" }, "模型侧工具：mcp__browser__*（网页）· mcp__desktop__*（桌面）· mcp__copilot__*（状态/启动/停止/截图/识图）；斜杠命令 /copilot")
          );
        }

        return h("span", { className: "dsh-copilot-wrap", ref: rootRef },
          h("button", {
            type: "button",
            className: "dsh-copilot-btn",
            title: title,
            "aria-label": "dsh-copilot 操控状态",
            onClick: function () { setOpen(!open); }
          },
            MonitorIcon(),
            h("span", { className: "dsh-copilot-dots" },
              h("span", { className: "dsh-copilot-dot" + (browserOk ? " dsh-copilot-dot-on" : "") }),
              h("span", { className: "dsh-copilot-dot" + (desktopOk ? " dsh-copilot-dot-on" : visionOk ? " dsh-copilot-dot-warn" : "") })
            )
          ),
          pop
        );
      };
    }

    function apply(ctx) {
      var disposers = [];
      disposers.push(
        ctx.slots.inject("conversation.input.right", function () {
          return ctx.slots.register(
            {
              // list 型 slot 契约（dsh-client-ui-slots）：name=槽位键，id=本插件专属条目键（必填），
              // order=排序（升序，默认 0），label=投影显示名。此前缺 id 导致注册被拒、芯片不显示。
              name: "conversation.input.right",
              id: "dsh-copilot",
              order: 100,
              label: "dsh-copilot 操控状态"
            },
            makeChip()
          );
        })
      );
      return function () {
        for (var i = 0; i < disposers.length; i++) {
          try {
            if (typeof disposers[i] === "function") disposers[i]();
          } catch (error) {
            console.warn("[dsh-copilot] disposer 失败：", error);
          }
        }
      };
    }

    var inject = ["slots"];
    exports.apply = apply;
    exports.inject = inject;
    exports.name = "dsh-copilot";
    return module.exports;
  }
});
