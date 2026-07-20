import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import type { OpencodeClient, PermissionReply, PermissionRequest } from "@opencode-ai/sdk";
import { ProviderStore, buildOpencodeProviderConfig, envVarName } from "./providerStore";
import { log, logAlways, logError, logInfo } from "./log";
import { getOpencodeConfigPath, ensureOpencodeDirs, readJSON } from "./storage";

// ── Stream event types ───────────────────────────────────────────────────────
export type StreamEventType =
  | "text"          // AI 生成了一段文本增量
  | "tool_use"      // AI 请求调用工具（开始执行）
  | "tool_result"   // 工具执行完成，返回结果
  | "error"         // 发生错误
  | "finish";       // 本次 prompt 响应结束

export interface StreamEvent {
  type: StreamEventType;
  /** text 类型时：文本增量 */
  text?: string;
  /** tool_use / tool_result 时：工具调用 ID */
  toolCallId?: string;
  /** tool_use / tool_result 时：工具名称（read / write / bash / grep …） */
  toolName?: string;
  /** tool_use 时：工具入参 */
  toolInput?: Record<string, unknown>;
  /** tool_result 时：工具执行结果文本 */
  toolResult?: unknown;
  /** error 时：错误信息 */
  error?: string;
}

export interface PromptImageAttachment {
  mime: string;
  name: string;
  /** data:image/...;base64,... 或可读的绝对路径（会转成 data URL） */
  dataUrl?: string;
  path?: string;
}

export interface PromptTextAttachment {
  name: string;
  content: string;
}

export interface PromptAttachments {
  images?: PromptImageAttachment[];
  texts?: PromptTextAttachment[];
}

/** 把未知错误值转成可读字符串（避免 [object Object]） */
export function formatErrorMessage(err: unknown): string {
  if (err == null) return "未知错误";
  if (typeof err === "string") return friendlyProviderError(err);
  if (err instanceof Error) return friendlyProviderError(err.message || String(err));
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message) {
      return friendlyProviderError(obj.message);
    }
    if (obj.error != null) return formatErrorMessage(obj.error);
    try {
      return friendlyProviderError(JSON.stringify(err));
    } catch {
      return "未知错误";
    }
  }
  return friendlyProviderError(String(err));
}

function friendlyProviderError(message: string): string {
  // 避免 formatErrorMessage 递归把已友好化文案再包一层
  if (
    message.includes("请执行「HxxCode: 启动 / 重启 Server」") ||
    message.includes("常见原因：①")
  ) {
    return message;
  }
  if (/404|Not Found/i.test(message) && /bigmodel|open\.bigmodel|智谱|glm/i.test(message)) {
    return (
      "HTTP 404：智谱 API 地址不正确。Base URL 请填 https://open.bigmodel.cn/api/paas/v4（不要带 /chat/completions）。" +
      "保存后重新加载窗口，再试聊天或拉取模型列表。\n\n" +
      `详情: ${message}`
    );
  }
  if (/404|Not Found/i.test(message) && /chat\/completions/i.test(message)) {
    return (
      "HTTP 404：供应商 API 地址被拼错（常见原因：Base URL 多填了 /chat/completions，或路径里重复出现 /v1）。" +
      "请只填 API 根地址，例如智谱 https://open.bigmodel.cn/api/paas/v4、DeepSeek https://api.deepseek.com。" +
      "保存后重新加载窗口。\n\n" +
      `详情: ${message}`
    );
  }
  if (/模型未响应|agent 在 30s 内未启动|等待 OpenCode 响应超时|后端可能已卡住/i.test(message)) {
    return (
      "对话事件丢失或 Agent 启动超时（智谱接口本身往往已成功）。" +
      "请重载窗口后执行「HxxCode: 启动 / 重启 Server」，再新建会话。" +
      "看图请用 glm-4.6v / glm-5v-turbo。\n\n" +
      `详情: ${message}`
    );
  }
  if (/image_url|unknown variant `image`|expected `text`|does not support image|type=\"image\"|Not Supported/i.test(message)) {
    return (
      "当前供应商 API 不接受图片内容（仅支持 text）。" +
      "DeepSeek 官方 API（api.deepseek.com）目前为纯文本接口，即使 deepseek-v4-pro 也不能直接传 image_url；" +
      "Claude Code 等工具若能「看图」，通常是先用其它 Vision 模型转成文字再发给 DeepSeek。" +
      "请改用支持多模态的供应商/模型（如 OpenAI GPT-4o、带 Vision 的中转），或改用文字描述截图。" +
      "发送纯文字消息时会自动跳过历史图片，无需新建会话。\n\n" +
      `详情: ${message}`
    );
  }
  return message;
}

