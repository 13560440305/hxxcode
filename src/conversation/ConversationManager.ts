import type { ChatMessage } from "../models";
import { EventBus } from "../events";
import { ConversationStore } from "./ConversationStore";
import { AgentSession, type AgentSessionResult } from "./AgentSession";
import { LildaxRuntime } from "../runtime";
import type { OpencodeManager } from "../opencodeManager";
import type { VisionConfig } from "../pipeline";

export type SendOptions = {
  conversationId: string;
  backendSessionId: string;
  message: ChatMessage;
  vision: VisionConfig | null;
  persist?: () => void | Promise<void>;
};

type RunningEntry = {
  session: AgentSession;
  backendSessionId: string;
};

/**
 * 创建 AgentSession、调度 Pipeline；同会话单飞（非 FIFO 任务队列）。
 */
export class ConversationManager {
  readonly eventBus = new EventBus();
  readonly store = new ConversationStore();
  private readonly runtime: LildaxRuntime;
  private readonly running = new Map<string, RunningEntry>();

  constructor(opencode: OpencodeManager) {
    this.runtime = new LildaxRuntime(opencode);
  }

  isBusy(conversationId: string): boolean {
    const entry = this.running.get(conversationId);
    return !!entry && entry.session.status === "running";
  }

  async send(opts: SendOptions): Promise<AgentSessionResult> {
    const key = opts.conversationId;
    if (this.isBusy(key)) {
      const error = "当前会话仍在执行中，请等待完成或先取消后再发送";
      this.eventBus.emit({
        type: "SessionError",
        conversationId: key,
        sessionId: this.running.get(key)?.session.id ?? "",
        error,
      });
      return { status: "failed", error };
    }

    const session = new AgentSession({
      conversationId: opts.conversationId,
      backendSessionId: opts.backendSessionId,
      message: opts.message,
      eventBus: this.eventBus,
      runtime: this.runtime,
      vision: opts.vision,
      persist: opts.persist,
    });

    this.running.set(key, {
      session,
      backendSessionId: opts.backendSessionId,
    });
    this.store.beginTurn(opts.conversationId, session.id);
    this.eventBus.emit({
      type: "SendMessage",
      conversationId: opts.conversationId,
      sessionId: session.id,
    });
    this.eventBus.emit({
      type: "SessionCreated",
      conversationId: opts.conversationId,
      sessionId: session.id,
    });

    try {
      return await session.start();
    } finally {
      const cur = this.running.get(key);
      if (cur?.session === session) {
        this.running.delete(key);
      }
      this.store.endTurn();
    }
  }

  /**
   * 本地 abort + 远端 idle 确认。
   */
  async cancel(
    conversationId: string,
    timeoutMs = 20_000
  ): Promise<"cancelled" | "cancel_failed"> {
    const entry = this.running.get(conversationId);
    if (!entry) {
      return "cancelled";
    }

    entry.session.abortLocal();

    const confirmAbort = new AbortController();
    const timer = setTimeout(() => confirmAbort.abort(), timeoutMs);
    try {
      const idle = await this.runtime.confirmIdle(
        entry.backendSessionId,
        confirmAbort.signal,
        timeoutMs
      );
      if (!idle) {
        entry.session.status = "cancel_failed";
        this.eventBus.emit({
          type: "SessionCancelFailed",
          conversationId,
          sessionId: entry.session.id,
          error:
            "取消未能确认远端已停止。请重新发送请求（或重启 HxxCode Server / 新建会话）。",
        });
        return "cancel_failed";
      }
      entry.session.status = "cancelled";
      this.eventBus.emit({
        type: "SessionCancelled",
        conversationId,
        sessionId: entry.session.id,
      });
      return "cancelled";
    } catch {
      entry.session.status = "cancel_failed";
      this.eventBus.emit({
        type: "SessionCancelFailed",
        conversationId,
        sessionId: entry.session.id,
        error:
          "取消未能确认远端已停止。请重新发送请求（或重启 HxxCode Server / 新建会话）。",
      });
      return "cancel_failed";
    } finally {
      clearTimeout(timer);
    }
  }

  dispose(): void {
    for (const { session } of this.running.values()) {
      session.abortLocal();
    }
    this.running.clear();
    this.eventBus.dispose();
  }
}
