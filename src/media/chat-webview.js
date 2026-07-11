(function () {
  try {
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    const messagesEl = $("messagesContainer");
    const inputBox = $("inputBox");
    const sendBtn = $("sendBtn");
    const attachBtn = $("attachBtn");
    const fileInput = $("fileInput");
    const attachPreview = $("attachPreview");
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

    const MAX_ATTACHMENTS = 5;
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    const MAX_TEXT_BYTES = 200 * 1024;
    const MAX_TEXT_CHARS = 100000;
    const IMAGE_EXTS = new Set([
      "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg",
    ]);
    const BLOCKED_EXTS = new Set([
      "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
      "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz",
      "exe", "dll", "so", "dylib", "bin", "dmg", "iso", "msi", "apk",
      "wasm", "class", "jar", "war",
      "mp3", "mp4", "avi", "mov", "mkv", "wav", "flac", "webm",
      "psd", "ai", "sketch", "fig",
      "db", "sqlite", "sqlite3",
    ]);

    /** @type {{ id: string, kind: 'image'|'text', mime: string, name: string, dataUrl?: string, textContent?: string }[]} */
    let pendingAttachments = [];

    let state = {
      sessionList: [],
      activeSessionId: null,
      messages: [],
      providers: [],
      activeProviderId: null,
      activeModel: null,
      isStreaming: false,
    };

    const MAX_VISIBLE_SESSIONS = 20;

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
      const activeSession = state.sessionList.find(
        (s) => s.id === state.activeSessionId
      );
      sessionName.textContent = activeSession ? activeSession.title : "选择会话";

      // 获取搜索关键词
      const searchInput = document.getElementById("sessionSearch");
      const searchTerm = (searchInput?.value ?? "").trim().toLowerCase();

      // 过滤
      let filtered = state.sessionList;
      if (searchTerm) {
        filtered = filtered.filter((s) =>
          s.title.toLowerCase().includes(searchTerm)
        );
      }

      // 渲染（限制显示数量）
      sessionList.innerHTML = "";
      const visible = filtered.slice(0, MAX_VISIBLE_SESSIONS);
      const remaining = filtered.length - visible.length;

      for (const s of visible) {
        const item = document.createElement("div");
        item.className =
          "history-item" + (s.id === state.activeSessionId ? " active" : "");
        item.dataset.sid = s.id;

        const mainDiv = document.createElement("div");
        mainDiv.className = "history-item-main";

        const titleSpan = document.createElement("span");
        titleSpan.className = "t";
        titleSpan.textContent = s.title;
        mainDiv.appendChild(titleSpan);

        if (s.lastPreview) {
          const previewSpan = document.createElement("span");
          previewSpan.className = "preview";
          previewSpan.textContent = s.lastPreview.slice(0, 50);
          mainDiv.appendChild(previewSpan);
        }

        item.appendChild(mainDiv);

        const timeSpan = document.createElement("span");
        timeSpan.className = "time";
        let timeText = timeAgo(s.createdAt);
        if (s.messageCount > 0) {
          timeText += " · " + s.messageCount + " 条";
        }
        timeSpan.textContent = timeText;
        item.appendChild(timeSpan);

        item.addEventListener("click", () => {
          vscode.postMessage({
            type: "switchSession",
            payload: { sessionId: s.id },
          });
          closeDropdown();
        });
        sessionList.appendChild(item);
      }

      // 超出上限提示
      if (remaining > 0) {
        const moreItem = document.createElement("div");
        moreItem.className = "history-item muted";
        moreItem.style.cssText =
          "color: var(--muted); cursor: default; font-size: 11px;";
        if (searchTerm) {
          moreItem.textContent =
            "...还有 " + remaining + " 个匹配会话（请输入更精确的关键词）";
        } else {
          moreItem.textContent =
            "...还有 " +
            remaining +
            " 个会话（使用搜索或归档不活跃会话）";
        }
        sessionList.appendChild(moreItem);
      } else if (searchTerm && visible.length === 0) {
        const noResult = document.createElement("div");
        noResult.className = "history-item muted";
        noResult.style.cssText =
          "color: var(--muted); cursor: default; font-size: 11px;";
        noResult.textContent = "未找到匹配的会话";
        sessionList.appendChild(noResult);
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

        // 附件
        if (msg.attachments && msg.attachments.length > 0) {
          const wrap = document.createElement("div");
          wrap.className = "msg-attachments";
          for (const att of msg.attachments) {
            if (att.kind === "image" && (att.previewUrl || att.dataUrl)) {
              const img = document.createElement("img");
              img.className = "msg-attach-img";
              img.src = att.previewUrl || att.dataUrl;
              img.alt = att.name || "图片";
              img.title = att.name || "点击放大预览";
              img.addEventListener("click", () => {
                openImagePreview(img.src, att.name || "图片");
              });
              wrap.appendChild(img);
            } else {
              const chip = document.createElement("span");
              chip.className = "msg-attach-chip";
              chip.textContent = att.name || "附件";
              chip.title = att.name || "附件";
              wrap.appendChild(chip);
            }
          }
          body.appendChild(wrap);
        }

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

        // 工具调用 — 合并为 Cursor 风格的折叠文件列表
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          body.appendChild(renderToolCallsGroup(msg.toolCalls));
        }

        row.appendChild(body);
        messagesEl.appendChild(row);
      }

      if (wasAtBottom || state.messages.length === 0) scrollToBottom();
    }

    const FILE_MODIFY_TOOLS = new Set([
      "write",
      "edit",
      "search_replace",
      "apply_patch",
      "patch",
      "multiedit",
    ]);
    const FILE_READ_TOOLS = new Set(["read"]);
    const FILE_SEARCH_TOOLS = new Set(["grep", "glob", "list", "ls", "find"]);
    const SHELL_TOOLS = new Set(["bash", "shell", "run_terminal_cmd"]);

    const ACTION_PRIORITY = {
      modified: 4,
      created: 3,
      search: 2,
      read: 1,
      command: 0,
      other: 0,
    };

    function parseToolInput(input) {
      if (!input) return {};
      if (typeof input === "object") return input;
      try {
        return JSON.parse(input);
      } catch {
        return { raw: input };
      }
    }

    function parseToolResult(result) {
      if (!result) return null;
      if (typeof result === "object") return result;
      try {
        return JSON.parse(result);
      } catch {
        return { raw: String(result) };
      }
    }

    function basename(filePath) {
      if (!filePath) return "";
      const normalized = String(filePath).replace(/\\/g, "/");
      const parts = normalized.split("/");
      return parts[parts.length - 1] || normalized;
    }

    function dirname(filePath) {
      if (!filePath) return "";
      const normalized = String(filePath).replace(/\\/g, "/");
      const idx = normalized.lastIndexOf("/");
      return idx >= 0 ? normalized.slice(0, idx) : "";
    }

    function extractFilePath(toolName, input) {
      const data = parseToolInput(input);
      return (
        data.path ||
        data.file_path ||
        data.filePath ||
        data.file ||
        data.target_file ||
        data.relative_workspace_path ||
        null
      );
    }

    function extractCommand(input) {
      const data = parseToolInput(input);
      return data.command || data.cmd || data.raw || "";
    }

    function classifyTool(toolName) {
      if (toolName === "write") return "created";
      if (FILE_MODIFY_TOOLS.has(toolName)) return "modified";
      if (FILE_READ_TOOLS.has(toolName)) return "read";
      if (FILE_SEARCH_TOOLS.has(toolName)) return "search";
      if (SHELL_TOOLS.has(toolName)) return "command";
      return "other";
    }

    function parseChangeStats(toolName, input, result) {
      const resultText =
        typeof result === "string"
          ? result
          : result && result.raw
            ? result.raw
            : result
              ? JSON.stringify(result)
              : "";
      const diffMatch = resultText.match(/(\+\d+)\s*(-\d+)/);
      if (diffMatch) {
        return { label: diffMatch[1] + " " + diffMatch[2], kind: "diff" };
      }

      const addLines = (resultText.match(/^\+(?!\+\+)/gm) || []).length;
      const delLines = (resultText.match(/^-(?!--)/gm) || []).length;
      if (addLines || delLines) {
        return { label: "+" + addLines + " -" + delLines, kind: "diff" };
      }

      if (toolName === "write") return { label: "新建", kind: "created" };
      if (FILE_MODIFY_TOOLS.has(toolName)) return { label: "已修改", kind: "modified" };

      const data = parseToolInput(input);
      if (toolName === "grep" && data.pattern) {
        const p = String(data.pattern);
        return {
          label: '搜索 "' + (p.length > 28 ? p.slice(0, 28) + "…" : p) + '"',
          kind: "search",
        };
      }
      if (toolName === "glob" && (data.pattern || data.glob_pattern)) {
        return { label: "匹配 " + (data.pattern || data.glob_pattern), kind: "search" };
      }
      if (toolName === "read") return { label: "已读取", kind: "read" };
      if (SHELL_TOOLS.has(toolName)) {
        const cmd = extractCommand(input);
        return {
          label: cmd.length > 48 ? cmd.slice(0, 48) + "…" : cmd || "执行命令",
          kind: "command",
        };
      }
      return { label: "", kind: "other" };
    }

    function buildToolActivity(toolCalls) {
      const fileMap = new Map();
      const commands = [];

      for (const tc of toolCalls) {
        const kind = classifyTool(tc.name);
        const filePath = extractFilePath(tc.name, tc.input);
        const stats = parseChangeStats(tc.name, tc.input, tc.result);
        const isRunning = !!tc.isRunning;

        if (kind === "command" || (!filePath && kind === "other")) {
          commands.push({
            id: tc.id,
            kind: "command",
            toolName: tc.name,
            label: stats.label || tc.name,
            isRunning,
          });
          continue;
        }

        if (!filePath && kind === "search") {
          const data = parseToolInput(tc.input);
          commands.push({
            id: tc.id,
            kind: "search",
            toolName: tc.name,
            label: stats.label || tc.name,
            isRunning,
          });
          continue;
        }

        if (!filePath) {
          commands.push({
            id: tc.id,
            kind: kind === "other" ? "command" : kind,
            toolName: tc.name,
            label: stats.label || tc.name,
            isRunning,
          });
          continue;
        }

        const normalizedPath = String(filePath).replace(/\\/g, "/");
        const actionKind = tc.name === "write" ? "created" : kind;
        const existing = fileMap.get(normalizedPath);
        const entry = {
          id: tc.id,
          path: filePath,
          fileName: basename(filePath),
          dirName: dirname(filePath),
          kind: actionKind,
          stats,
          toolName: tc.name,
          isRunning,
        };

        if (!existing) {
          fileMap.set(normalizedPath, entry);
          continue;
        }

        if (ACTION_PRIORITY[actionKind] > ACTION_PRIORITY[existing.kind]) {
          fileMap.set(normalizedPath, { ...entry, isRunning: existing.isRunning || isRunning });
        } else if (isRunning) {
          existing.isRunning = true;
        }
      }

      const files = Array.from(fileMap.values()).sort((a, b) => {
        const prioDiff = ACTION_PRIORITY[b.kind] - ACTION_PRIORITY[a.kind];
        if (prioDiff !== 0) return prioDiff;
        return a.fileName.localeCompare(b.fileName);
      });

      return { files, commands, anyRunning: toolCalls.some((tc) => tc.isRunning) };
    }

    function renderToolCallsGroup(toolCalls) {
      const activity = buildToolActivity(toolCalls);
      const fileCount = activity.files.length;
      const commandCount = activity.commands.length;
      const totalCount = fileCount + commandCount;

      const group = document.createElement("div");
      group.className = "tool-group";

      const header = document.createElement("div");
      header.className = "tool-group-header";

      let title = "";
      if (fileCount > 0 && commandCount > 0) {
        title = fileCount + " 个文件 · " + commandCount + " 步操作";
      } else if (fileCount > 0) {
        title = fileCount + " 个文件";
      } else if (commandCount > 0) {
        title = commandCount + " 步操作";
      } else {
        title = totalCount + " 步操作";
      }

      header.innerHTML =
        '<span class="chevron">▶</span>' +
        '<span class="tool-group-title">' + escapeHtml(title) + "</span>" +
        '<span class="status-pill ' +
        (activity.anyRunning ? "running" : "done") +
        '">' +
        (activity.anyRunning ? "运行中" : "完成") +
        "</span>";

      const body = document.createElement("div");
      body.className = "tool-group-body";

      if (activity.files.length > 0) {
        if (activity.commands.length > 0) {
          const section = document.createElement("div");
          section.className = "tool-group-section";
          section.textContent = "文件";
          body.appendChild(section);
        }
        for (const file of activity.files) {
          body.appendChild(renderFileChangeItem(file));
        }
      }

      if (activity.commands.length > 0) {
        if (activity.files.length > 0) {
          const section = document.createElement("div");
          section.className = "tool-group-section";
          section.textContent = "命令";
          body.appendChild(section);
        }
        for (const cmd of activity.commands) {
          body.appendChild(renderCommandItem(cmd));
        }
      }

      group.appendChild(header);
      group.appendChild(body);

      header.addEventListener("click", () => {
        group.classList.toggle("open");
      });

      return group;
    }

    function renderFileChangeItem(file) {
      const row = document.createElement("div");
      row.className = "file-change-item clickable";

      const badgeClass =
        file.kind === "created"
          ? "created"
          : file.kind === "modified"
            ? "modified"
            : file.kind === "search"
              ? "search"
              : "read";
      const badgeText =
        file.kind === "created" ? "+" : file.kind === "modified" ? "M" : file.kind === "search" ? "G" : "R";

      const statsHtml = renderStatsHtml(file.stats);

      row.innerHTML =
        '<span class="file-badge ' +
        badgeClass +
        '">' +
        badgeText +
        "</span>" +
        '<div class="file-info">' +
        '<span class="file-name" title="' +
        escapeHtml(file.path) +
        '">' +
        escapeHtml(file.fileName) +
        "</span>" +
        '<span class="file-meta">' +
        escapeHtml(file.dirName || file.path) +
        "</span>" +
        "</div>" +
        statsHtml;

      row.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "openFile", payload: { path: file.path } });
      });

      return row;
    }

    function renderCommandItem(cmd) {
      const row = document.createElement("div");
      row.className = "file-change-item";

      row.innerHTML =
        '<span class="file-badge command">$</span>' +
        '<div class="file-info">' +
        '<span class="file-name">' +
        escapeHtml(cmd.toolName) +
        "</span>" +
        '<span class="file-meta">' +
        escapeHtml(cmd.label) +
        "</span>" +
        "</div>" +
        (cmd.isRunning
          ? '<span class="status-pill running">运行中</span>'
          : '<span class="status-pill done">完成</span>');

      return row;
    }

    function renderStatsHtml(stats) {
      if (!stats || !stats.label) return '<span class="file-stats"></span>';
      if (stats.kind === "diff") {
        const parts = stats.label.match(/(\+\d+|\-\d+)/g) || [];
        const html = parts
          .map((part) => {
            const cls = part.startsWith("+") ? "add-part" : "del-part";
            return '<span class="' + cls + '">' + escapeHtml(part) + "</span>";
          })
          .join(" ");
        return '<span class="file-stats">' + html + "</span>";
      }
      return '<span class="file-stats">' + escapeHtml(stats.label) + "</span>";
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
        const activeProvider = state.providers.find(p => p.id === state.activeProviderId);
        statusLeft.textContent = activeProvider ? activeProvider.name : "未连接";
      }
      if (statusRight) {
        statusRight.textContent = state.activeModel || "未选择模型";
      }
    }

    // ── Dropdown / Popover toggles ──

    function toggleDropdown() {
      const wasOpen = historyDropdown?.classList.contains("show");
      if (wasOpen) {
        closeDropdown();
        return;
      }
      historyDropdown?.classList.add("show");
      sessionPicker?.classList.add("open");
      // 清空搜索框并聚焦
      const searchInput = document.getElementById("sessionSearch");
      if (searchInput) {
        searchInput.value = "";
        queueMicrotask(() => searchInput.focus());
      }
    }

    function closeDropdown() {
      historyDropdown?.classList.remove("show");
      sessionPicker?.classList.remove("open");
      const searchInput = document.getElementById("sessionSearch");
      if (searchInput) {
        searchInput.value = "";
      }
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
        if (attachBtn) attachBtn.disabled = true;
        if (fileInput) fileInput.disabled = true;
      } else {
        sendBtn.innerHTML = SEND_ICON;
        sendBtn.className = "send-btn";
        sendBtn.title = "发送";
        inputBox.disabled = false;
        if (attachBtn) attachBtn.disabled = false;
        if (fileInput) fileInput.disabled = false;
        inputBox.focus();
      }
      renderPendingAttachments();
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

    function fileExt(name) {
      const i = (name || "").lastIndexOf(".");
      if (i <= 0 || i === name.length - 1) return "";
      return name.slice(i + 1).toLowerCase();
    }

    function isImageFile(file) {
      if (file.type && file.type.startsWith("image/")) return true;
      return IMAGE_EXTS.has(fileExt(file.name));
    }

    function isBlockedExt(name) {
      const ext = fileExt(name);
      return !!ext && BLOCKED_EXTS.has(ext);
    }

    function uid() {
      return "att_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    }

    function openImagePreview(src, alt) {
      const lightbox = $("imgLightbox");
      const img = $("imgLightboxImg");
      if (!lightbox || !img || !src) return;
      img.src = src;
      img.alt = alt || "预览";
      lightbox.classList.add("show");
    }

    function closeImagePreview() {
      const lightbox = $("imgLightbox");
      const img = $("imgLightboxImg");
      if (!lightbox) return;
      lightbox.classList.remove("show");
      if (img) img.removeAttribute("src");
    }

    function renderPendingAttachments() {
      if (!attachPreview) return;
      attachPreview.innerHTML = "";
      if (!pendingAttachments.length) {
        attachPreview.classList.remove("has-items");
        return;
      }
      attachPreview.classList.add("has-items");
      for (const att of pendingAttachments) {
        if (att.kind === "image") {
          const thumb = document.createElement("div");
          thumb.className = "attach-thumb";
          thumb.title = "点击放大预览";
          const img = document.createElement("img");
          img.src = att.dataUrl;
          img.alt = att.name;
          thumb.appendChild(img);
          thumb.addEventListener("click", () => {
            openImagePreview(att.dataUrl, att.name);
          });
          const rm = document.createElement("button");
          rm.type = "button";
          rm.className = "attach-remove";
          rm.title = "删除";
          rm.textContent = "×";
          rm.disabled = state.isStreaming;
          rm.addEventListener("click", (e) => {
            e.stopPropagation();
            removePendingAttachment(att.id);
          });
          thumb.appendChild(rm);
          attachPreview.appendChild(thumb);
        } else {
          const chip = document.createElement("div");
          chip.className = "attach-chip";
          const name = document.createElement("span");
          name.className = "aname";
          name.textContent = att.name;
          name.title = att.name;
          chip.appendChild(name);
          const rm = document.createElement("button");
          rm.type = "button";
          rm.className = "attach-remove";
          rm.title = "删除";
          rm.textContent = "×";
          rm.disabled = state.isStreaming;
          rm.addEventListener("click", (e) => {
            e.stopPropagation();
            removePendingAttachment(att.id);
          });
          chip.appendChild(rm);
          attachPreview.appendChild(chip);
        }
      }
    }

    function removePendingAttachment(id) {
      pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
      renderPendingAttachments();
    }

    function clearPendingAttachments() {
      pendingAttachments = [];
      renderPendingAttachments();
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("读取失败"));
        reader.readAsDataURL(file);
      });
    }

    function readFileAsText(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("读取失败"));
        reader.readAsText(file);
      });
    }

    async function addFiles(fileList) {
      if (state.isStreaming) return;
      const files = Array.from(fileList || []);
      for (const file of files) {
        if (pendingAttachments.length >= MAX_ATTACHMENTS) {
          showToast(`最多添加 ${MAX_ATTACHMENTS} 个附件`);
          break;
        }
        if (isBlockedExt(file.name)) {
          showToast(`不支持的文件类型: ${file.name}`);
          continue;
        }
        if (isImageFile(file)) {
          if (file.size > MAX_IMAGE_BYTES) {
            showToast(`图片过大（≤5MB）: ${file.name}`);
            continue;
          }
          try {
            const dataUrl = await readFileAsDataUrl(file);
            pendingAttachments.push({
              id: uid(),
              kind: "image",
              mime: file.type || "image/png",
              name: file.name || "image.png",
              dataUrl,
            });
          } catch {
            showToast(`读取图片失败: ${file.name}`);
          }
        } else {
          if (file.size > MAX_TEXT_BYTES) {
            showToast(`文件过大（≤200KB）: ${file.name}`);
            continue;
          }
          try {
            const textContent = await readFileAsText(file);
            if (textContent.length > MAX_TEXT_CHARS) {
              showToast(`文件内容过长: ${file.name}`);
              continue;
            }
            pendingAttachments.push({
              id: uid(),
              kind: "text",
              mime: file.type || "text/plain",
              name: file.name || "file",
              textContent,
            });
          } catch {
            showToast(`读取文件失败: ${file.name}`);
          }
        }
      }
      renderPendingAttachments();
    }

    async function addClipboardImage(file) {
      if (state.isStreaming) return;
      if (pendingAttachments.length >= MAX_ATTACHMENTS) {
        showToast(`最多添加 ${MAX_ATTACHMENTS} 个附件`);
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        showToast("图片过大（≤5MB）");
        return;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const ext = (file.type || "image/png").split("/")[1] || "png";
        pendingAttachments.push({
          id: uid(),
          kind: "image",
          mime: file.type || "image/png",
          name: `paste.${ext === "jpeg" ? "jpg" : ext}`,
          dataUrl,
        });
        renderPendingAttachments();
      } catch {
        showToast("粘贴图片失败");
      }
    }

    function send() {
      if (state.isStreaming) {
        vscode.postMessage({ type: "cancelResponse" });
        return;
      }
      const text = inputBox.value.trim();
      if (!text && pendingAttachments.length === 0) return;
      const attachments = pendingAttachments.map((a) => ({
        id: a.id,
        kind: a.kind,
        mime: a.mime,
        name: a.name,
        dataUrl: a.dataUrl,
        textContent: a.textContent,
      }));
      inputBox.value = "";
      autoResizeInput();
      clearPendingAttachments();
      vscode.postMessage({
        type: "sendMessage",
        payload: { text, attachments },
      });
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

    // Session search input
    const sessionSearch = document.getElementById("sessionSearch");
    if (sessionSearch) {
      sessionSearch.addEventListener("input", () => renderSessions());
      sessionSearch.addEventListener("click", (e) => e.stopPropagation());
      sessionSearch.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          closeDropdown();
        }
      });
    }

    // Input
    inputBox?.addEventListener("input", autoResizeInput);
    inputBox?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    inputBox?.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      let handledImage = false;
      for (const item of items) {
        if (item.type && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void addClipboardImage(file);
            handledImage = true;
            break;
          }
        }
      }
      if (handledImage) return;
    });

    attachBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.isStreaming) return;
      fileInput?.click();
    });

    fileInput?.addEventListener("change", () => {
      if (fileInput.files?.length) {
        void addFiles(fileInput.files);
      }
      fileInput.value = "";
    });

    // Send button
    sendBtn?.addEventListener("click", send);

    // Image lightbox
    const imgLightbox = $("imgLightbox");
    const imgLightboxClose = $("imgLightboxClose");
    const imgLightboxImg = $("imgLightboxImg");
    imgLightboxClose?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeImagePreview();
    });
    imgLightbox?.addEventListener("click", () => closeImagePreview());
    imgLightboxImg?.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeImagePreview();
    });

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