/** 是否为「SSE 未收到 step / Agent 未启动」类超时 */
export function isAgentStartTimeoutError(message: string): boolean {
  return /模型未响应|agent 在 30s 内未启动|等待 OpenCode 响应超时|后端可能已卡住/i.test(
    message
  );
}

/** 是否为「模型/API 不支持图片」类错误 */
export function isImageUnsupportedError(message: string): boolean {
  return /image_url|unknown variant `image`|expected `text`|does not support image|type=\"image\"|Not Supported/i.test(
    message
  );
}

/** 把用户输入与文本附件拼成最终 prompt 文本 */
export function buildPromptText(
  userText: string,
  texts?: PromptTextAttachment[]
): string {
  const chunks: string[] = [];
  const trimmed = userText.trim();
  if (trimmed) chunks.push(trimmed);
  if (texts?.length) {
    for (const t of texts) {
      chunks.push(`---\n附件: ${t.name}\n\`\`\`\n${t.content}\n\`\`\`\n---`);
    }
  }
  return chunks.join("\n\n") || "(附件)";
}

/**
 * 负责：
 * 1. 找一个空闲端口，spawn `opencode serve`
 * 2. 根据 ProviderStore 的当前配置生成 opencode.json 并写入工作区
 * 3. 把真实 API Key 通过子进程 env 注入，不落盘
 * 4. 持有 SDK client，暴露 session 相关方法给 chatViewProvider 使用
 * 5. 供应商变更时重启子进程；模型切换不重启，直接改 session 的 model 字段
 */
