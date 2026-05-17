import { runLegacyInit } from './registry.js';

export function initLegacyDeferredNext(ctx) {
  runLegacyInit('deferred_next', ctx, () => {
    ctx.setupDeferredNextMessageQueue();
  });
}
