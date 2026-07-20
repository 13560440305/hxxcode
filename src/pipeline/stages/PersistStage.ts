import type { PipelineStage } from "../PipelineContext";

export const PersistStage: PipelineStage = {
  name: "Persist",
  async run(ctx) {
    if (ctx.persist) {
      await ctx.persist();
    }
  },
};
