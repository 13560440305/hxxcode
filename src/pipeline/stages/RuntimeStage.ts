import type { PipelineStage } from "../PipelineContext";

export const RuntimeStage: PipelineStage = {
  name: "Runtime",
  async run(ctx) {
    if (ctx.cancelToken.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    ctx.eventBus.emit({
      type: "RuntimeStarted",
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      message: "Working…",
    });

    await ctx.runtime.run({
      sessionId: ctx.backendSessionId,
      prompt: ctx.prompt,
      attachments: ctx.textAttachments,
      signal: ctx.cancelToken,
      onEvent: (stream) => {
        if (stream.type === "text" && stream.text) {
          ctx.eventBus.emit({
            type: "RuntimeToken",
            conversationId: ctx.conversationId,
            sessionId: ctx.sessionId,
            stream,
          });
        } else {
          ctx.eventBus.emit({
            type: "RuntimeToken",
            conversationId: ctx.conversationId,
            sessionId: ctx.sessionId,
            stream,
          });
        }
      },
    });

    if (ctx.cancelToken.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    ctx.eventBus.emit({
      type: "RuntimeFinished",
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
    });
  },
};
