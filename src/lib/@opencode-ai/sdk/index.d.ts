// ── @opencode-ai/sdk 类型声明 ─────────────────────────────────────────────
// 运行时实现在同目录的 index.mjs
// 通过 OpenCode 2.0 `lildax service` 提供 Agent 能力

export interface StreamChunk {
  type: string;
  [key: string]: unknown;
}

export interface HealthResponse {
  data: { healthy: boolean };
}

export interface SessionCreateResponse {
  data: { id: string; title?: string };
}

export interface PromptTextPart {
  type: "text";
  text: string;
}

export interface PromptFilePart {
  type: "file";
  mime: string;
  filename?: string;
  /** data: 或 file:// URI；OpenCode 2.0 会映射为 prompt.files[].uri */
  url: string;
}

export type PromptPart = PromptTextPart | PromptFilePart | { type: string; text?: string; mime?: string; filename?: string; url?: string };

export interface SessionPromptBody {
  model?: string;
  parts?: PromptPart[];
  text?: string;
}

export interface PromptOptions {
  path: { id: string };
  body: SessionPromptBody;
  /** 取消时中断 SSE / 进行中的 HTTP 请求 */
  signal?: AbortSignal;
  /** 消息完成态轮询间隔（毫秒） */
  completionPollIntervalMs?: number;
  /** 单任务最长等待（毫秒） */
  completionTimeoutMs?: number;
}

export interface SessionClient {
  create(body: { body: { title?: string; model?: string } }): Promise<SessionCreateResponse>;
  get?(sessionId: string): Promise<{ data: { id: string } | null }>;
  /** 拉取会话消息（SSE 丢事件时用于兜底） */
  listMessages?(sessionId: string): Promise<{
    data: Array<{
      id?: string;
      type?: string;
      finish?: string;
      content?: Array<{ type?: string; text?: string }>;
      time?: { created?: number; completed?: number };
    }>;
  }>;
  /** 等待 session agent loop idle（POST /wait） */
  wait?(
    sessionId: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{ idle: true }>;
  prompt(options: PromptOptions): AsyncIterable<StreamChunk>;
  switchModel?(sessionId: string, modelRef: { providerID: string; id: string }): Promise<void>;
}

export interface GlobalClient {
  health(): Promise<HealthResponse>;
}

export interface OpencodeClient {
  global: GlobalClient;
  session: SessionClient;
}

export type PermissionReply = "once" | "always" | "reject";

export interface PermissionRequest {
  id: string;
  sessionID?: string;
  action?: string;
  resources?: string[];
  save?: string[];
  source?: {
    type?: string;
    messageID?: string;
    callID?: string;
  };
}

export interface CreateOpencodeOptions {
  hostname?: string;
  port?: number;
  /** 启动超时（毫秒），Windows 默认 90000，其它平台 45000 */
  timeout?: number;
  /** 为 true 时重启已在运行的 service（供应商变更后使用）；默认 false 以加快启动 */
  restartService?: boolean;
  config?: { cwd?: string };
  env?: NodeJS.ProcessEnv;
  /** 指定 CLI 可执行名或绝对路径；不填则自动检测 opencode / lildax */
  cli?: string;
  /** CLI 对应 npm 包名，用于错误提示 */
  cliPackage?: string;
  /** 子进程 stderr 输出的回调，扩展层可写入日志通道 */
  onStderr?: (text: string) => void;
  /** 流程诊断日志回调 */
  onLog?: (message: string) => void;
  /** OpenCode 工具权限确认（write/edit/bash 等需要 ask 时） */
  onPermission?: (request: PermissionRequest) => Promise<PermissionReply>;
}

export interface OpencodeServerInstance {
  server: {
    close(): Promise<void>;
  };
  client: OpencodeClient;
}

/**
 * 连接 OpenCode 2.0 后台 service，返回 client。
 *
 * 要求 `opencode` / `lildax` CLI 必须在 PATH 上（npm install -g @opencode-ai/cli）。
 */
export function createOpencode(
  options: CreateOpencodeOptions
): Promise<OpencodeServerInstance>;
