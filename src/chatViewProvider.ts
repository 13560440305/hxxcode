import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { OpencodeManager, StreamEvent } from "./opencodeManager";
import type { PermissionReply, PermissionRequest } from "@opencode-ai/sdk";
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
  | { type: "requestState" }
  | { type: "permissionReply"; payload: { id: string; reply: PermissionReply } };

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
  private pendingPermissionResolve: ((reply: PermissionReply) => void) | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly opencodeManager: OpencodeManager,
    private readonly providerStore: ProviderStore
  ) {
    ChatViewProvider._instance = this;
    this.opencodeManager.setPermissionHandler((req) => this.requestPermissionInWebview(req));
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

  /** 先加载会话数据，再渲染 webview（内嵌 boot state） */
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

      case "permissionReply":
        if (this.pendingPermissionResolve) {
          this.pendingPermissionResolve(msg.payload.reply);
          this.pendingPermissionResolve = null;
        }
        break;
    }
  }

  /** OpenCode 工具权限确认 —— 在侧栏 Webview 内展示，而非顶部 QuickPick */
  requestPermissionInWebview(request: PermissionRequest): Promise<PermissionReply> {
    return new Promise((resolve) => {
      this.pendingPermissionResolve = resolve;
      void this._view?.show?.(true);
      this.postMessage({
        type: "permissionRequest",
        payload: {
          id: request.id,
          action: request.action ?? "unknown",
          resources: request.resources ?? [],
        },
      });
    });
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

  private renderHtml(
    webview: vscode.Webview,
    initialState: ReturnType<ChatViewProvider["buildStatePayload"]>
  ): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat-webview.js")
    );
    const cspSource = webview.cspSource;
    const bootJson = JSON.stringify(initialState).replace(/</g, "\\u003c");

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
    --muted: var(--vscode-descriptionForeground, #9d9d9d);
    --border: var(--vscode-widget-border, #3c3c3c);
    --border-subtle: color-mix(in srgb, var(--border) 60%, transparent);
    --input-bg: var(--vscode-input-background, #2b2b2b);
    --input-fg: var(--vscode-input-foreground, #cccccc);
    --surface-hover: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06));
    --accent: var(--vscode-button-background, #0e639c);
    --accent-fg: var(--vscode-button-foreground, #ffffff);
    --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
    --accent-soft: color-mix(in srgb, var(--accent) 18%, var(--bg));
    --ok: #5fb85f;
    --err: #d97c7c;
    --warn: #d9a441;
    --link-fg: var(--vscode-textLink-foreground, #3794ff);
    --code-bg: var(--vscode-textCodeBlock-background, #2d2d2d);
    --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    --mono-font: var(--vscode-editor-font-family, "Cascadia Code", "Fira Code", monospace);
    --radius-sm: 6px;
    --radius: 10px;
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
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px 8px 12px;
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 0.4px;
    color: var(--fg);
  }
  .brand .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 20%, transparent);
    flex-shrink: 0;
  }
  .icon-btn {
    width: 26px; height: 26px;
    border: none; background: transparent;
    color: var(--muted);
    border-radius: 5px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; flex-shrink: 0;
  }
  .icon-btn:hover { background: var(--surface-hover); color: var(--fg); }

  /* ── Session bar ── */
  .session-bar {
    position: relative;
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }
  .session-picker {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    color: var(--fg);
    font-size: 12px;
    font-weight: 600;
    padding: 7px 10px;
    cursor: pointer;
    text-align: left;
  }
  .session-picker:hover { background: var(--surface-hover); }
  .session-picker .name {
    flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .session-picker .chev {
    flex: 0 0 auto;
    color: var(--muted);
    transition: transform 0.15s;
  }
  .session-picker.open .chev { transform: rotate(180deg); }

  .history-dropdown {
    position: absolute;
    top: calc(100% + 1px); left: 6px; right: 6px;
    background: var(--vscode-dropdown-background, var(--bg));
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    padding: 4px;
    z-index: 30;
    display: none;
  }
  .history-dropdown.show { display: block; }
  .history-item {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 6px 8px; border-radius: 6px;
    font-size: 12px; cursor: pointer;
  }
  .history-item:hover { background: var(--surface-hover); }
  .history-item.active { background: var(--accent-soft); color: var(--accent); }
  .history-item .t {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .history-item .time {
    flex: 0 0 auto; font-size: 10px; color: var(--muted);
  }
  .hist-divider { height: 1px; background: var(--border-subtle); margin: 4px 2px; }
  .new-session-btn {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 8px; border-radius: 6px;
    font-size: 12px; color: var(--accent); cursor: pointer;
  }
  .new-session-btn:hover { background: var(--accent-soft); }

  /* ── Messages ── */
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .messages:empty::after {
    content: "有什么可以帮你的？";
    display: block;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
    margin-top: 48px;
  }

  .msg-row {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    animation: fadeIn 0.2s ease;
    max-width: 100%;
  }
  .msg-row.assistant {
    align-self: flex-start;
    flex-direction: row;
  }
  .msg-row.user {
    align-self: flex-end;
    flex-direction: row-reverse;
    max-width: 88%;
  }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

  .avatar {
    flex: 0 0 auto;
    width: 20px; height: 20px;
    border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    font-size: 9px; font-weight: 700;
    margin-top: 3px;
  }
  .avatar.user { background: color-mix(in srgb, var(--fg) 12%, transparent); color: var(--muted); }
  .avatar.ai { background: var(--accent-soft); color: var(--accent); }

  .msg-body { flex: 1; min-width: 0; }
  .msg-row.user .msg-body { text-align: right; }
  .msg-row.user .msg-body pre,
  .msg-row.user .msg-body pre code { text-align: left; }
  .msg-body p { margin: 6px 0; line-height: 1.55; }
  .msg-body p:first-child { margin-top: 0; }
  .msg-body p:last-child { margin-bottom: 0; }
  .msg-body code {
    font-family: var(--mono-font);
    font-size: 11.5px;
    background: rgba(127,127,127,0.15);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .msg-body pre { margin: 8px 0; }
  .msg-body pre code {
    display: block;
    padding: 10px 12px;
    overflow-x: auto;
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 11.5px;
    line-height: 1.45;
  }
  .msg-body a { color: var(--link-fg); }
  .msg-body ul { padding-left: 18px; margin: 6px 0; }
  .msg-text { line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
  .streaming-cursor::after {
    content: "▍";
    animation: blink 0.8s step-end infinite;
    color: var(--link-fg);
  }
  @keyframes blink { 50% { opacity: 0; } }

  /* ── Tool cards ── */
  .tool-card {
    margin: 5px 0;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: color-mix(in srgb, var(--bg) 98%, var(--accent));
  }
  .tool-card-header {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 9px;
    cursor: pointer;
    user-select: none;
  }
  .tool-card-header:hover { background: var(--surface-hover); }
  .tool-card-header .chevron {
    font-size: 9px;
    color: var(--muted);
    transition: transform 0.15s;
    flex: 0 0 auto;
  }
  .tool-card.open .tool-card-header .chevron { transform: rotate(90deg); }
  .tool-card-header .tname {
    font-family: var(--mono-font);
    font-size: 11px;
    flex: 0 0 auto;
  }
  .tool-card-header .tsummary {
    flex: 1; min-width: 0;
    color: var(--muted);
    font-size: 11px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .status-pill {
    flex: 0 0 auto;
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 20px;
  }
  .status-pill.done { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .status-pill.running { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
  .status-pill.error { background: color-mix(in srgb, var(--err) 16%, transparent); color: var(--err); }
  .tool-card-body {
    display: none;
    padding: 8px 10px;
    border-top: 1px solid var(--border-subtle);
    font-family: var(--mono-font);
    font-size: 11px;
    color: var(--muted);
    background: color-mix(in srgb, var(--code-bg) 50%, transparent);
    max-height: 180px;
    overflow: auto;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .tool-card.open .tool-card-body { display: block; }

  /* ── Permission panel ── */
  .permission-panel {
    margin: 0 10px 8px;
    padding: 10px 12px;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    flex-shrink: 0;
  }
  .permission-panel.hidden { display: none; }
  .permission-title { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
  .permission-detail {
    font-size: 11px; color: var(--muted);
    font-family: var(--mono-font);
    word-break: break-all;
    margin-bottom: 8px;
    line-height: 1.5;
  }
  .permission-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .permission-actions button {
    flex: 1; min-width: 70px;
    padding: 5px 8px;
    border-radius: 5px;
    border: none;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 11px;
    cursor: pointer;
  }
  .permission-actions button:hover { filter: brightness(1.1); }
  .permission-actions button.secondary {
    background: transparent;
    color: var(--fg);
    border: 1px solid var(--border);
  }

  /* ── Composer ── */
  .composer {
    flex-shrink: 0;
    padding: 6px 10px 8px;
    border-top: 1px solid var(--border-subtle);
  }
  .composer-box {
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 6px 6px 4px;
    transition: border-color 0.15s;
  }
  .composer-box:focus-within { border-color: var(--accent); }
  .composer-box textarea {
    width: 100%;
    background: transparent;
    border: none; outline: none;
    resize: none;
    color: var(--input-fg);
    font-family: var(--font);
    font-size: 12.5px;
    line-height: 1.5;
    min-height: 30px;
    max-height: 120px;
  }
  .composer-box textarea::placeholder { color: var(--muted); }
  .composer-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 2px;
  }
  .composer-toolbar .left { display: flex; align-items: center; gap: 4px; min-width: 0; }

  .model-chip {
    display: flex; align-items: center; gap: 5px;
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: 20px;
    padding: 2px 8px 2px 5px;
    cursor: pointer;
    color: var(--muted);
    font-size: 10.5px;
    max-width: 160px;
  }
  .model-chip:hover { border-color: var(--border); color: var(--fg); }
  .model-chip .dot {
    width: 10px; height: 10px;
    border-radius: 3px;
    background: linear-gradient(135deg, #4f8ef7, #6a5cf0);
    flex: 0 0 auto;
  }
  .model-chip .mname {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .send-btn {
    width: 26px; height: 26px;
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: var(--accent-fg);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; flex: 0 0 auto;
  }
  .send-btn:hover { filter: brightness(1.1); }
  .send-btn.cancel {
    background: transparent;
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 5px;
    width: 28px; height: 28px;
  }
  .send-btn.cancel:hover { filter: none; background: var(--surface-hover); }

  .model-popover {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 10px;
    width: 240px;
    background: var(--vscode-dropdown-background, var(--bg));
    border: 1px solid var(--border);
    border-radius: 9px;
    box-shadow: 0 10px 28px rgba(0,0,0,0.4);
    padding: 8px;
    z-index: 30;
    display: none;
  }
  .model-popover.show { display: block; }
  .pop-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--muted);
    padding: 2px 4px 6px;
  }
  .provider-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 2px 6px; }
  .provider-chip {
    padding: 3px 8px;
    border-radius: 20px;
    font-size: 11px;
    background: var(--surface-hover);
    color: var(--muted);
    border: 1px solid var(--border-subtle);
    cursor: pointer;
  }
  .provider-chip:hover { border-color: var(--border); color: var(--fg); }
  .provider-chip.active { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
  .model-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: 120px;
    overflow-y: auto;
  }
  .model-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 5px 8px; border-radius: 6px;
    font-size: 11.5px; cursor: pointer;
  }
  .model-item:hover { background: var(--surface-hover); }
  .model-item.active { background: var(--accent-soft); color: var(--accent); }
  .manage-link {
    display: flex; align-items: center; gap: 5px;
    margin-top: 4px; padding: 6px 8px;
    border-top: 1px solid var(--border-subtle);
    font-size: 11px; color: var(--muted); cursor: pointer;
  }
  .manage-link:hover { color: var(--fg); }

  /* ── Status bar ── */
  .statusbar {
    display: flex;
    justify-content: space-between;
    padding: 4px 10px;
    font-size: 9.5px;
    color: var(--muted);
    border-top: 1px solid var(--border-subtle);
    font-family: var(--mono-font);
    flex-shrink: 0;
  }

  .toast-container {
    position: fixed;
    bottom: 72px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 999;
    pointer-events: none;
  }
  .toast {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    color: var(--vscode-inputValidation-errorForeground, #ffeaea);
    padding: 7px 12px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    animation: slideUp 0.2s ease;
    max-width: 90vw;
    pointer-events: auto;
  }
  @keyframes slideUp { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
</style>
</head>
<body>

  <!-- Header -->
  <div class="header">
    <div class="brand"><span class="dot"></span>HXXCODE</div>
    <div class="header-actions">
      <button class="icon-btn" id="settingsBtn" title="供应商设置">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M8 1v2M8 13v2M2.5 4.5l1.5 1.5M12 10l1.5 1.5M1 8h2M13 8h2M2.5 11.5L4 10M12 6l1.5-1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      </button>
    </div>
  </div>

  <!-- Session bar -->
  <div class="session-bar">
    <button class="session-picker" id="sessionPicker">
      <span class="name" id="sessionName">会话 1</span>
      <svg class="chev" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div class="history-dropdown" id="historyDropdown">
      <div class="new-session-btn" id="newSessionBtn">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        新建会话
      </div>
      <div class="hist-divider"></div>
      <div id="sessionList"></div>
    </div>
  </div>

  <!-- Messages -->
  <div class="messages" id="messagesContainer"></div>

  <!-- Permission panel -->
  <div class="permission-panel hidden" id="permissionPanel">
    <div class="permission-title" id="permissionTitle">需要您的确认</div>
    <div class="permission-detail" id="permissionDetail"></div>
    <div class="permission-actions">
      <button type="button" data-reply="once">允许一次</button>
      <button type="button" data-reply="always">始终允许</button>
      <button type="button" data-reply="reject" class="secondary">拒绝</button>
    </div>
  </div>

  <!-- Composer -->
  <div class="composer" style="position:relative">
    <div class="model-popover" id="modelPopover">
      <div class="pop-label">供应商</div>
      <div class="provider-chips" id="providerChips"></div>
      <div class="pop-label">模型</div>
      <div class="model-list" id="modelList"></div>
      <div class="manage-link" id="manageLink">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M8 1v2M8 13v2M2.5 4.5l1.5 1.5M12 10l1.5 1.5M1 8h2M13 8h2M2.5 11.5L4 10M12 6l1.5-1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        管理供应商与模型…
      </div>
    </div>

    <div class="composer-box">
      <textarea id="inputBox" placeholder="输入消息，Enter 发送，Shift+Enter 换行" rows="1"></textarea>
      <div class="composer-toolbar">
        <div class="left">
          <button class="model-chip" id="modelChip">
            <span class="dot"></span>
            <span class="mname" id="modelChipName">模型</span>
            <svg class="chev" width="8" height="8" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <button class="send-btn" id="sendBtn" title="发送" aria-label="发送">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
  </div>

  <!-- Status bar -->
  <div class="statusbar" id="statusbar">
    <span id="statusLeft"></span>
    <span id="statusRight"></span>
  </div>

  <div class="toast-container" id="toastContainer"></div>

<script type="application/json" id="boot-state">${bootJson}</script>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
