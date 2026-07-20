import type { ChatMessage } from "../models";
import type { EventBus } from "../events";
import { Pipeline, type VisionConfig } from "../pipeline";
import type { LildaxRuntime } from "../runtime";
import type { PipelineContext } from "../pipeline";

export type AgentSessionStatus =
  | "created"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "cancel_failed";

export type AgentSessionResult = {
  status: AgentSessionStatus;
  error?: string;
};

/**
 * 一次用户发送 = 一次完整执行（设计 §7）。
 */
export class AgentSession {
  readonly id: string;
  status: AgentSessionStatus = "created";
  private readonly abort = new AbortController();
  private runPromise: Promise<AgentSessionResult> | null = null;

  constructor(
    private readonly opts: {
      conversationId: string;
      backendSessionId: string;
      message: ChatMessage;
      eventBus: EventBus;
      runtime: LildaxRuntime;
      vision: VisionConfig | null;
      persist?: () => void | Promise<void>;
      pipeline?: Pipeline;
    }
  ) {
    this.id = crypto.randomUUID();
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  start(): Promise<AgentSessionResult> {
    if (this.runPromise) return this.runPromise;
    this.runPromise = this.execute();
    return this.runPromise;
  }

  abortLocal(): void {
    try {
      this.abort.abort();
    } catch {
      // ignore
    }
  }

  private async execute(): Promise<AgentSessionResult> {
    this.status = "running";
    const pipeline = this.opts.pipeline ?? new Pipeline();
    const ctx: PipelineContext = {
      conversationId: this.opts.conversationId,
      backendSessionId: this.opts.backendSessionId,
      sessionId: this.id,
      message: this.opts.message,
      prompt: "",
      visionTexts: [],
      fileContents: [],
      cancelToken: this.abort.signal,
      eventBus: this.opts.eventBus,
      runtime: this.opts.runtime,
      vision: this.opts.vision,
      persist: this.opts.persist,
    };

    try {
      await pipeline.run(ctx);
      if (this.abort.signal.aborted) {
        this.status = "cancelled";
        this.opts.eventBus.emit({
          type: "SessionCancelled",
          conversationId: this.opts.conversationId,
          sessionId: this.id,
        });
        return { status: "cancelled" };
      }
      this.status = "succeeded";
      this.opts.eventBus.emit({
        type: "SessionFinished",
        conversationId: this.opts.conversationId,
        sessionId: this.id,
      });
      return { status: "succeeded" };
    } catch (err) {
      const aborted =
        this.abort.signal.aborted ||
        (err instanceof Error &&
          (/aborted|cancel/i.test(err.message) || err.name === "AbortError"));

      if (aborted) {
        this.status = "cancelled";
        this.opts.eventBus.emit({
          type: "SessionCancelled",
          conversationId: this.opts.conversationId,
          sessionId: this.id,
        });
        return { status: "cancelled" };
      }

      const message = err instanceof Error ? err.message : String(err);
      this.status = "failed";
      this.opts.eventBus.emit({
        type: "SessionError",
        conversationId: this.opts.conversationId,
        sessionId: this.id,
        error: message,
      });
      return { status: "failed", error: message };
    }
  }
}
