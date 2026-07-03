import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as net from "net";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { ProviderStore, buildOpencodeProviderConfig, envVarName } from "./providerStore";
import { getOpencodeConfigPath } from "./storage";

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

  private async doStart(): Promise<void> {
    await this.writeOpencodeConfig();
    const port = await findFreePort();
    const env = await this.buildEnv();

    const { createOpencode } = await import("@opencode-ai/sdk");
    this.server = await createOpencode({
      hostname: "127.0.0.1",
      port,
      // OpenCode 会读取工作区下的 opencode.json，这里只需指定运行目录
      config: { cwd: this.workspaceRoot },
      env,
    });
    this.client = this.server.client;

    const health = await this.client.global.health();
    if (!health.data.healthy) {
      throw new Error("HxxCode server 启动后健康检查未通过");
    }
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

  getClient(): OpencodeClient {
    if (!this.client) {
      throw new Error("HxxCode server 尚未启动，请先调用 start()");
    }
    return this.client;
  }

  /** 新建一次对话 session */
  async createSession(title: string) {
    const client = this.getClient();
    const { provider, model } = this.providerStore.getActive();
    if (!provider || !model) {
      throw new Error("尚未配置可用的模型供应商，请先在设置面板中添加");
    }
    const session = await client.session.create({ body: { title } });
    return session.data;
  }

  /** 发送一条 prompt，返回可迭代的流式响应（由调用方转发给 Webview 渲染） */
  async prompt(sessionId: string, text: string) {
    const client = this.getClient();
    const { provider, model } = this.providerStore.getActive();
    if (!provider || !model) {
      throw new Error("尚未配置可用的模型供应商，请先在设置面板中添加");
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
   * 流式发送 prompt：将 SDK 返回的流式事件（文本增量、工具调用、工具结果）转化为
   * StreamEvent 回调，由调用方（chatViewProvider）转发给 Webview 渲染。
   * 支持 AbortSignal 取消。
   */
  async promptStream(
    sessionId: string,
    text: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const client = this.getClient();
    const { provider, model } = this.providerStore.getActive();
    if (!provider || !model) {
      throw new Error("尚未配置可用的模型供应商，请先在设置面板中添加");
    }

    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: `${provider.id}/${model}`,
        parts: [{ type: "text", text }],
      },
    });

    // 处理流式响应：适配 SDK 可能返回的多种流式形态
    const stream = result as unknown;
    if (stream && typeof stream === "object") {
      // 形态 1：AsyncIterable<StreamChunk>
      if (Symbol.asyncIterator in Object(stream)) {
        for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
          if (signal?.aborted) break;
          this.interpretChunk(chunk, onEvent);
        }
        if (!signal?.aborted) onEvent({ type: "finish" });
        return;
      }

      // 形态 2：{ on(): ... } EventEmitter 风格（Node.js Stream / EventEmitter）
      interface EventEmitterLike {
        on(event: string, listener: (...args: unknown[]) => void): void;
        removeListener(event: string, listener: (...args: unknown[]) => void): void;
      }
      if ("on" in stream && typeof (stream as Record<string, unknown>).on === "function") {
        return new Promise<void>((resolve) => {
          const emitter = stream as EventEmitterLike;
          const onData = (chunk: unknown) => {
            if (signal?.aborted) {
              cleanup();
              resolve();
              return;
            }
            if (chunk && typeof chunk === "object") {
              this.interpretChunk(chunk as Record<string, unknown>, onEvent);
            }
          };
          const onEnd = () => {
            cleanup();
            onEvent({ type: "finish" });
            resolve();
          };
          const onError = (...args: unknown[]) => {
            cleanup();
            const err = args[0];
            onEvent({ type: "error", error: String(err) });
            resolve();
          };
          const cleanup = () => {
            emitter.removeListener("data", onData);
            emitter.removeListener("end", onEnd);
            emitter.removeListener("error", onError);
          };
          emitter.on("data", onData);
          emitter.on("end", onEnd);
          emitter.on("error", onError);
        });
      }

      // 形态 3：如果 SDK 直接返回完整响应（非流式），作为单块文本发出
      const data = stream as Record<string, unknown>;
      if (data.text && typeof data.text === "string") {
        onEvent({ type: "text", text: data.text });
        onEvent({ type: "finish" });
        return;
      }
      if (data.content && Array.isArray(data.content)) {
        for (const part of data.content) {
          if (part.type === "text") {
            onEvent({ type: "text", text: part.text });
          }
          if (part.type === "tool_use") {
            onEvent({
              type: "tool_use",
              toolCallId: part.id ?? part.toolCallId,
              toolName: part.name,
              toolInput: part.input,
            });
          }
        }
        onEvent({ type: "finish" });
        return;
      }
    }

    // 兜底：未知格式，至少通知完成
    onEvent({ type: "finish" });
  }

  /**
   * 将 SDK 返回的单个 chunk 解析为 StreamEvent。
   * SDK 的具体 chunk 格式未知，这里是适配层，根据实际输出调整。
   */
  private interpretChunk(chunk: Record<string, unknown>, onEvent: (e: StreamEvent) => void): void {
    const type = chunk.type as string | undefined;

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
    const providerConfig = buildOpencodeProviderConfig(this.providerStore.list());
    const configPath = getOpencodeConfigPath();
    const content = JSON.stringify({ provider: providerConfig }, null, 2);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, content, "utf-8");
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

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error("无法分配端口"));
      }
    });
  });
}
