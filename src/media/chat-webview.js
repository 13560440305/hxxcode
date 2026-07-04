(function () {
  try {
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    const messagesEl = $("messagesContainer");
    const inputBox = $("inputBox");
    const sendBtn = $("sendBtn");
    const sessionSelect = $("sessionSelect");
    const newSessionBtn = $("newSessionBtn");
    const settingsBtn = $("settingsBtn");
    const providerSelect = $("providerSelect");
    const modelSelect = $("modelSelect");
    const permissionPanel = $("permissionPanel");
    const permissionTitle = $("permissionTitle");
    const permissionDetail = $("permissionDetail");

    const SEND_ICON =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
    const STOP_ICON =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>';

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

    function updateState(newState) {
      state = { ...state, ...newState };
      renderSessions();
      renderProviders();
      renderMessages();
      updateInputState();
    }

    function renderSessions() {
      if (!sessionSelect) return;
      sessionSelect.innerHTML = "";
      for (const s of state.sessions) {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = s.title;
        sessionSelect.appendChild(opt);
      }
      const activeId = state.sessions.some((s) => s.id === state.activeSessionId)
        ? state.activeSessionId
        : state.sessions[0]?.id ?? null;
      if (activeId) sessionSelect.value = activeId;
    }

    function renderProviders() {
      if (!providerSelect) return;
      providerSelect.innerHTML = "";
      for (const p of state.providers) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name + (p.isDefault ? " ★" : "");
        providerSelect.appendChild(opt);
      }
      if (state.activeProviderId) providerSelect.value = state.activeProviderId;
      renderModels();
    }

    function renderModels() {
      if (!modelSelect) return;
      const provider = state.providers.find((p) => p.id === providerSelect.value);
      modelSelect.innerHTML = "";
      if (provider) {
        for (const m of provider.models) {
          const opt = document.createElement("option");
          opt.value = m;
          opt.textContent = m;
          modelSelect.appendChild(opt);
        }
      }
      if (
        state.activeModel &&
        Array.from(modelSelect.options).some((o) => o.value === state.activeModel)
      ) {
        modelSelect.value = state.activeModel;
      }
    }

    function renderMessages() {
      if (!messagesEl) return;
      const wasAtBottom = isAtBottom();
      messagesEl.innerHTML = "";

      for (const msg of state.messages) {
        const div = document.createElement("div");
        div.className = "msg " + msg.role;

        const bubble = document.createElement("div");
        bubble.className = "bubble";

        if (msg.text) {
          const content = document.createElement("div");
          content.innerHTML = renderMarkdown(msg.text);
          if (msg.isStreaming) content.classList.add("streaming-cursor");
          bubble.appendChild(content);
        } else if (msg.isStreaming) {
          const cursor = document.createElement("span");
          cursor.className = "streaming-cursor";
          cursor.style.display = "inline-block";
          bubble.appendChild(cursor);
        }

        for (const tc of msg.toolCalls || []) {
          bubble.appendChild(renderToolCard(tc));
        }

        div.appendChild(bubble);
        messagesEl.appendChild(div);
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
        '<span class="name">' +
        escapeHtml(tc.name) +
        "</span>" +
        '<span class="status">' +
        (tc.isRunning ? "运行中…" : "完成") +
        "</span>";

      const body = document.createElement("div");
      body.className = "tool-card-body";

      const argLabel = document.createElement("div");
      argLabel.className = "label";
      argLabel.textContent = "参数";
      body.appendChild(argLabel);

      const argPre = document.createElement("pre");
      argPre.textContent = tc.input;
      body.appendChild(argPre);

      if (tc.result !== undefined) {
        const resLabel = document.createElement("div");
        resLabel.className = "label";
        resLabel.textContent = "结果";
        body.appendChild(resLabel);

        const resPre = document.createElement("pre");
        resPre.textContent =
          tc.result.length > 2000 ? tc.result.slice(0, 2000) + "\n… (已截断)" : tc.result;
        body.appendChild(resPre);
      }

      card.appendChild(header);
      card.appendChild(body);

      header.addEventListener("click", () => {
        const open = body.classList.toggle("open");
        header.classList.toggle("open", open);
      });

      return card;
    }

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

    function isAtBottom() {
      return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 48;
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function autoResizeInput() {
      if (!inputBox) return;
      inputBox.style.height = "auto";
      inputBox.style.height = Math.min(inputBox.scrollHeight, 140) + "px";
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

    permissionPanel?.querySelectorAll("[data-reply]").forEach((btn) => {
      btn.addEventListener("click", () => {
        replyPermission(btn.getAttribute("data-reply"));
      });
    });

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

    inputBox?.addEventListener("input", autoResizeInput);
    inputBox?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    sendBtn?.addEventListener("click", send);
    sessionSelect?.addEventListener("change", () => {
      vscode.postMessage({ type: "switchSession", payload: { sessionId: sessionSelect.value } });
    });
    newSessionBtn?.addEventListener("click", () => {
      vscode.postMessage({ type: "createSession" });
    });
    settingsBtn?.addEventListener("click", () => {
      vscode.postMessage({ type: "openSettings" });
    });
    providerSelect?.addEventListener("change", () => {
      const provider = state.providers.find((p) => p.id === providerSelect.value);
      if (provider && provider.models.length > 0) {
        vscode.postMessage({
          type: "switchModel",
          payload: { providerId: provider.id, model: provider.models[0] },
        });
      }
    });
    modelSelect?.addEventListener("change", () => {
      vscode.postMessage({
        type: "switchModel",
        payload: { providerId: providerSelect.value, model: modelSelect.value },
      });
    });

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
