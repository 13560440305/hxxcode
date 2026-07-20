import type { ChatMessage } from "../models";
import type { EventBus } from "../events";
import type { LildaxRuntime } from "../runtime/LildaxRuntime";
import type { PromptAttachments } from "../opencodeManager";

export type VisionConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
};

export type PipelineContext = {
  conversationId: string;
  /** 后端 lildax session id（通常与 conversationId 对齐） */
  backendSessionId: string;
  /** 本轮 AgentSession id */
  sessionId: string;
  message: ChatMessage;
  prompt: string;
  visionTexts: string[];
  fileContents: string[];
  /** 文本附件交给 Runtime（非图片） */
  textAttachments?: PromptAttachments;
  cancelToken: AbortSignal;
  eventBus: EventBus;
  runtime: LildaxRuntime;
  vision: VisionConfig | null;
  /** PersistStage 回调（由 ChatViewProvider 注入落盘） */
  persist?: () => void | Promise<void>;
};

export type PipelineStage = {
  name: string;
  run(ctx: PipelineContext): Promise<void>;
};
