import { runLegacyInit } from './registry.js';

export function initLegacyTranscriptActions(ctx) {
  runLegacyInit('transcript_actions', ctx, () => {
    ctx.exposeLegacyHooks();
    ctx.setupBusyStateObserver();
    ctx.setupFileDragReferenceHint();
  });
}

export function initLegacyTranscriptActionDebug(ctx) {
  runLegacyInit('transcript_actions.debug', ctx, () => {
    ctx.setupTranscriptActionDebugTools();
  });
}
