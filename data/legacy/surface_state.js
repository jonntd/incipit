import { runLegacyInit } from './registry.js';

/**
 * Empty / offline / error banners for the transcript surface.
 * Fail-open: if DOM anchors are missing, no-op.
 */
export function initLegacySurfaceState(ctx) {
  runLegacyInit('surface_state', ctx, () => {
    if (typeof ctx.setupSurfaceStateBanners === 'function') {
      ctx.setupSurfaceStateBanners();
    }
  });
}
