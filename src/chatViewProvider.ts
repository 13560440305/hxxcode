import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { OpencodeManager, StreamEvent } from "./opencodeManager";
import { ProviderStore, ProviderConfig } from "./providerStore";
import { log, showDiag } from "./log";
import { getSessionsDir, getSessionPath, ensureDirs, readJSON } from "./storage";

// ── Data types ───────────────────────────────────────────────────────────────

interface SessionInfo {
  id: string;
  title: string;
  createdAt: number;
}

interface ToolCallDisplay {
  id: string;
  name: string;
  input: string;     // JSON stringified
  result?: string;   // JSON stringified
  isRunning: boolean;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  toolCalls: ToolCallDisplay[];
  isStreaming: boolean;
}

interface SessionData {
  info: SessionInfo;
  messages: ChatMessage[];
}

type WebviewMessage =
  | { type: "ready" }
  | { type: "sendMessage"; payload: { text: string } }
  | { type: "createSession" }
  | { type: "switchSession"; payload: { sessionId: string } }
  | { type: "switchModel"; payload: { providerId: string; model: string } }
  | { type: "cancelResponse" }
  | { type: "deleteSession"; payload: { sessionId: string } }
  | { type: "retryLastMessage" }
  | { type: "openSettings" }
  | { type: "requestState" };

// ── Markdown 渲染器（极简实现，无外部依赖） ──────────────────────────────────

