import { runLegacyInit } from './registry.js';

export function initLegacyDiffIsland(ctx) {
  runLegacyInit('diff_island', ctx, () => {
    ctx.setupDiffSideBars();
  });
}
