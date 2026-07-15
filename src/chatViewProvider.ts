import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { OpencodeManager, StreamEvent, formatErrorMessage, isImageUnsupportedError, type PromptAttachments } from "./opencodeManager";
import { modelSupportsVision } from "./providerStore";
import type { PermissionReply, PermissionRequest } from "@opencode-ai/sdk";
import { ProviderStore, ProviderConfig } from "./providerStore";
import { logError, logInfo, showDiag } from "./log";
import {
  ensureDirs,
  getSessionPath,
  getArchiveSessionPath,
  getSessionsDir,
  getHxxCodeDir,
  ensureSessionAttachmentsDir,
  loadSessionIndex,
  saveSessionIndex,
  archiveSessionFile,
  loadSessionMessages,
  readJSON,
  SessionIndexEntry,
} from "./storage";
import * as crypto from "crypto";
import * as fsp from "fs/promises";

// ── Data types ───────────────────────────────────────────────────────────────

type AttachmentKind = "image" | "text";

interface Attachment {
  id: string;
  kind: AttachmentKind;
  mime: string;
  name: string;
  path?: string;
  /** 仅传输/预览用，不落盘到会话 JSON */
  dataUrl?: string;
  textContent?: string;
  /** 发给 webview 的预览 URI */
  previewUrl?: string;
}

/** 会话元数据（轻量，传给前端渲染列表用） */
interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  messageCount: number;
  lastPreview: string;
  /** OpenCode 后端会话是否曾发送过图片（纯文本模型需重置后端会话） */
  backendMayContainImages?: boolean;
}

/** 发往前端的会话列表项 */
interface SessionListItem {
  id: string;
  title: string;
  createdAt: number;
  messageCount: number;
  lastPreview: string;
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
  attachments?: Attachment[];
  toolCalls: ToolCallDisplay[];
  isStreaming: boolean;
}

/** 完整会话数据（仅在活跃时加载 messages） */
interface SessionData {
  info: SessionMeta;
  messages: ChatMessage[];
}

// ── 会话数量/消息上限 ─────────────────────────────────────────────────────

const MAX_ACTIVE_SESSIONS = 50;
const MAX_SESSION_MESSAGES = 100;
const ARCHIVE_AGE_DAYS = 30;

function lastMessagePreview(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const t = m.text?.trim();
    if (t) return t.slice(0, 80);
    if (m.attachments?.length) {
      return `[附件] ${m.attachments.map((a) => a.name).join(", ")}`.slice(0, 80);
    }
  }
  return "";
}

function persistableAttachments(attachments?: Attachment[]): Attachment[] | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map(({ id, kind, mime, name, path }) => ({
    id,
    kind,
    mime,
    name,
    path,
  }));
}

type IncomingAttachment = {
  id?: string;
  kind: AttachmentKind;
  mime: string;
  name: string;
  dataUrl?: string;
  textContent?: string;
};

