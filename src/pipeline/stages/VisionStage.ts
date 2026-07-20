import * as fsp from "fs/promises";
import { imageParts, textFromParts } from "../../models";
import { recognizeImagesToText, type VisionImageInput } from "../../visionRecognize";
import type { PipelineStage } from "../PipelineContext";

export const VisionStage: PipelineStage = {
  name: "Vision",
  async run(ctx) {
    const images = imageParts(ctx.message.parts);
    if (!images.length) {
      ctx.visionTexts = [];
      return;
    }
    if (!ctx.vision) {
      throw new Error(
        "尚未配置识图模型。请在设置中为供应商添加「识图模型」，或在聊天框下拉选择。"
      );
    }

    ctx.eventBus.emit({
      type: "VisionStarted",
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      message: "Looking at image…",
    });
    ctx.eventBus.emit({
      type: "Phase",
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      message: "Looking at image…",
    });

    if (ctx.cancelToken.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    const visionImages: VisionImageInput[] = [];
    for (const img of images) {
      let dataUrl = img.dataUrl;
      if (!dataUrl && img.path) {
        const buf = await fsp.readFile(img.path);
        const mime = img.mime || "image/png";
        dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      }
      if (dataUrl) {
        visionImages.push({
          mime: img.mime || "image/png",
          dataUrl,
          name: img.name,
        });
      }
    }
    if (!visionImages.length) {
      throw new Error("图片附件无法读取，请重新粘贴或上传");
    }

    const userHint = textFromParts(ctx.message.parts);
    // 多图并行识图（设计建议 Promise.all）；单次 API 也支持多图，优先一次请求
    const text = await recognizeImagesToText({
      baseURL: ctx.vision.baseURL,
      apiKey: ctx.vision.apiKey,
      model: ctx.vision.model,
      images: visionImages,
      userHint,
      signal: ctx.cancelToken,
    });

    if (ctx.cancelToken.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    ctx.visionTexts = [text];
    ctx.eventBus.emit({
      type: "VisionFinished",
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      visionText: text,
      message: "Working…",
    });
    ctx.eventBus.emit({
      type: "Phase",
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      message: "Working…",
    });
  },
};
