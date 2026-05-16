import { runLegacyInit } from './registry.js';

export function initLegacyForkRewind(ctx) {
  runLegacyInit('fork_rewind', ctx, () => {
    if (ctx && typeof ctx.assertForkRewindReady === 'function') {
      ctx.assertForkRewindReady();
    }
  });
}
