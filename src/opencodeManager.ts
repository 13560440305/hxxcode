import * as vscode from "vscode";
import * as fs from "fs/promises";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { ProviderStore, buildOpencodeProviderConfig, envVarName } from "./providerStore";
import { log, showDiag } from "./log";
import { getOpencodeConfigPath, ensureOpencodeDirs, readJSON } from "./storage";

// ── Stream event types ───────────────────────────────────────────────────────
const TERMINAL_CHUNK_TYPES = new Set([
  "session.next.step.failed",
]);
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
    const msg = detail !== undefined ? `${step} ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : step;
    log("[flow/opencode]", msg);
  }

  private async doStart(): Promise<void> {
    this.flow("doStart 开始", { workspace: this.workspaceRoot });
    await this.writeOpencodeConfig();
    const env = await this.buildEnv();
    const envKeys = Object.keys(env).filter((k) => k.startsWith("OPENCODE_BRIDGE_"));
    this.flow("buildEnv", { keys: envKeys, hasKeys: envKeys.length > 0 });

    const { createOpencode } = await import("@opencode-ai/sdk");
    this.server = await createOpencode({
      config: { cwd: this.workspaceRoot },
      env,
      onStderr: (text) => log("[opencode/stderr]", text.trimEnd()),
      onLog: (msg) => log("[opencode/sdk]", msg),
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
    await this.stop();
    await this.start();
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
    if (!this.client) {
      try {
        await this.start();
      } catch (err) {
        throw new Error(
          `无法启动 OpenCode Server：${(err as Error).message}\n\n` +
            "请确保 @opencode-ai/cli 已安装且在 PATH 上（npm install -g @opencode-ai/cli），\n" +
            "命令名为 lildax，然后在设置面板中配置供应商。"
        );
      }
    }
    if (!this.client) {
      throw new Error(
        "无法连接到 OpenCode Server。\n\n" +
          "请确保 @opencode-ai/cli 已安装且在 PATH 上，然后在设置面板中配置供应商。\n" +
          "安装方法：npm install -g @opencode-ai/cli"
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
  async prompt(sessionId: string, text: string) {
    const client = await this.ensureClient();
    const { provider, model } = this.providerStore.getActive();
    if (!provider || !model) {
      throw new Error("尚未配置可用的模型供应商，请先在设置面板中添加供应商和模型");
    }
    return client.session.prompt({
      path: { id: sessionId },
      body: {
        model: `${provider.id}/${model}`,
        parts: [{ type: "text", text }],
      },
    });
  }

  /**
   * 流式发送 prompt：通过 OpenCode Server 发送消息，接收流式事件
   * （文本增量、工具调用、工具结果），转化为 StreamEvent 回调，
   * 由调用方（chatViewProvider）转发给 Webview 渲染。
   * 支持 AbortSignal 取消。
   */
  async promptStream(
    sessionId: string,
    text: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const t0 = Date.now();
    const client = await this.ensureClient();
    const { provider, model } = this.providerStore.getActive();
    if (!provider || !model) {
      throw new Error("尚未配置可用的模型供应商，请先在设置面板中添加");
    }

    this.flow("promptStream 开始", {
      sessionId,
      model: `${provider.id}/${model}`,
      textLen: text.length,
    });

    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: `${provider.id}/${model}`,
        parts: [{ type: "text", text }],
      },
    });

    const iterable = result as AsyncIterable<Record<string, unknown>>;
    let finished = false;
    let chunkCount = 0;
    try {
      for await (const chunk of iterable) {
        chunkCount++;
        if (signal?.aborted) {
          this.flow("promptStream 已取消", { chunks: chunkCount });
          break;
        }
        const chunkType = (chunk as Record<string, unknown>).type;
        if (chunkCount <= 20 || TERMINAL_CHUNK_TYPES.has(String(chunkType))) {
          this.flow(`promptStream chunk #${chunkCount}`, chunkType);
        } else if (chunkCount === 21) {
          this.flow("promptStream …后续 chunk 省略");
        }
        this.interpretChunk(chunk, (event) => {
          if (event.type === "finish") finished = true;
          onEvent(event);
        });
      }
    } catch (err) {
      if (finished || this.isBenignStreamError(err)) {
        this.flow("promptStream 结束 (benign)", { chunks: chunkCount, ms: Date.now() - t0 });
        return;
      }
      this.flow("promptStream 错误", { err: String(err), chunks: chunkCount, ms: Date.now() - t0 });
      onEvent({ type: "error", error: String(err) });
      return;
    }
    if (!signal?.aborted && !finished) onEvent({ type: "finish" });
    this.flow("promptStream 完成", { chunks: chunkCount, finished, ms: Date.now() - t0 });
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
    if (type === "session.next.text.delta") {
      const data = chunk.data as Record<string, unknown> | undefined;
      const delta = (data?.delta ?? data?.text) as string | undefined;
      if (delta) onEvent({ type: "text", text: delta });
      return;
    }
    if (type === "session.next.text.ended") {
      const data = chunk.data as Record<string, unknown> | undefined;
      const text = data?.text as string | undefined;
      if (text) onEvent({ type: "text", text });
      return;
    }
    if (type === "session.next.step.failed") {
      const data = chunk.data as Record<string, unknown> | undefined;
      onEvent({
        type: "error",
        error: (data?.error ?? data?.message ?? "Agent 执行失败") as string,
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
    if (type === "session.next.step.failed") {
      onEvent({ type: "finish" });
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
      onEvent({ type: "error", error: (chunk.message ?? chunk.error) as string });
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
    const merged = {
      ...existing,
      $schema: existing.$schema ?? "https://opencode.ai/config.json",
      provider: {
        ...((existing.provider as Record<string, unknown>) ?? {}),
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

