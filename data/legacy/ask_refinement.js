import { runLegacyInit } from './registry.js';

export function initLegacyAskRefinement(ctx) {
  runLegacyInit('ask_refinement', ctx, () => {
    ctx.setupAskRequestRefinement();
  });
}
