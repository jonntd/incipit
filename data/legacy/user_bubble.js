import { runLegacyInit } from './registry.js';

export function initLegacyUserBubble(ctx) {
  runLegacyInit('user_bubble', ctx, () => {
    ctx.setupUserBubbleNativeActionSuppression();
  });
}
