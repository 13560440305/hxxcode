import * as fsp from "fs/promises";
import { fileParts } from "../../models";
import type { PipelineStage } from "../PipelineContext";

export const FileStage: PipelineStage = {
  name: "File",
  async run(ctx) {
    const files = fileParts(ctx.message.parts);
    const contents: string[] = [];
    const texts: Array<{ name: string; content: string }> = [];

    for (const f of files) {
      let content = f.textContent ?? "";
      if (!content && f.path) {
        content = await fsp.readFile(f.path, "utf-8");
      }
      if (!content) continue;
      contents.push(content);
      texts.push({ name: f.name || "file.txt", content });
    }

    ctx.fileContents = contents;
    if (texts.length) {
      ctx.textAttachments = { texts };
    }
  },
};
