import { newPartId, type MessagePart } from "../../models";
import type { PipelineStage } from "../PipelineContext";

export const NormalizeStage: PipelineStage = {
  name: "Normalize",
  async run(ctx) {
    if (!ctx.message.id) {
      ctx.message.id = newPartId();
    }
    ctx.message.parts = ctx.message.parts.map((p: MessagePart) => {
      const id = p.id || newPartId();
      if (p.type === "text") {
        return { ...p, id, text: (p.text ?? "").trimEnd() };
      }
      if (p.type === "image") {
        return {
          ...p,
          id,
          mime: p.mime || "image/png",
          name: p.name || "image.png",
        };
      }
      return {
        ...p,
        id,
        mime: p.mime || "text/plain",
        name: p.name || "file.txt",
      };
    });

    const hasContent = ctx.message.parts.some(
      (p) =>
        (p.type === "text" && p.text.trim()) ||
        p.type === "image" ||
        p.type === "file"
    );
    if (!hasContent) {
      throw new Error("消息内容为空");
    }
  },
};
