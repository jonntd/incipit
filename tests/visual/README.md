# Visual regression scaffolding (P2)

Playwright-based visual smoke for the patched Claude Code webview.

## Scope (roadmap)

| Scenario | Assertion |
|----------|-----------|
| Streaming prose 30s | no white rim flash on assistant frames |
| Plan / ExitPlanMode card | green status dot + indented caption |
| Change-review card | `N files changed` + Reject visible |
| Session summary strip | composer rail shows session totals when payload non-empty |

## Status

Scaffold only — full browser harness needs a running Antigravity/VS Code host with the patched extension. Until then, **source contracts** in `tests/deferred-next.test.js` and `tests/ui-roadmap.test.js` guard the UI tokens and mount paths.

## Local (when ready)

```bash
# optional peer deps
npx playwright install chromium

# placeholder entry — fails open with skip if no host
node tests/visual/smoke.cjs
```

Do not block `npm test` on live screenshots until the host fixture is stable.
