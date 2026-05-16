import { runLegacyInit } from './registry.js';

export function initLegacyToolFold(ctx) {
  runLegacyInit('tool_fold', ctx, () => {
    ctx.setupToolFold();
  });
}
