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

    let state = {
      sessions: [],
      activeSessionId: null,
      messages: [],
      providers: [],
      activeProviderId: null,
      activeModel: null,
      isStreaming: false,
    };

    function updateState(newState) {
      state = { ...state, ...newState };
      renderSessions();
      renderProviders();
      renderMessages();
      updateInputState();
      updateDebug();
    }

    function updateDebug() {
      const el = $("debugInfo");
      if (!el) return;
      el.style.display = "block";
      el.textContent =
        "sessions:" +
        state.sessions.length +
        " providers:" +
        state.providers.length +
        " msgs:" +
        state.messages.length +
        " activeSession:" +
        (state.activeSessionId ? "yes" : "no") +
        " activeProvider:" +
        (state.activeProviderId || "none");
    }

    setTimeout(() => {
      if (state.sessions.length === 0 || state.providers.length === 0) {
        vscode.postMessage({ type: "requestState" });
      }
    }, 3000);

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
      if (activeId) {
        sessionSelect.value = activeId;
      }
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
      if (state.activeProviderId) {
        providerSelect.value = state.activeProviderId;
      }
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

        const label = document.createElement("div");
        label.className = "msg-label";
        label.textContent = msg.role === "user" ? "你" : "AI";
        div.appendChild(label);

        const bubble = document.createElement("div");
        bubble.className = "bubble";

        if (msg.text) {
          const content = document.createElement("div");
          content.innerHTML = renderMarkdown(msg.text);
          if (msg.isStreaming) {
            content.classList.add("streaming-cursor");
          }
          bubble.appendChild(content);
        } else if (msg.isStreaming) {
          const cursor = document.createElement("span");
          cursor.className = "streaming-cursor";
          cursor.style.display = "inline-block";
          cursor.style.padding = "8px 0";
          bubble.appendChild(cursor);
        }

        for (const tc of msg.toolCalls || []) {
          bubble.appendChild(renderToolCard(tc));
        }

        div.appendChild(bubble);
        messagesEl.appendChild(div);
      }

      if (wasAtBottom || state.messages.length === 0) {
        scrollToBottom();
      }
    }

    function renderToolCard(tc) {
      const card = document.createElement("div");
      card.className = "tool-card";
      card.dataset.toolId = tc.id;

      const header = document.createElement("div");
      header.className = "tool-card-header";
      header.innerHTML =
        '<span class="icon">' +
        (tc.isRunning ? "⏳" : "✅") +
        "</span>" +
        '<span class="name">' +
        escapeHtml(tc.name) +
        "</span>" +
        '<span class="status">' +
        (tc.isRunning ? "执行中…" : "完成") +
        "</span>";
      card.appendChild(header);

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

      card.appendChild(body);

      let isOpen = false;
      header.addEventListener("click", () => {
        isOpen = !isOpen;
        body.classList.toggle("open", isOpen);
      });

      return card;
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
      return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function updateInputState() {
      if (!sendBtn || !inputBox) return;
      sendBtn.textContent = state.isStreaming ? "取消" : "发送";
      sendBtn.className = state.isStreaming ? "send-btn cancel" : "send-btn";
      if (!state.isStreaming) {
        inputBox.disabled = false;
        inputBox.focus();
      } else {
        inputBox.disabled = true;
      }
    }

    function showToast(message) {
      const container = $("toastContainer");
      if (!container) return;
      const toast = document.createElement("div");
      toast.className = "toast";
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(() => {
        toast.remove();
      }, 5000);
    }

    function send() {
      if (state.isStreaming) {
        vscode.postMessage({ type: "cancelResponse" });
        return;
      }
      const text = inputBox.value.trim();
      if (!text) return;
      inputBox.value = "";
      inputBox.style.height = "auto";
      vscode.postMessage({ type: "sendMessage", payload: { text } });
    }

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
        case "error":
          showToast(msg.payload.message);
          break;
      }
    });

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
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".copy-btn");
      if (btn) {
        const code = btn.parentElement.querySelector("code");
        if (code) {
          navigator.clipboard.writeText(code.textContent).then(() => {
            btn.textContent = "✓";
            setTimeout(() => {
              btn.textContent = "复制";
            }, 1500);
          });
        }
      }
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
