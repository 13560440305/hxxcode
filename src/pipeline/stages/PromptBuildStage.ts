import { textFromParts } from "../../models";
import type { PipelineStage } from "../PipelineContext";

/**
 * 统一构造 Prompt，Runtime 不再做拼接。
 */
export const PromptBuildStage: PipelineStage = {
  name: "PromptBuild",
  async run(ctx) {
    const userText = textFromParts(ctx.message.parts);
    const visionBlock = ctx.visionTexts.filter(Boolean).join("\n\n").trim();
    const fileBlock = ctx.fileContents
      .map((c, i) => {
        const name = ctx.textAttachments?.texts?.[i]?.name ?? `附件${i + 1}`;
        return `【${name}】\n${c}`;
      })
      .join("\n\n")
      .trim();

    const sections: string[] = [];
    if (visionBlock) {
      sections.push(`图片内容：\n${visionBlock}`);
    }
    if (fileBlock) {
      sections.push(`附件内容：\n${fileBlock}`);
    }
    if (userText) {
      sections.push(`用户要求：\n${userText}`);
    }

    if (!sections.length) {
      throw new Error("无法构造 Prompt：无有效内容");
    }

    // 纯文本：不包一层「用户要求」，保持与旧行为一致
    ctx.prompt =
      !visionBlock && !fileBlock ? userText : sections.join("\n\n");
    // 文本附件已并入 prompt，避免 Runtime 再夹带重复
    if (fileBlock) {
      ctx.textAttachments = undefined;
    }

    ctx.eventBus.emit({
      type: "PromptBuilt",
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      prompt: ctx.prompt,
    });
  },
};
