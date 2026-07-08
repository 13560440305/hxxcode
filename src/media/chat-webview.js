(function () {
  try {
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    const messagesEl = $("messagesContainer");
    const inputBox = $("inputBox");
    const sendBtn = $("sendBtn");
    const sessionPicker = $("sessionPicker");
    const sessionName = $("sessionName");
    const historyDropdown = $("historyDropdown");
    const sessionList = $("sessionList");
    const newSessionBtn = $("newSessionBtn");
    const settingsBtn = $("settingsBtn");
    const modelChip = $("modelChip");
    const modelChipName = $("modelChipName");
    const modelPopover = $("modelPopover");
    const providerChips = $("providerChips");
    const modelList = $("modelList");
    const manageLink = $("manageLink");
    const permissionPanel = $("permissionPanel");
    const permissionTitle = $("permissionTitle");
    const permissionDetail = $("permissionDetail");
    const statusLeft = $("statusLeft");
    const statusRight = $("statusRight");

    const SEND_ICON =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const STOP_ICON =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>';

    let state = {
      sessions: [],
      activeSessionId: null,
      messages: [],
      providers: [],
      activeProviderId: null,
      activeModel: null,
      isStreaming: false,
    };

    let pendingPermissionId = null;

    const ACTION_LABELS = {
      external_directory: "访问工作区外目录",
      edit: "编辑文件",
      write: "写入文件",
      read: "读取文件",
      bash: "执行命令",
      glob: "搜索文件",
      grep: "搜索内容",
    };

    // ── State update ──

    function updateState(newState) {
      state = { ...state, ...newState };
      renderSessions();
      renderProviders();
      renderMessages();
      updateInputState();
      updateStatusBar();
    }

    // ── Session picker ──

    function renderSessions() {
      if (!sessionName || !sessionList) return;
      // 更新标题
      const activeSession = state.sessions.find((s) => s.id === state.activeSessionId);
      sessionName.textContent = activeSession ? activeSession.title : "选择会话";

      // 更新下拉列表
      sessionList.innerHTML = "";
      for (const s of state.sessions) {
        const item = document.createElement("div");
        item.className = "history-item" + (s.id === state.activeSessionId ? " active" : "");
        item.dataset.sid = s.id;
        item.innerHTML =
          '<span class="t">' + escapeHtml(s.title) + '</span>' +
          '<span class="time">' + timeAgo(s.createdAt) + '</span>';
        item.addEventListener("click", () => {
          vscode.postMessage({ type: "switchSession", payload: { sessionId: s.id } });
          closeDropdown();
        });
        sessionList.appendChild(item);
      }
    }

    function timeAgo(ts) {
      const diff = Date.now() - ts;
      if (diff < 60000) return "刚刚";
      if (diff < 3600000) return Math.floor(diff / 60000) + "分钟前";
      if (diff < 86400000) return Math.floor(diff / 3600000) + "小时前";
      return Math.floor(diff / 86400000) + "天前";
    }

    // ── Provider / Model popover ──

    function renderProviders() {
      if (!providerChips) return;
      providerChips.innerHTML = "";
      for (const p of state.providers) {
        const chip = document.createElement("div");
        chip.className = "provider-chip" + (p.id === state.activeProviderId ? " active" : "");
        chip.textContent = p.name;
        chip.dataset.pid = p.id;
        chip.addEventListener("click", () => {
          vscode.postMessage({
            type: "switchModel",
            payload: { providerId: p.id, model: p.models[0] || "" },
          });
          // popover 不自动关闭，让用户进一步选择模型
        });
        providerChips.appendChild(chip);
      }
      renderModels();
    }

    function renderModels() {
      if (!modelList) return;
      const provider = state.providers.find((p) => p.id === state.activeProviderId);
      modelList.innerHTML = "";
      if (provider) {
        for (const m of provider.models) {
          const item = document.createElement("div");
          item.className = "model-item" + (m === state.activeModel ? " active" : "");
          item.textContent = m;
          item.dataset.model = m;
          item.addEventListener("click", () => {
            vscode.postMessage({
              type: "switchModel",
              payload: { providerId: provider.id, model: m },
            });
            closePopover();
          });
          modelList.appendChild(item);
        }
      }
      updateModelChip();
    }

    function updateModelChip() {
      if (!modelChipName) return;
      modelChipName.textContent = state.activeModel || "选择模型";
    }

    // ── Messages ──

    function renderMessages() {
      if (!messagesEl) return;
      const wasAtBottom = isAtBottom();
      messagesEl.innerHTML = "";

      for (const msg of state.messages) {
        const row = document.createElement("div");
        row.className = "msg-row " + (msg.role === "user" ? "user" : "assistant");

        // 头像
        const avatar = document.createElement("div");
        avatar.className = "avatar " + msg.role;
        avatar.textContent = msg.role === "user" ? "你" : "AI";
        row.appendChild(avatar);

        // 消息体
        const body = document.createElement("div");
        body.className = "msg-body";

        // 文本内容
        if (msg.text) {
          const textDiv = document.createElement("div");
          textDiv.className = "msg-text" + (msg.text.startsWith("**错误**") ? " error" : "");
          textDiv.innerHTML = renderMarkdown(msg.text);
          if (msg.isStreaming) textDiv.classList.add("streaming-cursor");
          body.appendChild(textDiv);
        } else if (msg.isStreaming) {
          const cursor = document.createElement("span");
          cursor.className = "streaming-cursor";
          cursor.style.display = "inline-block";
          body.appendChild(cursor);
        }

        // 工具卡片
        for (const tc of msg.toolCalls || []) {
          body.appendChild(renderToolCard(tc));
        }

        row.appendChild(body);
        messagesEl.appendChild(row);
      }

      if (wasAtBottom || state.messages.length === 0) scrollToBottom();
    }

    function renderToolCard(tc) {
      const card = document.createElement("div");
      card.className = "tool-card";

      const header = document.createElement("div");
      header.className = "tool-card-header";
      header.innerHTML =
        '<span class="chevron">▶</span>' +
        '<span class="tname">' + escapeHtml(tc.name) + '</span>' +
        '<span class="tsummary">' + escapeHtml(tc.input && tc.input.length > 80 ? tc.input.slice(0, 80) + "…" : tc.input || "") + '</span>' +
        '<span class="status-pill ' + (tc.isRunning ? "running" : "done") + '">' +
        (tc.isRunning ? "运行中" : "完成") +
        "</span>";

      const body = document.createElement("div");
      body.className = "tool-card-body";
      body.textContent = tc.result || tc.input || "";

      card.appendChild(header);
      card.appendChild(body);

      header.addEventListener("click", () => {
        card.classList.toggle("open");
      });

      return card;
    }

    // ── Permission panel ──

    function showPermissionRequest(payload) {
      pendingPermissionId = payload.id;
      const actionLabel = ACTION_LABELS[payload.action] || payload.action;
      permissionTitle.textContent = "需要确认：" + actionLabel;
      permissionDetail.textContent = (payload.resources || []).join("\n") || "未知范围";
      permissionPanel?.classList.remove("hidden");
      scrollToBottom();
    }

    function hidePermissionRequest() {
      pendingPermissionId = null;
      permissionPanel?.classList.add("hidden");
    }

    function replyPermission(reply) {
      if (!pendingPermissionId) return;
      vscode.postMessage({
        type: "permissionReply",
        payload: { id: pendingPermissionId, reply },
      });
      hidePermissionRequest();
    }

    // ── Streaming updates ──

    function updateStreamingChunk(_sessionId, _chunk, accumulatedText) {
      const lastMsg = state.messages[state.messages.length - 1];
      if (!lastMsg || lastMsg.role !== "assistant") return;
      lastMsg.text = accumulatedText;
      renderMessages();
    }

    function updateToolStart(_sessionId, toolCallId, toolName, toolInput) {
      const lastMsg = state.messages[state.messages.length - 1];
      if (!lastMsg || lastMsg.role !== "assistant") return;
      lastMsg.toolCalls.push({
        id: toolCallId,
        name: toolName,
        input: toolInput,
        isRunning: true,
      });
      renderMessages();
    }

    function updateToolEnd(_sessionId, toolCallId, toolResult) {
      const lastMsg = state.messages[state.messages.length - 1];
      if (!lastMsg || lastMsg.role !== "assistant") return;
      const tc = lastMsg.toolCalls.find((t) => t.id === toolCallId);
      if (tc) {
        tc.isRunning = false;
        tc.result = toolResult;
      }
      renderMessages();
    }

    // ── Status bar ──

    function updateStatusBar() {
      if (statusLeft) {
        statusLeft.textContent = "sessions: " + state.sessions.length + " · msgs: " + state.messages.length;
      }
      if (statusRight) {
        const model = state.activeModel || "";
        statusRight.textContent = model ? "lildax · " + model : "lildax";
      }
    }

    // ── Dropdown / Popover toggles ──

    function toggleDropdown() {
      historyDropdown?.classList.toggle("show");
      sessionPicker?.classList.toggle("open");
    }

    function closeDropdown() {
      historyDropdown?.classList.remove("show");
      sessionPicker?.classList.remove("open");
    }

    function togglePopover() {
      modelPopover?.classList.toggle("show");
    }

    function closePopover() {
      modelPopover?.classList.remove("show");
    }

    // ── Markdown ──

    function renderMarkdown(text) {
      const parts = text.split(/(```[\s\S]*?```)/g);
      return parts
        .map((part, i) => {
          if (i % 2 === 1) {
            const inner = part.replace(/^```(\w*)\n?/, "").replace(/\n?```$/, "");
            const lang = (part.match(/^```(\w*)/) || [])[1] || "";
            return (
              '<pre><code class="lang-' +
              escapeHtml(lang) +
              '">' +
              escapeHtml(inner) +
              "</code></pre>"
            );
          }
          return renderInline(part);
        })
        .join("");
    }

    function renderInline(text) {
      let html = escapeHtml(text);
      html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
      html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
      html = html.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>'
      );
      html = html.replace(/\n{2,}/g, "</p><p>");
      html = html.replace(/\n/g, "<br/>");
      html = html.replace(/^[-*]\s+(.+)$/gm, "<li>$1</li>");
      html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");
      return "<p>" + html + "</p>";
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    // ── Utilities ──

    function isAtBottom() {
      return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 48;
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function autoResizeInput() {
      if (!inputBox) return;
      inputBox.style.height = "auto";
      inputBox.style.height = Math.min(inputBox.scrollHeight, 120) + "px";
    }

    function updateInputState() {
      if (!sendBtn || !inputBox) return;
      if (state.isStreaming) {
        sendBtn.innerHTML = STOP_ICON;
        sendBtn.className = "send-btn cancel";
        sendBtn.title = "取消";
        inputBox.disabled = true;
      } else {
        sendBtn.innerHTML = SEND_ICON;
        sendBtn.className = "send-btn";
        sendBtn.title = "发送";
        inputBox.disabled = false;
        inputBox.focus();
      }
    }

    function showToast(message) {
      const container = $("toastContainer");
      if (!container) return;
      const toast = document.createElement("div");
      toast.className = "toast";
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(() => toast.remove(), 5000);
    }

    function send() {
      if (state.isStreaming) {
        vscode.postMessage({ type: "cancelResponse" });
        return;
      }
      const text = inputBox.value.trim();
      if (!text) return;
      inputBox.value = "";
      autoResizeInput();
      vscode.postMessage({ type: "sendMessage", payload: { text } });
    }

    // ── Event listeners ──

    // Permission buttons
    permissionPanel?.querySelectorAll("[data-reply]").forEach((btn) => {
      btn.addEventListener("click", () => {
        replyPermission(btn.getAttribute("data-reply"));
      });
    });

    // Session picker
    sessionPicker?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDropdown();
    });

    newSessionBtn?.addEventListener("click", () => {
      closeDropdown();
      vscode.postMessage({ type: "createSession" });
    });

    // Model chip
    modelChip?.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePopover();
    });

    // Manage link
    manageLink?.addEventListener("click", () => {
      closePopover();
      vscode.postMessage({ type: "openSettings" });
    });

    // Settings button
    settingsBtn?.addEventListener("click", () => {
      vscode.postMessage({ type: "openSettings" });
    });

    // Outside click closes dropdown and popover
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".session-bar")) {
        closeDropdown();
      }
      if (!e.target.closest(".composer") || e.target.closest(".manage-link")) {
        closePopover();
      }
    });

    // Input
    inputBox?.addEventListener("input", autoResizeInput);
    inputBox?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    // Send button
    sendBtn?.addEventListener("click", send);

    // ── Webview messages from extension ──

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case "state":
          updateState(msg.payload);
          break;
        case "messageChunk":
          updateStreamingChunk(
            msg.payload.sessionId,
            msg.payload.chunk,
            msg.payload.accumulatedText
          );
          break;
        case "toolStart":
          updateToolStart(
            msg.payload.sessionId,
            msg.payload.toolCallId,
            msg.payload.toolName,
            msg.payload.toolInput
          );
          break;
        case "toolEnd":
          updateToolEnd(msg.payload.sessionId, msg.payload.toolCallId, msg.payload.toolResult);
          break;
        case "permissionRequest":
          showPermissionRequest(msg.payload);
          break;
        case "error":
          showToast(msg.payload.message);
          break;
      }
    });

    // ── Boot ──

    const bootEl = document.getElementById("boot-state");
    if (bootEl && bootEl.textContent) {
      try {
        updateState(JSON.parse(bootEl.textContent));
      } catch (err) {
        console.error("[HxxCode webview] boot state parse failed:", err);
        renderMessages();
        updateInputState();
      }
    } else {
      renderMessages();
      updateInputState();
    }

    vscode.postMessage({ type: "ready" });
  } catch (err) {
    document.body.innerHTML =
      '<div style="padding:20px;color:var(--vscode-errorForeground,#f48771)">' +
      "<h3>HxxCode 加载出错</h3><pre style=\"white-space:pre-wrap;font-size:12px\">" +
      (err instanceof Error ? err.stack || err.message : String(err)) +
      "</pre></div>";
  }
})();
