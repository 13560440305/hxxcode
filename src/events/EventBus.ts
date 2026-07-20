import type { StreamEvent } from "../opencodeManager";

export type ConversationEventType =
  | "SendMessage"
  | "SessionCreated"
  | "VisionStarted"
  | "VisionFinished"
  | "PromptBuilt"
  | "RuntimeStarted"
  | "RuntimeToken"
  | "RuntimeFinished"
  | "SessionFinished"
  | "SessionError"
  | "SessionCancelled"
  | "SessionCancelFailed"
  | "Phase";

export type ConversationEvent = {
  type: ConversationEventType;
  conversationId: string;
  sessionId: string;
  message?: string;
  error?: string;
  /** Runtime 流式事件（text / tool_use / tool_result / error / finish） */
  stream?: StreamEvent;
  prompt?: string;
  visionText?: string;
};

type Listener = (event: ConversationEvent) => void;

/**
 * 业务事件总线。UI 不直连 Runtime，只订阅本总线或 Store。
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: ConversationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 监听器异常不影响 Pipeline
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