export class OpencodeManager implements vscode.Disposable {
  private server: Awaited<ReturnType<typeof import("@opencode-ai/sdk").createOpencode>> | null =
    null;
  private client: OpencodeClient | null = null;
  private starting: Promise<void> | null = null;
  private forceServiceRestart = false;
  private permissionHandler:
    | ((request: PermissionRequest) => Promise<PermissionReply>)
    | null = null;
  /** 本进程内用户点过「始终允许」的路径前缀，避免服务端未记住时反复弹窗/假成功卡住 */
  private rememberedAllowPrefixes: string[] = [];
  /** 当前 step 是否已收到 text.delta（避免 text.ended 全量再追加一次） */
  private sawTextDeltaInStep = false;
  /** 本次 prompt 开始时间，恢复时只接受此之后的 assistant */
  private lastPromptStartedAt = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly providerStore: ProviderStore,
    private readonly workspaceRoot: string
  ) {}

  async start(): Promise<void> {
    if (this.client) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private flow(step: string, detail?: unknown): void {
    const msg =
      detail !== undefined
        ? `${step} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`
        : step;
    // 关键节点始终可见；高频 chunk 细节走 debug
    if (/chunk #|等待中|后续 chunk/.test(step)) {
      log("[flow]", msg);
      return;
    }
    if (/permission|cancel|wait|prompt|错误|失败/i.test(step)) {
      logAlways("[flow]", msg);
      return;
    }
    logInfo("[flow]", msg);
  }

  private async doStart(): Promise<void> {
    const agentBackend = this.providerStore.getActiveAgentBackend();
    this.flow("doStart 开始", {
      workspace: this.workspaceRoot,
      agentBackend: agentBackend.id,
      cli: agentBackend.command,
    });
    await this.writeOpencodeConfig();
    const env = await this.buildEnv();
    const envKeys = Object.keys(env).filter((k) => k.startsWith("OPENCODE_BRIDGE_"));
    this.flow("buildEnv", { keys: envKeys, hasKeys: envKeys.length > 0 });

    const { createOpencode } = await import("@opencode-ai/sdk");
    this.server = await createOpencode({
      config: { cwd: this.workspaceRoot },
      env,
      cli: agentBackend.command,
      cliPackage: agentBackend.npmPackage,
      restartService: this.forceServiceRestart,
      timeout: process.platform === "win32" ? 90_000 : 45_000,
      onPermission: (request) => this.handlePermissionRequest(request),
      onLog: (msg) => {
        const text = String(msg ?? "");
        // 空权限轮询 / wait 不可用：正常降级路径，勿刷诊断通道
        if (
          /GET .*\/permission.*→\s*200/i.test(text) ||
          /wait 不可用|WAIT_UNAVAILABLE|Session wait is not available/i.test(text)
        ) {
          log("[opencode/sdk]", text);
          return;
        }
        if (
          /权限待确认|permission ask|pending=|prompt 已|完成确认|错误|失败|取消|轮询命中/i.test(
            text
          )
        ) {
          logAlways("[opencode/sdk]", text);
        } else {
          log("[opencode/sdk]", text);
        }
      },
    });
    this.client = this.server.client;

    const health = await this.client.global.health();
    if (!health.data.healthy) {
      throw new Error("HxxCode server 启动后健康检查未通过");
    }
    this.flow("doStart 完成");
  }

  /** 供应商增删改后调用：重写配置文件并重启子进程 */
  async restart(): Promise<void> {
    this.forceServiceRestart = true;
    try {
      await this.stop();
      await this.start();
    } finally {
      this.forceServiceRestart = false;
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.server.close?.();
      this.server = null;
      this.client = null;
    }
  }

  /** 获取 client，如果尚未启动则自动尝试启动 */
  private async ensureClient(): Promise<OpencodeClient> {
    const backend = this.providerStore.getActiveAgentBackend();
    if (!this.client) {
      try {
        await this.start();
      } catch (err) {
        const installHint = backend.npmPackage
          ? `npm install -g ${backend.npmPackage}`
          : "请确保 CLI 在 PATH 上";
        throw new Error(
          `无法启动 Agent 后端「${backend.name}」：${(err as Error).message}\n\n` +
            `当前 CLI 命令：${backend.command}\n` +
            `安装/配置：${installHint}\n` +
            `可在 ~/.hxxcode/config.json 的 agentBackend 中切换后端。`
        );
      }
    }
    if (!this.client) {
      throw new Error(
        `无法连接到 Agent 后端「${backend.name}」。\n\n` +
          `当前 CLI：${backend.command}\n` +
          `请在设置面板或 ~/.hxxcode/config.json 中检查 agentBackend 配置。`
      );
    }
    return this.client;
  }

  /** 新建一次对话 session */
  async createSession(title: string) {
    const client = await this.ensureClient();
    const { provider, model } = this.providerStore.getActive();
    if (!provider || !model) {
      throw new Error("尚未配置可用的模型供应商，请先在设置面板中添加供应商和模型");
    }
    const session = await client.session.create({
      body: { title, model: `${provider.id}/${model}` },
    });
    if (!session.data?.id) {
      throw new Error("OpenCode session 创建失败：未返回 session ID");
    }
    return session.data;
  }

  /** OpenCode 2.0 的 session ID 以 ses_ 开头 */
  isBackendSessionId(sessionId: string): boolean {
    return sessionId.startsWith("ses_");
  }

  /**
   * 确保 sessionId 对应 OpenCode 后端上存在的 session。
   * 本地 shortId 或 server 重启后失效的 session 会重新创建。
   */
  async ensureBackendSession(sessionId: string, title?: string): Promise<string> {
    this.flow("ensureBackendSession", { sessionId, title });
    const client = await this.ensureClient();
    if (
      this.isBackendSessionId(sessionId) &&
      client.session.get
    ) {
      const existing = await client.session.get(sessionId);
      if (existing.data) {
        this.flow("ensureBackendSession 复用", sessionId);
        return sessionId;
      }
      this.flow("ensureBackendSession 后端 session 不存在，重建", sessionId);
    } else {
      this.flow("ensureBackendSession 本地 ID，需创建", sessionId);
    }
    const session = await this.createSession(title ?? "Chat");
    this.flow("ensureBackendSession 新 session", session.id);
    return session.id;
  }

  /** 发送一条 prompt，返回可迭代的流式响应（由调用方转发给 Webview 渲染） */
  async prompt(sessionId: string, text: string, attachments?: PromptAttachments) {
    const client = await this.ensureClient();
    const { provider, model } = this.providerStore.getActive();
    if (!provider || !model) {
      throw new Error("尚未配置可用的模型供应商，请先在设置面板中添加供应商和模型");
    }
    const parts = await this.buildPromptParts(text, attachments);
    return client.session.prompt({
      path: { id: sessionId },
      body: {
        model: `${provider.id}/${model}`,
        parts,
      },
    });
  }

  /**
   * OpencodeExecutor 核心（设计 §7）：
   * 受理 prompt → 定时查 /message 完成态 → POST /wait 双保险。
   * SSE 仅进度；超时且 wait 未确认则抛错（task failed）。
   */
  async runAgentTurn(opts: {
    sessionId: string;
    text: string;
    attachments?: PromptAttachments;
    signal?: AbortSignal;
    onEvent: (event: StreamEvent) => void;
    completionPollIntervalMs?: number;
    completionTimeoutMs?: number;
    waitTimeoutMs?: number;
  }): Promise<void> {
    const client = await this.ensureClient();
    const { provider, model } = this.providerStore.getActive();
    if (!provider || !model) {
      throw new Error("尚未配置可用的模型供应商，请先在设置面板中添加");
    }

    const parts = await this.buildPromptParts(opts.text, opts.attachments);
    this.lastPromptStartedAt = Date.now();
    this.sawTextDeltaInStep = false;

    if (opts.signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    const pollMs = opts.completionPollIntervalMs ?? 1_000;
    const timeoutMs = opts.completionTimeoutMs ?? opts.waitTimeoutMs ?? 600_000;

    const result = client.session.prompt({
      path: { id: opts.sessionId },
      body: {
        model: `${provider.id}/${model}`,
        parts,
      },
      signal: opts.signal,
      completionPollIntervalMs: pollMs,
      completionTimeoutMs: timeoutMs,
    });

    const iterable = result as AsyncIterable<Record<string, unknown>>;
    const iterator =
      typeof (iterable as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator] ===
      "function"
        ? (iterable as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]()
        : null;

    let finished = false;
    const onAbort = () => {
      void iterator?.return?.();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const emit = (event: StreamEvent) => {
      if (event.type === "finish") finished = true;
      opts.onEvent(event);
    };

    try {
      if (!iterator) {
        for await (const chunk of iterable) {
          if (opts.signal?.aborted) break;
          this.handlePromptChunk(chunk, emit);
        }
      } else {
        while (true) {
          if (opts.signal?.aborted) {
            await iterator.return?.();
            break;
          }
          const next = await iterator.next();
          if (next.done) break;
          this.handlePromptChunk(next.value, emit);
        }
      }

      if (opts.signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      // 设计：完成只能来自 message/wait；若生成器结束仍无 finish，视为失败
      if (!finished) {
        throw new Error(
          "Agent 回合结束但未确认完成态（message/wait）。请重启 HxxCode Server 后新建会话重试。"
        );
      }
    } catch (err) {
      if (opts.signal?.aborted) {
        throw err instanceof Error
          ? err
          : new DOMException("The operation was aborted", "AbortError");
      }
      const errMsg = formatErrorMessage(err);
      if (finished) {
        return;
      }
      emit({ type: "error", error: errMsg });
      throw err instanceof Error ? err : new Error(errMsg);
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * 取消双保险：确认远端 agent loop 已 idle，或本轮 assistant 已最终完成。
   * 供 ConversationManager / LildaxRuntime 取消确认使用。
   */
  async confirmSessionIdle(
    sessionId: string,
    signal?: AbortSignal,
    timeoutMs = 20_000
  ): Promise<boolean> {
    const client = await this.ensureClient();
    const deadline = Date.now() + Math.max(1_000, timeoutMs);

    // 1) wait（短超时）；503/404 视为不可用，立刻走轮询
    if (client.session.wait) {
      try {
        await client.session.wait(sessionId, {
          signal,
          timeoutMs: Math.min(5_000, timeoutMs),
        });
        return true;
      } catch (err) {
        if (signal?.aborted) return false;
        this.flow("confirmSessionIdle wait 未确认", formatErrorMessage(err));
      }
    }

    // 2) 轮询 message，直到确认本轮最终结束或超时
    while (!signal?.aborted && Date.now() < deadline) {
      try {
        if (!client.session.listMessages) break;
        const res = await client.session.listMessages(sessionId);
        const messages = res.data ?? [];
        const afterMs = this.lastPromptStartedAt || 0;
        let latest: (typeof messages)[number] | null = null;
        for (const msg of messages) {
          if (msg?.type !== "assistant") continue;
          const created = Number(msg.time?.created ?? 0);
          if (afterMs && created && created < afterMs) continue;
          if (!latest || created >= Number(latest.time?.created ?? 0)) {
            latest = msg;
          }
        }
        if (latest) {
          const finish = (latest as { finish?: string }).finish ?? null;
          // 中间态 tool-calls 不算已停
          if (finish !== "tool-calls" && finish !== "tool_calls") {
            if (
              latest.time?.completed ||
              finish === "stop" ||
              finish === "end_turn" ||
              finish === "cancelled" ||
              finish === "canceled" ||
              finish === "error"
            ) {
              return true;
            }
          }
        }
      } catch {
        // ignore one poll error
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    return false;
  }

  /** SSE 丢事件时，只捞「本次 prompt 之后」完成的 assistant 文本 */
  private async tryRecoverAssistantText(sessionId: string): Promise<string | null> {
    try {
      const client = await this.ensureClient();
      if (!client.session.listMessages) return null;
      const res = await client.session.listMessages(sessionId);
      const messages = res.data ?? [];
      const afterMs = this.lastPromptStartedAt || 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.type !== "assistant") continue;
        const created = Number(msg.time?.created ?? 0);
        if (afterMs && created && created < afterMs) continue;
        if (!msg.time?.completed && !(msg as { finish?: string }).finish) continue;
        const texts = (msg.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string);
        const text = texts.join("\n").trim();
        if (text) {
          return text;
        }
      }
    } catch {
      // 忽略恢复失败
    }
    return null;
  }

  /** 复杂识图时 Agent 可能晚于 SSE 结束，周期性重试捞正文 */
  private async tryRecoverAssistantTextWithWait(
    sessionId: string,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<string | null> {
    const t0 = Date.now();
    while (!signal?.aborted && Date.now() - t0 < timeoutMs) {
      const text = await this.tryRecoverAssistantText(sessionId);
      if (text) return text;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  }

  private handlePromptChunk(
    chunk: Record<string, unknown>,
    onEvent: (event: StreamEvent) => void
  ): void {
    this.interpretChunk(chunk, onEvent);
  }

  private async buildPromptParts(
    text: string,
    attachments?: PromptAttachments
  ): Promise<Array<{ type: string; text?: string; mime?: string; filename?: string; url?: string }>> {
    const promptText = buildPromptText(text, attachments?.texts);
    const parts: Array<{
      type: string;
      text?: string;
      mime?: string;
      filename?: string;
      url?: string;
    }> = [{ type: "text", text: promptText }];

    for (const img of attachments?.images ?? []) {
      const url = await this.resolveImageDataUrl(img);
      if (!url) continue;
      parts.push({
        type: "file",
        mime: img.mime || "image/png",
        filename: img.name || "image.png",
        url,
      });
    }
    return parts;
  }

  private async resolveImageDataUrl(img: PromptImageAttachment): Promise<string | null> {
    if (img.dataUrl?.startsWith("data:")) return img.dataUrl;
    if (img.path) {
      try {
        const buf = await fs.readFile(img.path);
        const mime = img.mime || "image/png";
        return `data:${mime};base64,${buf.toString("base64")}`;
      } catch (err) {
        logError("读取图片附件失败:", String(err));
        return null;
      }
    }
    return null;
  }

  /** 由 ChatViewProvider 注册：在侧栏 Webview 内展示权限确认 */
  setPermissionHandler(
    handler: (request: PermissionRequest) => Promise<PermissionReply>
  ): void {
    this.permissionHandler = handler;
  }

  private async handlePermissionRequest(
    request: PermissionRequest
  ): Promise<PermissionReply> {
    // 工作区内部低风险读写可自动批准；外部目录/bash 等必须弹 UI
    if (this.isWorkspaceLocalPermission(request)) {
      logAlways("[permission] auto-approve (workspace)", {
        action: request.action,
        resources: request.resources,
      });
      return "always";
    }

    if (this.isRememberedAllow(request)) {
      logAlways("[permission] auto-approve (remembered)", {
        action: request.action,
        resources: request.resources,
      });
      return "always";
    }

    logAlways("[permission] ask user", {
      action: request.action,
      resources: request.resources,
      id: request.id,
    });

    if (this.permissionHandler) {
      const reply = await this.permissionHandler(request);
      logAlways("[permission] user reply", {
        action: request.action,
        reply,
      });
      if (reply === "always") {
        this.rememberAllow(request);
      }
      return reply;
    }

    const action = request.action ?? "unknown";
    const resources = (request.resources ?? []).join(", ") || "未知范围";
    const choice = await vscode.window.showQuickPick(
      [
        { label: "$(check) 允许一次", description: "仅批准本次操作", value: "once" as const },
        {
          label: "$(check-all) 始终允许",
          description: "本次 OpenCode 会话内不再询问相同范围",
          value: "always" as const,
        },
        { label: "$(close) 拒绝", description: "取消此操作", value: "reject" as const },
      ],
      {
        title: `HxxCode 需要确认: ${action}`,
        placeHolder: resources,
        ignoreFocusOut: true,
      }
    );
    const reply = choice?.value ?? "reject";
    this.flow("permission", { action, resources: request.resources, reply });
    if (reply === "always") {
      this.rememberAllow(request);
    }
    return reply;
  }

  private rememberAllow(request: PermissionRequest): void {
    for (const raw of request.resources ?? []) {
      const p = this.resolvePermissionResourcePath(String(raw));
      if (!p) continue;
      if (!this.rememberedAllowPrefixes.includes(p)) {
        this.rememberedAllowPrefixes.push(p);
      }
    }
  }

  private isRememberedAllow(request: PermissionRequest): boolean {
    const resources = request.resources ?? [];
    if (!resources.length || !this.rememberedAllowPrefixes.length) return false;
    return resources.every((raw) => {
      const p = this.resolvePermissionResourcePath(String(raw));
      if (!p) return false;
      return this.rememberedAllowPrefixes.some(
        (prefix) => p === prefix || p.startsWith(prefix + "/") || prefix.startsWith(p + "/")
      );
    });
  }

  /**
   * 仅「当前工作区内」的低风险文件读写可自动批准。
   * 工作区外目录 / bash / 网络等一律弹授权栏（否则用户看不到确认 UI）。
   */
  private isWorkspaceLocalPermission(request: PermissionRequest): boolean {
    const action = String(request.action ?? "").toLowerCase();
    if (
      action === "bash" ||
      action === "shell" ||
      action === "external_directory" ||
      action === "webfetch" ||
      action === "websearch" ||
      action === "doom_loop"
    ) {
      return false;
    }
    const resources = request.resources ?? [];
    if (!resources.length || !this.workspaceRoot) return false;
    const root = this.normalizeFsPath(this.workspaceRoot);
    return resources.every((raw) => {
      const p = this.resolvePermissionResourcePath(String(raw));
      if (!p) return false;
      return p === root || p.startsWith(root + "/");
    });
  }

  /** 把权限资源解析成绝对路径（相对路径按工作区根拼接） */
  private resolvePermissionResourcePath(raw: string): string | null {
    let s = String(raw || "").trim();
    if (!s) return null;
    // external_directory 常见：D:/foo/* 或 /foo/*
    s = s.replace(/\/\*$/, "").replace(/\*$/, "").replace(/\/$/, "");
    if (s.startsWith("file:")) {
      try {
        s = vscode.Uri.parse(s).fsPath;
      } catch {
        s = s.replace(/^file:\/\//, "");
      }
    }
    const looksAbsolute =
      path.isAbsolute(s) ||
      /^[a-zA-Z]:[\\/]/.test(s) ||
      s.startsWith("\\\\");
    const abs = looksAbsolute ? s : path.join(this.workspaceRoot, s);
    return this.normalizeFsPath(abs);
  }

  private normalizeFsPath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^[a-zA-Z]:/, (m) => m.toUpperCase()).toLowerCase();
  }

  private isBenignStreamError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    if ((err as Error).name === "AbortError") return true;
    const msg = String((err as Error).message ?? err);
    return (
      msg === "terminated" ||
      msg.includes("terminated") ||
      msg.includes("aborted") ||
      msg.includes("The operation was aborted")
    );
  }

  /**
   * 将 SDK 返回的单个 chunk 解析为 StreamEvent。
   * SDK 的具体 chunk 格式未知，这里是适配层，根据实际输出调整。
   */
  private interpretChunk(chunk: Record<string, unknown>, onEvent: (e: StreamEvent) => void): void {
    const type = chunk.type as string | undefined;

    // OpenCode 2.0 SSE 事件（session.next.*）
    if (type === "session.next.step.started") {
      this.sawTextDeltaInStep = false;
      return;
    }
    if (type === "session.next.text.delta") {
      const data = chunk.data as Record<string, unknown> | undefined;
      const delta = (data?.delta ?? data?.text) as string | undefined;
      if (delta) {
        this.sawTextDeltaInStep = true;
        onEvent({ type: "text", text: delta });
      }
      return;
    }
    if (type === "session.next.text.ended") {
      const data = chunk.data as Record<string, unknown> | undefined;
      const text = data?.text as string | undefined;
      // 已有流式 delta 时不再追加 ended 全量文本，否则同一段会重复两遍
      if (text && !this.sawTextDeltaInStep) {
        onEvent({ type: "text", text });
      }
      return;
    }
    if (type === "session.next.step.failed") {
      const data = chunk.data as Record<string, unknown> | undefined;
      onEvent({
        type: "error",
        error: formatErrorMessage(data?.error ?? data?.message ?? "Agent 执行失败"),
      });
      onEvent({ type: "finish" });
      return;
    }
    if (type === "session.next.tool.called") {
      const data = chunk.data as Record<string, unknown> | undefined;
      onEvent({
        type: "tool_use",
        toolCallId: (data?.callID ?? data?.id) as string,
        toolName: (data?.tool ?? data?.name) as string,
        toolInput: (data?.input ?? data?.arguments) as Record<string, unknown>,
      });
      return;
    }
    if (type === "session.next.tool.success" || type === "session.next.tool.failed") {
      const data = chunk.data as Record<string, unknown> | undefined;
      onEvent({
        type: "tool_result",
        toolCallId: (data?.callID ?? data?.id) as string,
        toolName: (data?.tool ?? data?.name) as string,
        toolResult:
          data?.structured ?? data?.result ?? data?.output ?? data?.error,
      });
      return;
    }
    if (type === "session.next.step.ended") {
      const data = chunk.data as Record<string, unknown> | undefined;
      if (data?.finish === "stop" || data?.finish === "end_turn" || data?.finish === "stop-sequence") {
        onEvent({ type: "finish" });
      }
      return;
    }

    if (type === "text" || type === "text_delta") {
      const delta = (chunk.delta ?? chunk.text ?? chunk.content) as string | undefined;
      if (delta) onEvent({ type: "text", text: delta });
      return;
    }

    if (type === "tool_use" || type === "tool_use_start") {
      onEvent({
        type: "tool_use",
        toolCallId: (chunk.toolCallId ?? chunk.id ?? chunk.tool_use_id) as string,
        toolName: (chunk.name ?? chunk.toolName) as string,
        toolInput: (chunk.input ?? chunk.toolInput ?? chunk.arguments) as Record<string, unknown>,
      });
      return;
    }

    if (type === "tool_result" || type === "tool_use_end") {
      onEvent({
        type: "tool_result",
        toolCallId: (chunk.toolCallId ?? chunk.id) as string,
        toolName: (chunk.name ?? chunk.toolName) as string,
        toolResult: chunk.result ?? chunk.toolResult ?? chunk.output,
      });
      return;
    }

    if (type === "error") {
      onEvent({
        type: "error",
        error: formatErrorMessage(chunk.message ?? chunk.error ?? chunk),
      });
      return;
    }

    if (type === "finish" || type === "done" || type === "stop") {
      onEvent({ type: "finish" });
      return;
    }

    // 未知 chunk 类型 —— 如果包含 text 字段则尝试作为文本增量处理
    if (chunk.text && typeof chunk.text === "string") {
      onEvent({ type: "text", text: chunk.text as string });
    }
  }

  /** 仅切换模型：同一供应商下不需要重启 server，下一次 prompt 生效 */
  async switchModel(providerId: string, model: string): Promise<void> {
    await this.providerStore.setActive(providerId, model);
  }

  private async writeOpencodeConfig(): Promise<void> {
    const apiKeys: Record<string, string> = {};
    for (const p of this.providerStore.list()) {
      const key = await this.providerStore.getApiKey(p.id);
      if (key) apiKeys[p.id] = key;
    }
    const providerConfig = buildOpencodeProviderConfig(this.providerStore.list(), apiKeys);
    const configPath = getOpencodeConfigPath();
    const existing = await readJSON<Record<string, unknown>>(configPath, {});
    const existingProviders =
      ((existing.provider as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const managedIds = new Set(this.providerStore.list().map((p) => p.id));
    const preservedProviders: Record<string, unknown> = {};
    for (const [id, cfg] of Object.entries(existingProviders)) {
      if (!managedIds.has(id)) preservedProviders[id] = cfg;
    }
    const merged = {
      ...existing,
      $schema: existing.$schema ?? "https://opencode.ai/config.json",
      provider: {
        ...preservedProviders,
        ...providerConfig,
      },
    };
    await ensureOpencodeDirs();
    await fs.writeFile(configPath, JSON.stringify(merged, null, 2), "utf-8");
    this.flow("writeOpencodeConfig", { path: configPath, providers: Object.keys(providerConfig) });
  }

  private async buildEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const p of this.providerStore.list()) {
      const key = await this.providerStore.getApiKey(p.id);
      if (key) {
        env[envVarName(p.id)] = key;
      }
    }
    return env;
  }

  dispose(): void {
    void this.stop();
  }
}

