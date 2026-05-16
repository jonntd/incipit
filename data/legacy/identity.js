import { runLegacyInit } from './registry.js';

export function initLegacyIdentity(ctx) {
  runLegacyInit('identity', ctx, () => {
    if (ctx && typeof ctx.preloadEffortBrainIcons === 'function') {
      ctx.preloadEffortBrainIcons();
    }
  });
}
