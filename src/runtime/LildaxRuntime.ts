import type {
  OpencodeManager,
  PromptAttachments,
  StreamEvent,
} from "../opencodeManager";

/**
 * lildax 仅作 Runtime Worker：受理 prompt、流式进度、完成判定、取消确认。
 * 不做 Prompt 拼接。
 */
export class LildaxRuntime {
  constructor(private readonly manager: OpencodeManager) {}

  async run(opts: {
    sessionId: string;
    prompt: string;
    attachments?: PromptAttachments;
    signal?: AbortSignal;
    onEvent: (event: StreamEvent) => void;
    completionPollIntervalMs?: number;
    completionTimeoutMs?: number;
  }): Promise<void> {
    await this.manager.runAgentTurn({
      sessionId: opts.sessionId,
      text: opts.prompt,
      attachments: opts.attachments,
      signal: opts.signal,
      onEvent: opts.onEvent,
      completionPollIntervalMs: opts.completionPollIntervalMs ?? 1_000,
      completionTimeoutMs: opts.completionTimeoutMs ?? 600_000,
      waitTimeoutMs: opts.completionTimeoutMs ?? 600_000,
    });
  }

  async confirmIdle(
    sessionId: string,
    signal?: AbortSignal,
    timeoutMs = 20_000
  ): Promise<boolean> {
    return this.manager.confirmSessionIdle(sessionId, signal, timeoutMs);
  }
}
