import type { PipelineContext, PipelineStage } from "./PipelineContext";
import {
  NormalizeStage,
  VisionStage,
  FileStage,
  PromptBuildStage,
  RuntimeStage,
  PersistStage,
} from "./stages";

const DEFAULT_STAGES: PipelineStage[] = [
  NormalizeStage,
  VisionStage,
  FileStage,
  PromptBuildStage,
  RuntimeStage,
  PersistStage,
];

/**
 * 同一 AgentSession Job 内顺序执行 Stages（不是 FIFO 任务队列）。
 */
export class Pipeline {
  constructor(private readonly stages: PipelineStage[] = DEFAULT_STAGES) {}

  async run(ctx: PipelineContext): Promise<void> {
    for (const stage of this.stages) {
      if (ctx.cancelToken.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      await stage.run(ctx);
    }
  }
}