function renderMarkdown(text: string): string {
  // 按代码块分割，代码块内不做其它转换
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        // 代码块
        const inner = part.replace(/^```(\w*)\n?/, "").replace(/\n?```$/, "");
        const lang = part.match(/^```(\w*)/)?.[1] ?? "";
        return `<pre><code class="lang-${lang}">${escapeHtml(inner)}</code></pre>`;
      }
      // 行内内容
      return renderInline(part);
    })
    .join("");
}

function renderInline(text: string): string {
  let html = escapeHtml(text);

  // 行内代码 `code`
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // 加粗 **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // 斜体 *text*
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // 链接 [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // 行（多个换行分段）
  html = html.replace(/\n{2,}/g, "</p><p>");

  // 单行换行变 <br>
  html = html.replace(/\n/g, "<br/>");

  // 无序列表
  html = html.replace(/^[-*]\s+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");

  return `<p>${html}</p>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatJSON(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

function shortId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── WebviewViewProvider ───────────────────────────────────────────────────────

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencodeBridge.chatView";
  /** 由 extension.ts 在 settings 保存时调用，刷新聊天视图的 state */
  private static _instance: ChatViewProvider | null = null;

  static notifyProviderChanged(): void {
    ChatViewProvider._instance?.postState();
  }

  private _view?: vscode.WebviewView;
  private sessions: SessionData[] = [];
  private activeSessionId: string | null = null;
  private abortController: AbortController | null = null;
  private sessionsLoaded = false;
  private webviewReady = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly opencodeManager: OpencodeManager,
    private readonly providerStore: ProviderStore
  ) {
    ChatViewProvider._instance = this;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    log("resolveWebviewView 被调用");
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      log("收到 webview 消息:", msg.type);
      void this.handleMessage(msg);
    });

    // 当视图重新变为可见时（如从设置面板切回），刷新最新 state
    webviewView.onDidChangeVisibility(() => {
      log("视图可见性变化:", webviewView.visible);
      if (webviewView.visible) {
        if (!this.webviewReady) {
          log("webview 可见但未 ready，重新渲染 HTML");
          this.setWebviewHtml(webviewView);
        }
        this.postState();
      }
    });

    void this.initWebview(webviewView);
  }

  /** 先加载会话数据，再渲染 webview（内嵌 state 才有完整下拉选项） */
  private async initWebview(webviewView: vscode.WebviewView): Promise<void> {
    this.webviewReady = false;

    await this.loadSessionsFromDisk();

    if (this.sessions.length === 0) {
      log("会话列表为空，创建新会话");
      try {
        await this.createSession();
      } catch (err) {
        const msg = (err as Error).message;
        log("createSession 失败:", msg);
        this.postError(`创建会话失败: ${msg}`);
      }
    } else {
      log("已有会话:", this.sessions.length);
    }

    this.setWebviewHtml(webviewView);
  }

  private setWebviewHtml(webviewView: vscode.WebviewView): void {
    this.webviewReady = false;
    webviewView.webview.html = this.renderHtml(
      webviewView.webview,
      this.buildStatePayload()
    );
    log(
      "webview HTML 已渲染, sessions:",
      this.sessions.length,
      "providers:",
      this.providerStore.list().length
    );
  }

  // ── 向 Webview 发送消息 ─────────────────────────────────────────────────

  private postMessage(msg: Record<string, unknown>): void {
    log("postMessage:", msg.type, msg.type === "state" ? JSON.stringify(msg.payload).slice(0, 200) + "..." : "");
    this._view?.webview.postMessage(msg);
  }

  private postError(message: string): void {
    log("postError:", message);
    this.postMessage({ type: "error", payload: { message } });
  }

  private buildStatePayload() {
    // activeSessionId 可能与 session.info.id 不一致（例如 OpenCode 返回了新 id）
    if (
      this.activeSessionId &&
      !this.sessions.some((s) => s.info.id === this.activeSessionId)
    ) {
      this.activeSessionId = this.sessions[0]?.info.id ?? null;
    }

    const session = this.getActiveSession();
    const { provider, model } = this.providerStore.getActive();

    return {
      sessions: [...this.sessions]
        .sort((a, b) => b.info.createdAt - a.info.createdAt)
        .map((s) => s.info),
      activeSessionId: this.activeSessionId,
      messages: session?.messages ?? [],
      providers: this.providerStore.list(),
      activeProviderId: provider?.id ?? null,
      activeModel: model,
      isStreaming: !!this.abortController,
    };
  }

  private postState(): void {
    const payload = this.buildStatePayload();

    log("postState — sessions:", this.sessions.length, "providers:", this.providerStore.list().length);
    log("  activeSessionId:", payload.activeSessionId);
    log("  provider:", payload.activeProviderId, "model:", payload.activeModel);
    log("  providerStore.list():", JSON.stringify(payload.providers.map(p => ({ id: p.id, name: p.name, models: p.models, isDefault: p.isDefault }))));
    log("  messages:", payload.messages.length);
    log("  webviewReady:", this.webviewReady);

    if (!this.webviewReady) {
      log("  webview 尚未 ready，state 将在 ready 后重发");
    }

    this.postMessage({ type: "state", payload });
  }

  // ── 消息处理 ──────────────────────────────────────────────────────────────

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    log("handleMessage:", msg.type);
    switch (msg.type) {
      case "ready":
        this.webviewReady = true;
        this.postState();
        break;

      case "sendMessage":
        await this.handleSendMessage(msg.payload.text);
        break;

      case "createSession":
        await this.createSession();
        break;

      case "switchSession":
        this.activeSessionId = msg.payload.sessionId;
        this.postState();
        break;

      case "switchModel":
        try {
          await this.opencodeManager.switchModel(
            msg.payload.providerId,
            msg.payload.model
          );
          this.postState();
        } catch (err) {
          this.postError(`切换模型失败: ${(err as Error).message}`);
        }
        break;

      case "cancelResponse":
        this.cancelResponse();
        break;

      case "deleteSession":
        this.deleteSession(msg.payload.sessionId);
        break;

      case "retryLastMessage":
        await this.retryLastMessage();
        break;

      case "openSettings":
        vscode.commands.executeCommand("opencodeBridge.openSettings");
        break;

      case "requestState":
        this.postState();
        break;
    }
  }

  // ── 会话管理 ──────────────────────────────────────────────────────────────

  /** 按已有会话数量生成不重复标题 */
  private nextSessionTitle(): string {
    return `会话 ${this.sessions.length + 1}`;
  }

  /** 按创建时间重新编号，避免多个「会话 1」 */
  private renumberSessionTitles(): void {
    const sorted = [...this.sessions].sort(
      (a, b) => a.info.createdAt - b.info.createdAt
    );
    sorted.forEach((s, i) => {
      s.info.title = `会话 ${i + 1}`;
    });
  }

  /** 合并多次调试产生的空会话，只保留最新的一个空会话 */
  private consolidateEmptySessions(): void {
    const withMessages = this.sessions.filter((s) => s.messages.length > 0);
    const empty = this.sessions
      .filter((s) => s.messages.length === 0)
      .sort((a, b) => b.info.createdAt - a.info.createdAt);
    const before = this.sessions.length;
    this.sessions = [...withMessages, ...empty.slice(0, 1)].sort(
      (a, b) => b.info.createdAt - a.info.createdAt
    );
    if (this.sessions.length < before) {
      log("consolidateEmptySessions: 移除", before - this.sessions.length, "个重复空会话");
      if (
        this.activeSessionId &&
        !this.sessions.some((s) => s.info.id === this.activeSessionId)
      ) {
        this.activeSessionId = this.sessions[0]?.info.id ?? null;
      }
      void this.saveSessionsToDisk();
    }
  }

  private async createSession(): Promise<string> {
    const id = shortId();
    log("createSession, id:", id, "total:", this.sessions.length + 1);
    const session: SessionData = {
      info: {
        id,
        title: this.nextSessionTitle(),
        createdAt: Date.now(),
      },
      messages: [],
    };

    this.sessions.push(session);
    this.activeSessionId = id;
    this.postState();

    const result = await this.opencodeManager.createSession(session.info.title);
    const oldId = session.info.id;
    session.info.id = result.id;
    if (this.activeSessionId === oldId) {
      this.activeSessionId = result.id;
    }
    this.postState();
    void this.saveSessionsToDisk();

    return session.info.id;
  }

  private deleteSession(sessionId: string): void {
    this.sessions = this.sessions.filter((s) => s.info.id !== sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions[0]?.info.id ?? null;
    }
    this.postState();
    this.saveSessionsToDisk();
  }

  private getActiveSession(): SessionData | undefined {
    return this.sessions.find((s) => s.info.id === this.activeSessionId);
  }

  // ── 会话持久化（~/.hxxcode/sessions/） ─────────────────────────────────────

  private async loadSessionsFromDisk(): Promise<void> {
    if (this.sessionsLoaded) return;
    this.sessionsLoaded = true;
    try {
      await ensureDirs();
      const sessionsDir = getSessionsDir();
      const files = await fs.readdir(sessionsDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

      for (const file of jsonFiles) {
        const data = await readJSON<SessionData | null>(
          path.join(sessionsDir, file),
          null
        );
        if (data && data.info && data.messages) {
          // 避免和当前活跃会话重复
          if (!this.sessions.find((s) => s.info.id === data.info.id)) {
            this.sessions.push(data);
          }
        }
      }
      log("loadSessionsFromDisk: 加载了", this.sessions.length, "个会话");
      if (this.sessions.length > 0) {
        this.consolidateEmptySessions();
        this.renumberSessionTitles();
        if (!this.activeSessionId) {
          this.activeSessionId = this.sessions[0]?.info.id ?? null;
        }
        void this.saveSessionsToDisk();
        this.postState();
      }
    } catch (err) {
      log("loadSessionsFromDisk 出错:", String(err));
    }
  }

  private async saveSessionsToDisk(): Promise<void> {
    try {
      await ensureDirs();
      // 清理旧 session 文件，只保留当前存在的
      const sessionsDir = getSessionsDir();
      const sessionIds = new Set(this.sessions.map((s) => s.info.id));
      const files = await fs.readdir(sessionsDir).catch(() => []);
      for (const file of files) {
        if (file.endsWith(".json") && !sessionIds.has(file.replace(/\.json$/, ""))) {
          await fs.unlink(path.join(sessionsDir, file)).catch(() => {});
        }
      }
      // 写入每个会话
      for (const session of this.sessions) {
        const filePath = getSessionPath(session.info.id);
        await fs.writeFile(filePath, JSON.stringify(session, null, 2), "utf-8");
      }
    } catch (err) {
      log("saveSessionsToDisk 出错:", String(err));
    }
  }

  // ── 发送消息 ──────────────────────────────────────────────────────────────

  private async handleSendMessage(text: string): Promise<void> {
    showDiag();
    const flowT0 = Date.now();
    const flow = (step: string, detail?: unknown) => {
      const elapsed = Date.now() - flowT0;
      log(`[flow/send +${elapsed}ms] ${step}`, detail ?? "");
    };

    flow("用户点击发送", { textLen: text.length, preview: text.slice(0, 60) });

    let session = this.getActiveSession();
    if (!session) {
      flow("无活跃 session，创建新 session");
      await this.createSession();
      session = this.getActiveSession();
      if (!session) {
        flow("✗ 创建 session 失败");
        return;
      }
    }
    flow("活跃 session", { id: session.info.id, title: session.info.title });

    // 追加用户消息
    session.messages.push({
      role: "user",
      text,
      toolCalls: [],
      isStreaming: false,
    });

    // 创建占位的 assistant 消息（流式输出会不断更新它）
    const assistantMsg: ChatMessage = {
      role: "assistant",
      text: "",
      toolCalls: [],
      isStreaming: true,
    };
    session.messages.push(assistantMsg);

    this.postState();

    // 自动重命名会话（第一轮对话时）
    if (session.messages.filter((m) => m.role === "user").length === 1) {
      session.info.title = text.slice(0, 40) + (text.length > 40 ? "…" : "");
    }

    this.abortController = new AbortController();

    try {
      flow("ensureBackendSession 开始");
      const backendId = await this.opencodeManager.ensureBackendSession(
        session.info.id,
        session.info.title
      );
      flow("ensureBackendSession 完成", { backendId });
      if (backendId !== session.info.id) {
        flow("session ID 已更新", { from: session.info.id, to: backendId });
        session.info.id = backendId;
        this.postState();
        void this.saveSessionsToDisk();
      }

      flow("promptStream 开始");
      await this.opencodeManager.promptStream(
        backendId,
        text,
        (event) => {
          if (event.type !== "text") {
            flow("收到事件", { type: event.type, error: event.error });
          }
          this.handleStreamEvent(session!.info.id, event);
        },
        this.abortController.signal
      );
      flow("promptStream 返回");
    } catch (err) {
      const msg = (err as Error).message;
      flow("✗ 发送失败", msg);
      if (
        msg.includes("aborted") ||
        msg.includes("cancel") ||
        msg.includes("terminated")
      ) {
        assistantMsg.text += "\n\n*已取消*";
      } else {
        this.postError(msg);
        assistantMsg.text += `\n\n**错误**: ${msg}`;
      }
    } finally {
      flow("发送流程结束", { totalMs: Date.now() - flowT0 });
      assistantMsg.isStreaming = false;
      this.abortController = null;
      this.postState();
      this.saveSessionsToDisk();
    }
  }

  // ── 流式事件处理 ──────────────────────────────────────────────────────────

  private handleStreamEvent(sessionId: string, event: StreamEvent): void {
    const session = this.sessions.find((s) => s.info.id === sessionId);
    if (!session) return;

    const lastMsg = session.messages[session.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;

    switch (event.type) {
      case "text":
        if (event.text) {
          lastMsg.text += event.text;
          // 逐字推送至 webview
          this.postMessage({
            type: "messageChunk",
            payload: {
              sessionId,
              chunk: event.text,
              accumulatedText: lastMsg.text,
            },
          });
        }
        break;

      case "tool_use":
        if (event.toolCallId && event.toolName) {
          const toolCall: ToolCallDisplay = {
            id: event.toolCallId,
            name: event.toolName,
            input: formatJSON(event.toolInput ?? {}),
            isRunning: true,
          };
          lastMsg.toolCalls.push(toolCall);
          this.postMessage({
            type: "toolStart",
            payload: {
              sessionId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              toolInput: formatJSON(event.toolInput ?? {}),
            },
          });
        }
        break;

      case "tool_result":
        if (event.toolCallId) {
          const tc = lastMsg.toolCalls.find((t) => t.id === event.toolCallId);
          if (tc) {
            tc.isRunning = false;
            tc.result = formatJSON(event.toolResult);
            this.postMessage({
              type: "toolEnd",
              payload: {
                sessionId,
                toolCallId: event.toolCallId,
                toolResult: tc.result,
              },
            });
          }
        }
        break;

      case "error":
        if (event.error) {
          lastMsg.text += `\n\n**错误**: ${event.error}`;
          this.postError(event.error);
        }
        break;

      case "finish":
        // 由调用方处理
        break;
    }
  }

  // ── 取消 / 重试 ───────────────────────────────────────────────────────────

  private cancelResponse(): void {
    this.abortController?.abort();
  }

  private async retryLastMessage(): Promise<void> {
    const session = this.getActiveSession();
    if (!session) return;
    const userMessages = session.messages.filter((m) => m.role === "user");
    if (userMessages.length === 0) return;
    const lastUserMsg = userMessages[userMessages.length - 1];

    // 删除最后两轮消息（最后一个 user + 最后一个 assistant，如果有的话）
    if (
      session.messages.length >= 2 &&
      session.messages[session.messages.length - 1].role === "assistant"
    ) {
      session.messages.pop();
    }
    if (
      session.messages.length >= 1 &&
      session.messages[session.messages.length - 1].role === "user"
    ) {
      session.messages.pop();
    }

    this.postState();
    await this.handleSendMessage(lastUserMsg.text);
  }

  // ── Webview HTML ──────────────────────────────────────────────────────────

  private renderSelectOptionsHtml(
    state: ReturnType<ChatViewProvider["buildStatePayload"]>
  ): { sessions: string; providers: string; models: string } {
    const sessions = state.sessions
      .map((s) => {
        const selected = s.id === state.activeSessionId ? " selected" : "";
        return `<option value="${escapeHtml(s.id)}"${selected}>${escapeHtml(s.title)}</option>`;
      })
      .join("");

    const providers = state.providers
      .map((p) => {
        const selected = p.id === state.activeProviderId ? " selected" : "";
        const star = p.isDefault ? " ★" : "";
        return `<option value="${escapeHtml(p.id)}"${selected}>${escapeHtml(p.name)}${star}</option>`;
      })
      .join("");

    const activeProvider =
      state.providers.find((p) => p.id === state.activeProviderId) ?? state.providers[0];
    const models = (activeProvider?.models ?? [])
      .map((m) => {
        const selected = m === state.activeModel ? " selected" : "";
        return `<option value="${escapeHtml(m)}"${selected}>${escapeHtml(m)}</option>`;
      })
      .join("");

    return { sessions, providers, models };
  }

  private renderHtml(
    webview: vscode.Webview,
    initialState: ReturnType<ChatViewProvider["buildStatePayload"]>
  ): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat-webview.js")
    );
    const cspSource = webview.cspSource;
    const bootJson = JSON.stringify(initialState).replace(/</g, "\\u003c");
    const selects = this.renderSelectOptionsHtml(initialState);

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource};" />
<style>
  :root {
    --bg: var(--vscode-sideBar-background, #1e1e1e);
    --fg: var(--vscode-sideBar-foreground, #cccccc);
    --border: var(--vscode-widget-border, #444444);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-fg: var(--vscode-input-foreground, #cccccc);
    --input-border: var(--vscode-input-border, #555555);
    --badge-bg: var(--vscode-badge-background, #4d4d4d);
    --link-fg: var(--vscode-textLink-foreground, #3794ff);
    --code-bg: var(--vscode-textCodeBlock-background, #2d2d2d);
    --btn-bg: var(--vscode-button-background, #0e639c);
    --btn-fg: var(--vscode-button-foreground, #ffffff);
    --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
    --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    --mono-font: var(--vscode-editor-font-family, "Cascadia Code", "Fira Code", "JetBrains Mono", monospace);
    --radius: 6px;
    --msg-max-width: 90%;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--font);
    font-size: 13px;
    background: var(--bg);
    color: var(--fg);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  /* ── Header ─────────────────────────────────── */
  .header {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
  }
  .header-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .header-row select {
    flex: 1;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: var(--radius);
    padding: 3px 6px;
    font-size: 12px;
    cursor: pointer;
    -webkit-appearance: menulist;
    appearance: menulist;
  }
  .header-row select option {
    color: var(--vscode-foreground, #cccccc);
    background: var(--vscode-dropdown-background, #3c3c3c);
  }
  .header-row button {
    background: none;
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: var(--radius);
    padding: 3px 8px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .header-row button:hover {
    background: var(--badge-bg);
  }
  .session-select {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── Messages ────────────────────────────────── */
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .messages:empty::after {
    content: "输入消息开始与 AI 对话…";
    display: block;
    text-align: center;
    color: var(--border);
    font-size: 13px;
    margin-top: 40px;
    opacity: 0.7;
  }

  .msg {
    max-width: var(--msg-max-width);
    line-height: 1.55;
    animation: fadeIn 0.15s ease;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .msg.user {
    align-self: flex-end;
  }
  .msg.user .bubble {
    background: var(--btn-bg);
    color: var(--btn-fg);
    border-radius: 12px 12px 4px 12px;
    padding: 8px 14px;
    word-break: break-word;
  }

  .msg.assistant {
    align-self: flex-start;
    width: 100%;
  }
  .msg.assistant .bubble {
    background: var(--code-bg);
    border-radius: 12px 12px 12px 4px;
    padding: 10px 14px;
    word-break: break-word;
  }

  .msg-label {
    font-size: 11px;
    opacity: 0.6;
    margin-bottom: 4px;
    padding: 0 4px;
  }
  .msg.user .msg-label { text-align: right; }

  /* ── Content styling ─────────────────────────── */
  .bubble p { margin: 4px 0; }
  .bubble p:first-child { margin-top: 0; }
  .bubble p:last-child { margin-bottom: 0; }
  .bubble code {
    font-family: var(--mono-font);
    font-size: 12px;
    background: rgba(255,255,255,0.1);
    padding: 1px 5px;
    border-radius: 3px;
  }
  .bubble pre {
    margin: 8px 0;
    position: relative;
  }
  .bubble pre code {
    display: block;
    padding: 10px 12px;
    overflow-x: auto;
    background: rgba(0,0,0,0.3);
    border-radius: var(--radius);
    font-size: 12px;
    line-height: 1.45;
    white-space: pre;
    word-break: normal;
  }
  .bubble pre .copy-btn {
    position: absolute;
    top: 4px;
    right: 4px;
    background: rgba(255,255,255,0.1);
    border: none;
    color: var(--fg);
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .bubble pre:hover .copy-btn { opacity: 1; }
  .bubble pre .copy-btn:hover { background: rgba(255,255,255,0.2); }
  .bubble a { color: var(--link-fg); }
  .bubble ul { padding-left: 20px; margin: 4px 0; }
  .bubble li { margin: 2px 0; }
  .bubble strong { font-weight: 600; }
  .bubble em { font-style: italic; }

  /* ── Streaming cursor ────────────────────────── */
  .streaming-cursor::after {
    content: "▍";
    display: inline-block;
    animation: blink 0.8s step-end infinite;
    color: var(--link-fg);
  }
  @keyframes blink { 50% { opacity: 0; } }

  /* ── Tool call card ──────────────────────────── */
  .tool-card {
    margin: 8px 0 4px 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .tool-card-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    cursor: pointer;
    user-select: none;
    font-size: 12px;
    background: rgba(255,255,255,0.03);
  }
  .tool-card-header:hover {
    background: rgba(255,255,255,0.06);
  }
  .tool-card-header .icon {
    font-size: 14px;
    flex-shrink: 0;
  }
  .tool-card-header .name {
    font-weight: 600;
    font-family: var(--mono-font);
    font-size: 12px;
  }
  .tool-card-header .status {
    margin-left: auto;
    font-size: 11px;
    opacity: 0.7;
  }
  .tool-card-body {
    padding: 8px 12px;
    font-family: var(--mono-font);
    font-size: 12px;
    border-top: 1px solid var(--border);
    display: none;
    max-height: 300px;
    overflow: auto;
  }
  .tool-card-body.open { display: block; }
  .tool-card-body pre {
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.4;
  }
  .tool-card-body .label {
    font-family: var(--font);
    font-size: 11px;
    opacity: 0.6;
    margin: 6px 0 3px;
  }
  .tool-card-body .label:first-child { margin-top: 0; }

  /* ── Input area ──────────────────────────────── */
  .input-area {
    padding: 10px 14px 12px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    display: flex;
    gap: 8px;
    align-items: flex-end;
    background: var(--bg);
  }
  .input-area textarea {
    flex: 1;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 8px;
    padding: 10px 12px;
    font-family: var(--font);
    font-size: 13px;
    resize: none;
    outline: none;
    min-height: 42px;
    max-height: 150px;
    line-height: 1.5;
    overflow-y: auto;
  }
  .input-area textarea:focus {
    border-color: var(--btn-bg);
  }
  .input-area textarea::placeholder {
    color: var(--input-fg);
    opacity: 0.4;
  }
  .input-area .send-btn {
    background: var(--btn-bg);
    color: var(--btn-fg);
    border: none;
    border-radius: 8px;
    padding: 0 18px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    height: 42px;
    min-width: 60px;
    transition: background 0.15s;
  }
  .input-area .send-btn:hover:not(:disabled) {
    background: var(--btn-hover);
  }
  .input-area .send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .input-area .send-btn.cancel {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg);
  }
  .input-area .send-btn.cancel:hover {
    background: rgba(255,255,255,0.1);
  }

  /* ── Error toast ─────────────────────────────── */
  .toast-container {
    position: fixed;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 999;
    display: flex;
    flex-direction: column;
    gap: 4px;
    pointer-events: none;
  }
  .toast {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    color: var(--vscode-inputValidation-errorForeground, #ffeaea);
    padding: 6px 14px;
    border-radius: var(--radius);
    font-size: 12px;
    pointer-events: auto;
    animation: slideDown 0.2s ease;
    max-width: 90vw;
    word-break: break-word;
  }
  @keyframes slideDown { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
</style>
</head>
<body>

  <!-- Header -->
  <div class="header">
    <div class="header-row">
      <select class="session-select" id="sessionSelect">${selects.sessions}</select>
      <button id="newSessionBtn" title="新建会话">+</button>
      <button id="settingsBtn" title="供应商设置">⚙️</button>
    </div>
    <div class="header-row">
      <select id="providerSelect" style="flex:1">${selects.providers}</select>
      <select id="modelSelect" style="flex:1">${selects.models}</select>
    </div>
  </div>

  <!-- Messages -->
  <div class="messages" id="messagesContainer"></div>

  <!-- Input -->
  <div class="input-area">
    <textarea id="inputBox" placeholder="输入消息…" rows="2"></textarea>
    <button class="send-btn" id="sendBtn">发送</button>
  </div>

  <!-- Toast -->
  <div class="toast-container" id="toastContainer"></div>

  <!-- Debug -->
  <div id="debugInfo" style="padding:4px 10px;font-size:10px;opacity:0.4;border-top:1px solid var(--border);display:none"></div>

<script type="application/json" id="boot-state">${bootJson}</script>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