type WebviewMessage =
  | { type: "ready" }
  | { type: "sendMessage"; payload: { text: string; attachments?: IncomingAttachment[] } }
  | { type: "createSession" }
  | { type: "switchSession"; payload: { sessionId: string } }
  | { type: "switchModel"; payload: { providerId: string; model: string } }
  | { type: "cancelResponse" }
  | { type: "deleteSession"; payload: { sessionId: string } }
  | { type: "retryLastMessage" }
  | { type: "openSettings" }
  | { type: "openFile"; payload: { path: string } }
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

  static attachOpencodeManager(manager: OpencodeManager): void {
    ChatViewProvider._instance?.bindOpencodeManager(manager);
  }

  /** 供命令面板 / 编辑器标题栏「新建会话」调用 */
  static getInstance(): ChatViewProvider | null {
    return ChatViewProvider._instance;
  }

  private bindOpencodeManager(manager: OpencodeManager): void {
    manager.setPermissionHandler((req) => this.requestPermissionInWebview(req));
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
    private readonly getOpencodeManager: () => OpencodeManager | null,
    private readonly getProviderStore: () => ProviderStore | null,
    private readonly ensureInitialized: () => Promise<boolean>
  ) {
    ChatViewProvider._instance = this;
  }

  private requireOpencodeManager(): OpencodeManager {
    const manager = this.getOpencodeManager();
    if (!manager) {
      throw new Error("HxxCode Agent 尚未启动，请检查 CLI 是否已安装");
    }
    return manager;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.extensionUri,
        vscode.Uri.file(getHxxCodeDir()),
        vscode.Uri.file(getSessionsDir()),
      ],
    };

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      void this.handleMessage(msg);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.webviewReady) {
        this.postState();
      }
    });

    // 立即渲染 UI 壳，不等待 Agent / 会话加载
    this.setWebviewHtml(webviewView);
    void this.bootstrapWebview();
  }

  /** 后台加载会话数据并刷新 state */
  private async bootstrapWebview(): Promise<void> {
    try {
      if (!(await this.ensureInitialized())) {
        this.postState();
        return;
      }

      await this.loadSessionsFromDisk();

      if (this.sessions.length === 0) {
        this.createLocalSession();
      }

      this.postState();
    } catch (err) {
      logError("侧栏初始化失败:", (err as Error).message);
      this.postError(`初始化失败: ${(err as Error).message}`);
    }
  }

  private setWebviewHtml(webviewView: vscode.WebviewView): void {
    this.webviewReady = false;
    webviewView.webview.html = this.renderHtml(
      webviewView.webview,
      this.buildStatePayload()
    );
  }

  // ── 向 Webview 发送消息 ─────────────────────────────────────────────────

  private postMessage(msg: Record<string, unknown>): void {
    this._view?.webview.postMessage(msg);
  }

  private postError(message: string): void {
    this.postMessage({ type: "error", payload: { message } });
  }

  private buildSessionListItems(): SessionListItem[] {
    return [...this.sessions]
      .sort((a, b) => b.info.createdAt - a.info.createdAt)
      .map((s) => ({
        id: s.info.id,
        title: s.info.title,
        createdAt: s.info.createdAt,
        messageCount: s.info.messageCount,
        lastPreview: s.info.lastPreview,
      }));
  }

  private buildStatePayload() {
    const providerStore = this.getProviderStore();
    if (!providerStore) {
      return {
        sessionList: [] as SessionListItem[],
        activeSessionId: null,
        messages: [] as ChatMessage[],
        providers: [] as ProviderConfig[],
        activeProviderId: null,
        activeModel: null,
        isStreaming: false,
      };
    }

    // activeSessionId 可能与 session.info.id 不一致（例如 OpenCode 返回了新 id）
    if (
      this.activeSessionId &&
      !this.sessions.some((s) => s.info.id === this.activeSessionId)
    ) {
      this.activeSessionId = this.sessions[0]?.info.id ?? null;
    }

    const session = this.getActiveSession();
    const { provider, model } = providerStore.getActive();

    return {
      sessionList: this.buildSessionListItems(),
      activeSessionId: this.activeSessionId,
      messages: this.enrichMessagesForWebview(session?.messages ?? []),
      providers: providerStore.list(),
      activeProviderId: provider?.id ?? null,
      activeModel: model,
      isStreaming: !!this.abortController,
    };
  }

  /** 给 webview 补上图片 previewUrl，去掉大体积正文 */
  private enrichMessagesForWebview(messages: ChatMessage[]): ChatMessage[] {
    const webview = this._view?.webview;
    return messages.map((m) => ({
      ...m,
      attachments: m.attachments?.map((a) => {
        const out: Attachment = {
          id: a.id,
          kind: a.kind,
          mime: a.mime,
          name: a.name,
          path: a.path,
        };
        if (a.kind === "image") {
          if (a.path && webview) {
            try {
              out.previewUrl = webview.asWebviewUri(vscode.Uri.file(a.path)).toString();
            } catch {
              // ignore
            }
          } else if (a.dataUrl) {
            out.previewUrl = a.dataUrl;
          }
        }
        return out;
      }),
    }));
  }

  private postState(): void {
    this.postMessage({ type: "state", payload: this.buildStatePayload() });
  }

  // ── 消息处理 ──────────────────────────────────────────────────────────────

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.webviewReady = true;
        this.postState();
        break;

      case "sendMessage":
        await this.handleSendMessage(msg.payload.text, msg.payload.attachments);
        break;

      case "createSession":
        await this.newSession();
        break;

      case "switchSession":
        {
          const newId = msg.payload.sessionId;
          if (!this.activeSessionId || newId !== this.activeSessionId) {
            this.activeSessionId = newId;
            // 懒加载：如果当前 session 的 messages 为空，从磁盘按需加载
            const session = this.getActiveSession();
            if (session && session.messages.length === 0) {
              const loadedMsgs = await this.loadMessagesForSession(newId);
              if (loadedMsgs && loadedMsgs.length > 0) {
                session.messages = loadedMsgs;
                this.syncImageBackendFlags(session);
              }
            }
            this.postState();
          }
        }
        break;

      case "switchModel":
        try {
          if (!(await this.ensureInitialized())) {
            this.postError("HxxCode 尚未就绪，请稍后重试");
            break;
          }
          await this.requireOpencodeManager().switchModel(
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

      case "openFile": {
        const filePath = msg.payload.path?.trim();
        if (filePath) {
          const uri = vscode.Uri.file(filePath);
          void vscode.window.showTextDocument(uri, {
            preview: false,
            viewColumn: vscode.ViewColumn.One,
          });
        }
        break;
      }

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
      if (
        this.activeSessionId &&
        !this.sessions.some((s) => s.info.id === this.activeSessionId)
      ) {
        this.activeSessionId = this.sessions[0]?.info.id ?? null;
      }
      void this.saveSessionsToDisk();
    }
  }

  /** 仅创建本地会话，不阻塞等待 Agent */
  private createLocalSession(): string {
    const id = shortId();
    const now = Date.now();
    const session: SessionData = {
      info: {
        id,
        title: this.nextSessionTitle(),
        createdAt: now,
        messageCount: 0,
        lastPreview: "",
      },
      messages: [],
    };
    this.sessions.push(session);
    this.activeSessionId = id;

    // 主动清理：确保不超过上限
    void this.housekeepSessions();
    return id;
  }

  /** 新建会话并聚焦侧栏 */
  async newSession(): Promise<void> {
    if (!(await this.ensureInitialized())) {
      return;
    }
    if (!this.sessionsLoaded) {
      await this.loadSessionsFromDisk();
    }
    this.createLocalSession();
    this.postState();
    await this.saveSessionsToDisk();
    await this._view?.show?.(true);
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

      // ── 优先从索引文件加载（单文件读取，O(1)） ──
      const index = await loadSessionIndex();
      if (index.length > 0) {
        // 只加载活跃会话的元数据，不加载 messages
        const activeEntries = index
          .filter((e) => !e.archived)
          .sort((a, b) => b.createdAt - a.createdAt);
        for (const entry of activeEntries) {
          this.sessions.push({
            info: {
              id: entry.id,
              title: entry.title,
              createdAt: entry.createdAt,
              messageCount: entry.messageCount,
              lastPreview: entry.lastPreview,
            },
            messages: [], // 懒加载：切换会话时才加载 messages
          });
        }
      } else {
        // ── 回退：从旧格式的 session JSON 文件迁移生成索引 ──
        const sessionsDir = getSessionsDir();
        let files: string[] = [];
        try {
          const { readdir } = await import("fs/promises");
          files = (await readdir(sessionsDir))
            .filter((f) => f.endsWith(".json"))
            .sort();
        } catch {
          // 目录不存在，无旧数据
        }

        const { join } = await import("path");
        for (const file of files) {
          const data = await readJSON<SessionData | null>(
            join(sessionsDir, file),
            null
          );
          if (data?.info && data.messages) {
            const session: SessionData = {
              info: {
                id: data.info.id,
                title: data.info.title,
                createdAt: data.info.createdAt,
                messageCount: data.messages.length,
                lastPreview: lastMessagePreview(data.messages),
              },
              messages: [], // 旧数据迁移时也不预加载 messages
            };
            if (!this.sessions.find((s) => s.info.id === session.info.id)) {
              this.sessions.push(session);
            }
          }
        }
      }

      // 合并不活跃的空会话
      if (this.sessions.length > 0) {
        this.consolidateEmptySessions();
        this.renumberSessionTitles();
        if (!this.activeSessionId) {
          this.activeSessionId = this.sessions[0]?.info.id ?? null;
        }
        // 自动 housekeeping：归档旧会话 + 限制数量
        await this.housekeepSessions();
        void this.saveSessionIndexToDisk();
      }
    } catch (err) {
      logError("加载会话历史失败:", String(err));
    }
  }

  /** 会话健康检查：归档过期会话 + 限制活跃数量 */
  private async housekeepSessions(): Promise<void> {
    const now = Date.now();
    const archiveCutoff = now - ARCHIVE_AGE_DAYS * 86400000;
    let changed = false;

    // 1. 归档超过 ARCHIVE_AGE_DAYS 天的旧会话
    const toArchiveAge = this.sessions.filter(
      (s) => s.info.createdAt < archiveCutoff
    );
    for (const s of toArchiveAge) {
      await this.archiveSession(s.info.id);
      changed = true;
    }

    // 2. 保留最多 MAX_ACTIVE_SESSIONS 个，其余归档（按创建时间倒序保留最新的）
    const activeSessions = this.sessions.filter(
      (s) => !this.isArchived(s.info.id)
    );
    if (activeSessions.length > MAX_ACTIVE_SESSIONS) {
      const sorted = [...activeSessions].sort(
        (a, b) => b.info.createdAt - a.info.createdAt
      );
      const toArchive = sorted.slice(MAX_ACTIVE_SESSIONS);
      for (const s of toArchive) {
        await this.archiveSession(s.info.id);
        changed = true;
      }
    }

    if (changed) {
      await this.saveSessionIndexToDisk();
    }
  }

  private isArchived(sessionId: string): boolean {
    return !this.sessions.some((s) => s.info.id === sessionId);
  }

  private async archiveSession(sessionId: string): Promise<void> {
    // 写索引标记为归档
    const index = await loadSessionIndex();
    const entry = index.find((e) => e.id === sessionId);
    if (entry) {
      entry.archived = true;
      await saveSessionIndex(index);
    }
    // 移动 JSON 文件到 archive 目录
    await archiveSessionFile(sessionId);
    // 从内存中移除
    this.sessions = this.sessions.filter((s) => s.info.id !== sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions[0]?.info.id ?? null;
    }
  }

  /** 切换会话时按需从磁盘加载 messages */
  private async loadMessagesForSession(sessionId: string): Promise<ChatMessage[] | null> {
    const data = await loadSessionMessages(sessionId);
    if (!data?.messages) return null;
    // 磁盘中存的 role 是 string，需转为联合类型
    return data.messages.map((m) => {
      const raw = m as {
        role: string;
        text: string;
        toolCalls?: unknown[];
        attachments?: Attachment[];
      };
      return {
        role: raw.role as "user" | "assistant",
        text: raw.text,
        toolCalls: (raw.toolCalls ?? []) as ToolCallDisplay[],
        attachments: persistableAttachments(raw.attachments),
        isStreaming: false, // 从磁盘加载的始终不是流式状态
      };
    });
  }

  private async saveSessionIndexToDisk(): Promise<void> {
    try {
      const index = await loadSessionIndex();
      const idMap = new Map(index.map((e) => [e.id, e]));
      for (const s of this.sessions) {
        idMap.set(s.info.id, {
          id: s.info.id,
          title: s.info.title,
          createdAt: s.info.createdAt,
          messageCount: s.info.messageCount,
          lastPreview: s.info.lastPreview,
          archived: false,
        });
      }
      await saveSessionIndex(Array.from(idMap.values()));
    } catch (err) {
      logError("保存会话索引失败:", String(err));
    }
  }

  private async saveSessionsToDisk(): Promise<void> {
    try {
      await ensureDirs();
      const sessionsDir = getSessionsDir();
      const sessionIds = new Set(this.sessions.map((s) => s.info.id));

      // 清理旧文件
      let files: string[] = [];
      try {
        const { readdir } = await import("fs/promises");
        files = (await readdir(sessionsDir))
          .filter((f) => f.endsWith(".json"));
      } catch {
        // 目录可能不存在
      }
      for (const file of files) {
        if (!sessionIds.has(file.replace(/\.json$/, ""))) {
          const { unlink } = await import("fs/promises");
          const { join } = await import("path");
          await unlink(join(sessionsDir, file)).catch(() => {});
        }
      }

      // 写入有 messages 的会话（附件只存元数据，不写 dataUrl/正文）
      for (const session of this.sessions) {
        if (session.messages.length > 0) {
          const filePath = getSessionPath(session.info.id);
          const { writeFile } = await import("fs/promises");
          const toSave = {
            info: session.info,
            messages: session.messages.map((m) => ({
              role: m.role,
              text: m.text,
              toolCalls: m.toolCalls,
              isStreaming: false,
              attachments: persistableAttachments(m.attachments),
            })),
          };
          await writeFile(filePath, JSON.stringify(toSave, null, 2), "utf-8");
        }
      }

      // 同步更新索引
      await this.saveSessionIndexToDisk();
    } catch (err) {
      logError("保存会话失败:", String(err));
    }
  }

  // ── 发送消息 ──────────────────────────────────────────────────────────────

  private sessionHasImageMessages(session: SessionData): boolean {
    return session.messages.some(
      (m) => m.role === "user" && m.attachments?.some((a) => a.kind === "image")
    );
  }

  private syncImageBackendFlags(session: SessionData): void {
    if (this.sessionHasImageMessages(session)) {
      session.info.backendMayContainImages = true;
    }
  }

  private async resolveBackendSessionId(
    session: SessionData,
    supportsVision: boolean
  ): Promise<string> {
    const manager = this.requireOpencodeManager();
    this.syncImageBackendFlags(session);

    if (session.info.backendMayContainImages && !supportsVision) {
      const fresh = await manager.createSession(session.info.title);
      const oldId = session.info.id;
      session.info.id = fresh.id;
      session.info.backendMayContainImages = false;
      if (this.activeSessionId === oldId) {
        this.activeSessionId = fresh.id;
      }
      return fresh.id;
    }

    const backendId = await manager.ensureBackendSession(
      session.info.id,
      session.info.title
    );
    if (backendId !== session.info.id) {
      const oldId = session.info.id;
      session.info.id = backendId;
      if (this.activeSessionId === oldId) {
        this.activeSessionId = backendId;
      }
    }
    return backendId;
  }

  private async handleSendMessage(
    text: string,
    incomingAttachments?: IncomingAttachment[]
  ): Promise<void> {
    showDiag(true);
    logInfo("[flow/chat] ========== 发送消息 ==========");

    if (!(await this.ensureInitialized())) {
      logInfo("[flow/chat] 未就绪，中止");
      this.postError("HxxCode 尚未就绪，请稍后重试");
      return;
    }

    let session = this.getActiveSession();
    if (!session) {
      this.createLocalSession();
      session = this.getActiveSession();
      if (!session) {
        logInfo("[flow/chat] 无会话，中止");
        return;
      }
    }

    const trimmed = text.trim();
    if (!trimmed && !(incomingAttachments?.length)) {
      return;
    }

    const requestAbort = new AbortController();
    this.abortController = requestAbort;

    const providerStore = this.getProviderStore();
    const { provider, model } = providerStore?.getActive() ?? {};
    const supportsVision =
      provider && model ? modelSupportsVision(provider, model) : true;

    logInfo("[flow/chat] 会话/模型", {
      sessionId: session.info.id,
      provider: provider?.id,
      model,
      supportsVision,
      textLen: trimmed.length,
      attachments: (incomingAttachments ?? []).map((a) => ({
        kind: a.kind,
        name: a.name,
        mime: a.mime,
      })),
    });

    let attachmentsToSave = incomingAttachments;
    if (!supportsVision && incomingAttachments?.some((a) => a.kind === "image")) {
      logInfo("[flow/chat] 模型不支持图片，已剥离 image 附件");
      this.postError(
        "当前模型不支持图片，已忽略本次图片附件。请改用支持 Vision 的模型，或新建会话。"
      );
      attachmentsToSave = incomingAttachments.filter((a) => a.kind !== "image");
    }

    try {
      logInfo("[flow/chat] 1. resolveBackendSessionId …");
      const backendId = await this.resolveBackendSessionId(session, supportsVision);
      logInfo("[flow/chat] 1. 完成 backendId=", backendId);
      if (requestAbort.signal.aborted) {
        logInfo("[flow/chat] 已取消 (resolve 后)");
        return;
      }

      logInfo("[flow/chat] 2. 持久化附件 …");
      const savedAttachments = await this.persistIncomingAttachments(
        backendId,
        attachmentsToSave
      );
      logInfo("[flow/chat] 2. 完成 attachments=", savedAttachments.length);
      if (requestAbort.signal.aborted) {
        logInfo("[flow/chat] 已取消 (附件后)");
        return;
      }

      // 追加用户消息
      session.messages.push({
        role: "user",
        text: trimmed,
        attachments: savedAttachments.length ? savedAttachments : undefined,
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
        const titleBase =
          trimmed ||
          savedAttachments.map((a) => a.name).join(", ") ||
          "新会话";
        session.info.title =
          titleBase.slice(0, 40) + (titleBase.length > 40 ? "…" : "");
      }

      logInfo("[flow/chat] 3. toPromptAttachments …");
      const promptAttachments = await this.toPromptAttachments(
        savedAttachments,
        supportsVision
      );
      logInfo("[flow/chat] 3. 完成", {
        images: promptAttachments?.images?.length ?? 0,
        texts: promptAttachments?.texts?.length ?? 0,
      });
      if (promptAttachments?.images?.length) {
        session.info.backendMayContainImages = true;
      }

      logInfo("[flow/chat] 4. promptStream 开始 …");
      await this.requireOpencodeManager().promptStream(
        backendId,
        trimmed,
        (event) => {
          // 已点停止后忽略迟到的流事件，避免 UI 又回到“生成中”
          if (requestAbort.signal.aborted) return;
          if (this.abortController !== requestAbort) return;
          if (event.type === "text") {
            logInfo("[flow/chat] ← text delta len=", event.text?.length ?? 0);
          } else if (event.type === "tool_use") {
            logInfo("[flow/chat] ← tool_use", event.toolName, event.toolCallId);
          } else if (event.type === "tool_result") {
            logInfo("[flow/chat] ← tool_result", event.toolName, event.toolCallId);
          } else if (event.type === "error") {
            logInfo("[flow/chat] ← error", event.error);
          } else if (event.type === "finish") {
            logInfo("[flow/chat] ← finish");
          }
          this.handleStreamEvent(session!.info.id, event);
        },
        requestAbort.signal,
        promptAttachments
      );
      logInfo("[flow/chat] 4. promptStream 返回");
    } catch (err) {
      const msg = formatErrorMessage(err);
      logInfo("[flow/chat] ✗ 异常", msg);
      const last = session.messages[session.messages.length - 1];
      const assistantMsg =
        last?.role === "assistant" ? last : null;
      if (
        requestAbort.signal.aborted ||
        msg.includes("aborted") ||
        msg.includes("cancel") ||
        msg.includes("terminated")
      ) {
        if (assistantMsg && !assistantMsg.text.includes("*已取消*")) {
          assistantMsg.text += (assistantMsg.text ? "\n\n" : "") + "*已取消*";
        }
      } else {
        if (isImageUnsupportedError(msg)) {
          session.info.backendMayContainImages = true;
        }
        this.postError(msg);
        if (assistantMsg) {
          assistantMsg.text += `\n\n**错误**: ${msg}`;
        } else {
          session.messages.push({
            role: "assistant",
            text: `**错误**: ${msg}`,
            toolCalls: [],
            isStreaming: false,
          });
        }
      }
    } finally {
      const last = session.messages[session.messages.length - 1];
      if (last?.role === "assistant") last.isStreaming = false;
      if (this.abortController === requestAbort) {
        this.abortController = null;
      }
      session.info.messageCount = session.messages.length;
      session.info.lastPreview = lastMessagePreview(session.messages);
      logInfo("[flow/chat] ========== 发送结束 ==========");
      this.postState();
      this.saveSessionsToDisk();
    }
  }

  private async persistIncomingAttachments(
    sessionId: string,
    incoming?: IncomingAttachment[]
  ): Promise<Attachment[]> {
    if (!incoming?.length) return [];
    const dir = await ensureSessionAttachmentsDir(sessionId);
    const saved: Attachment[] = [];

    for (const item of incoming) {
      const id = item.id || crypto.randomUUID();
      const safeName = (item.name || "file").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
      const ext =
        path.extname(safeName) ||
        (item.kind === "image" ? this.extFromMime(item.mime) : "");
      const fileName = `${id}${ext}`;
      const filePath = path.join(dir, fileName);

      try {
        if (item.kind === "image" && item.dataUrl?.startsWith("data:")) {
          const base64 = item.dataUrl.replace(/^data:[^;]+;base64,/, "");
          await fsp.writeFile(filePath, Buffer.from(base64, "base64"));
          saved.push({
            id,
            kind: "image",
            mime: item.mime || "image/png",
            name: safeName,
            path: filePath,
          });
        } else if (item.kind === "text") {
          const content = item.textContent ?? "";
          await fsp.writeFile(filePath, content, "utf-8");
          saved.push({
            id,
            kind: "text",
            mime: item.mime || "text/plain",
            name: safeName,
            path: filePath,
            textContent: content,
          });
        }
      } catch (err) {
        logError("保存附件失败:", String(err));
        this.postError(`保存附件失败: ${safeName}`);
      }
    }
    return saved;
  }

  private extFromMime(mime: string): string {
    const map: Record<string, string> = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/bmp": ".bmp",
      "image/svg+xml": ".svg",
    };
    return map[mime] || ".png";
  }

  private async toPromptAttachments(
    attachments: Attachment[],
    supportsVision = true
  ): Promise<PromptAttachments | undefined> {
    if (!attachments.length) return undefined;
    const images: PromptAttachments["images"] = [];
    const texts: NonNullable<PromptAttachments["texts"]> = [];

    for (const a of attachments) {
      if (a.kind === "image") {
        if (!supportsVision) continue;
        images!.push({
          mime: a.mime,
          name: a.name,
          path: a.path,
          dataUrl: a.dataUrl,
        });
      } else if (a.kind === "text") {
        let content = a.textContent;
        if (content == null && a.path) {
          try {
            content = await fsp.readFile(a.path, "utf-8");
          } catch (err) {
            logError("读取文本附件失败:", String(err));
            content = "";
          }
        }
        texts.push({ name: a.name, content: content ?? "" });
      }
    }

    return {
      images: images!.length ? images : undefined,
      texts: texts.length ? texts : undefined,
    };
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
          const errText = formatErrorMessage(event.error);
          if (isImageUnsupportedError(errText)) {
            session.info.backendMayContainImages = true;
          }
          lastMsg.text += `\n\n**错误**: ${errText}`;
          this.postError(errText);
        }
        break;

      case "finish":
        // 由调用方处理
        break;
    }
  }

  // ── 取消 / 重试 ───────────────────────────────────────────────────────────

  private cancelResponse(): void {
    const ac = this.abortController;
    if (!ac) {
      logInfo("[flow/chat] 停止：当前没有进行中的请求");
      return;
    }

    logInfo("[flow/chat] 用户点击停止 → abort");
    // 立刻解锁输入框/停止按钮（不必等后端 SSE 真正断开）
    this.abortController = null;
    const session = this.getActiveSession();
    if (session) {
      const last = session.messages[session.messages.length - 1];
      if (last?.role === "assistant") {
        last.isStreaming = false;
        for (const tc of last.toolCalls) tc.isRunning = false;
        if (!last.text.includes("*已取消*")) {
          last.text += (last.text ? "\n\n" : "") + "*已取消*";
        }
      }
      session.info.messageCount = session.messages.length;
      session.info.lastPreview = lastMessagePreview(session.messages);
    }
    this.postState();

    // 再中断 SDK 的 HTTP/SSE（卡在「无输出」时也能解开）
    try {
      ac.abort();
      logInfo("[flow/chat] abort() 已调用");
    } catch (err) {
      logInfo("[flow/chat] abort() 异常", String(err));
    }
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

    // 从磁盘重读附件内容后重发
    const incoming: IncomingAttachment[] = [];
    for (const a of lastUserMsg.attachments ?? []) {
      if (a.kind === "image" && a.path) {
        try {
          const buf = await fsp.readFile(a.path);
          const mime = a.mime || "image/png";
          incoming.push({
            id: a.id,
            kind: "image",
            mime,
            name: a.name,
            dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
          });
        } catch (err) {
          logError("重试读取图片失败:", String(err));
        }
      } else if (a.kind === "text" && a.path) {
        try {
          const content = await fsp.readFile(a.path, "utf-8");
          incoming.push({
            id: a.id,
            kind: "text",
            mime: a.mime || "text/plain",
            name: a.name,
            textContent: content,
          });
        } catch (err) {
          logError("重试读取文本附件失败:", String(err));
        }
      }
    }

    await this.handleSendMessage(lastUserMsg.text, incoming);
  }

  // ── Webview HTML ──────────────────────────────────────────────────────────

  private renderHtml(
    webview: vscode.Webview,
    initialState: ReturnType<ChatViewProvider["buildStatePayload"]>
  ): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat-webview.js")
    );
    // 读取 logo 转为 data URI，避免 CSP / webview 资源加载问题
    let logoSrc = "";
    const mediaDir = path.join(this.extensionUri.fsPath, "media");
    for (const logoFile of ["logo.png", "logo.svg"]) {
      try {
        const logoPath = path.join(mediaDir, logoFile);
        const logoBuf = fs.readFileSync(logoPath);
        if (logoFile.endsWith(".svg")) {
          logoSrc = "data:image/svg+xml," + encodeURIComponent(logoBuf.toString("utf-8"));
        } else {
          logoSrc = "data:image/png;base64," + logoBuf.toString("base64");
        }
        break;
      } catch {
        // try next format
      }
    }
    const cspSource = webview.cspSource;
    const bootJson = JSON.stringify(initialState).replace(/</g, "\\u003c");

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource}; img-src ${cspSource} data:;" />
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
    text-transform: none;
  }
  .brand .logo-img {
    width: 18px; height: 18px;
    flex-shrink: 0;
    object-fit: contain;
    border-radius: 3px;
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
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 8px; padding: 6px 8px; border-radius: 6px;
    font-size: 12px; cursor: pointer;
  }
  .history-item:hover { background: var(--surface-hover); }
  .history-item.active { background: var(--accent-soft); color: var(--accent); }
  .history-item-main {
    flex: 1; min-width: 0;
    display: flex; flex-direction: column;
    gap: 1px;
  }
  .history-item .t {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 500;
  }
  .history-item .preview {
    font-size: 10px;
    color: var(--muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    opacity: 0.75;
  }
  .history-item .time {
    flex: 0 0 auto; font-size: 10px; color: var(--muted);
    padding-top: 1px;
    white-space: nowrap;
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
  .msg-text.error { color: var(--err); }
  .msg-attachments {
    display: flex; flex-wrap: wrap; gap: 6px;
    margin-bottom: 6px;
  }
  .msg-attach-img {
    max-width: 160px; max-height: 120px;
    border-radius: 6px;
    border: 1px solid var(--border-subtle);
    object-fit: cover;
    display: block;
    cursor: zoom-in;
  }
  .msg-attach-chip {
    display: inline-flex; align-items: center;
    max-width: 160px;
    padding: 3px 8px;
    border-radius: 6px;
    border: 1px solid var(--border-subtle);
    background: var(--surface-hover);
    font-size: 10.5px;
    color: var(--muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
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

  /* ── Tool group (Cursor-style file list) ── */
  .tool-group {
    margin: 6px 0;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: color-mix(in srgb, var(--bg) 96%, var(--accent));
  }
  .tool-group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    cursor: pointer;
    user-select: none;
  }
  .tool-group-header:hover { background: var(--surface-hover); }
  .tool-group-header .chevron {
    font-size: 9px;
    color: var(--muted);
    transition: transform 0.15s;
    flex: 0 0 auto;
  }
  .tool-group.open .tool-group-header .chevron { transform: rotate(90deg); }
  .tool-group-title {
    flex: 1;
    font-size: 12px;
    font-weight: 500;
    min-width: 0;
  }
  .tool-group-body {
    display: none;
    border-top: 1px solid var(--border-subtle);
    padding: 4px 0;
  }
  .tool-group.open .tool-group-body { display: block; }
  .file-change-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px 5px 12px;
    font-size: 12px;
    line-height: 1.35;
  }
  .file-change-item.clickable {
    cursor: pointer;
  }
  .file-change-item.clickable:hover {
    background: var(--surface-hover);
  }
  .file-badge {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    font-family: var(--mono-font);
  }
  .file-badge.modified { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  .file-badge.created { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .file-badge.read { background: color-mix(in srgb, var(--link-fg) 16%, transparent); color: var(--link-fg); }
  .file-badge.search { background: color-mix(in srgb, var(--muted) 16%, transparent); color: var(--muted); }
  .file-badge.command { background: color-mix(in srgb, var(--muted) 12%, transparent); color: var(--muted); }
  .file-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .file-name {
    font-family: var(--mono-font);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-change-item.clickable .file-name { color: var(--link-fg); }
  .file-meta {
    font-size: 10.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-stats {
    flex: 0 0 auto;
    font-family: var(--mono-font);
    font-size: 10.5px;
    color: var(--muted);
    white-space: nowrap;
  }
  .file-stats.add { color: var(--ok); }
  .file-stats.del { color: var(--err); }
  .file-stats .add-part { color: var(--ok); }
  .file-stats .del-part { color: var(--err); }
  .tool-group-section {
    padding: 4px 10px 2px 12px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }

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
  .attach-preview {
    display: none;
    flex-wrap: wrap;
    gap: 6px;
    padding: 2px 2px 6px;
  }
  .attach-preview.has-items { display: flex; }
  .attach-thumb {
    position: relative;
    width: 52px; height: 52px;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--border-subtle);
    background: var(--surface-hover);
    flex: 0 0 auto;
    cursor: zoom-in;
  }
  .attach-thumb img {
    width: 100%; height: 100%;
    object-fit: cover;
    display: block;
  }
  .img-lightbox {
    position: fixed;
    inset: 0;
    z-index: 2000;
    background: rgba(0,0,0,0.72);
    display: none;
    align-items: center;
    justify-content: center;
    padding: 16px;
    cursor: zoom-out;
  }
  .img-lightbox.show { display: flex; }
  .img-lightbox img {
    max-width: min(92vw, 900px);
    max-height: 88vh;
    object-fit: contain;
    border-radius: 8px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.45);
    cursor: default;
  }
  .img-lightbox-close {
    position: absolute;
    top: 12px; right: 12px;
    width: 28px; height: 28px;
    border: none; border-radius: 50%;
    background: rgba(0,0,0,0.55);
    color: #fff;
    font-size: 18px; line-height: 28px;
    cursor: pointer;
    padding: 0;
  }
  .img-lightbox-close:hover { background: rgba(180,40,40,0.9); }
  .attach-chip {
    position: relative;
    display: flex; align-items: center; gap: 4px;
    max-width: 140px;
    padding: 4px 22px 4px 8px;
    border-radius: 6px;
    border: 1px solid var(--border-subtle);
    background: var(--surface-hover);
    font-size: 10.5px;
    color: var(--fg);
  }
  .attach-chip .aname {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .attach-remove {
    position: absolute;
    top: 2px; right: 2px;
    width: 16px; height: 16px;
    border: none; border-radius: 50%;
    background: rgba(0,0,0,0.55);
    color: #fff;
    font-size: 11px; line-height: 16px;
    cursor: pointer;
    padding: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .attach-remove:hover { background: rgba(180,40,40,0.9); }
  .attach-btn {
    width: 26px; height: 26px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; flex: 0 0 auto;
    padding: 0;
  }
  .attach-btn:hover { color: var(--fg); background: var(--surface-hover); border-color: var(--border-subtle); }
  .attach-btn:disabled { opacity: 0.45; cursor: not-allowed; }
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
    <div class="brand"><img class="logo-img" src="${logoSrc}" alt="HxxCode" />HxxCode</div>
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
      <div style="padding: 0 4px 4px;">
        <input
          type="text"
          id="sessionSearch"
          placeholder="搜索会话…"
          style="
            width: 100%;
            background: var(--input-bg, #2b2b2b);
            border: 1px solid var(--border-subtle);
            border-radius: 6px;
            color: var(--fg);
            font-size: 12px;
            padding: 5px 8px;
            outline: none;
          "
          onfocus="this.style.borderColor='var(--accent)'"
          onblur="this.style.borderColor='var(--border-subtle)'"
        />
      </div>
      <div class="new-session-btn" id="newSessionBtn">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        新建会话
      </div>
      <div class="hist-divider"></div>
      <div id="sessionList" style="max-height:340px;overflow-y:auto;"></div>
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
      <div class="attach-preview" id="attachPreview"></div>
      <textarea id="inputBox" placeholder="输入消息，Enter 发送，Shift+Enter 换行" rows="1"></textarea>
      <div class="composer-toolbar">
        <div class="left">
          <button type="button" class="attach-btn" id="attachBtn" title="添加附件：图片或文本文件（最多5个；图片≤5MB；文本≤200KB）。不支持 PDF/Office/压缩包/音视频等" aria-label="添加附件">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
          <input type="file" id="fileInput" multiple hidden />
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

  <div class="img-lightbox" id="imgLightbox" role="dialog" aria-modal="true" aria-label="图片预览">
    <button type="button" class="img-lightbox-close" id="imgLightboxClose" title="关闭" aria-label="关闭">×</button>
    <img id="imgLightboxImg" alt="预览" />
  </div>

<script type="application/json" id="boot-state">${bootJson}</script>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
