# Incipit UI 路线图（P0 / P1 / P2）

> 基于 `theme.css`、`warm-white-override.css`、`enhance_legacy.js` 与线上问题（白边闪、Reject 消失、Plan 红点、旧会话 change-review 不挂载、全量扫描卡顿）的系统性规划。  
> 约束不变：**不改引擎**（模型请求、鉴权、tool schema、CLI 协议）；只改表面与宿主桥接。

---

## 0. 设计立场（先定边界）

| 层级 | 语言 | 参照 | 用途 |
|------|------|------|------|
| **Transcript 正文** | 文学阅读（衬线可选 / 窄栏） | 霞鹜文楷 + Plex Serif | 助手散文、引用、标题 |
| **Agent 工作面** | IDE 面板（UI 无衬线 / 全宽卡） | **Trae**（语义色）+ **Augment**（密度与 Edits 面板） | 工具卡、change-review、Session Edits、权限、composer chrome |

### Trae × Augment 分工（Agent 工作面）

| 来源 | 取什么 | 落到哪里 |
|------|--------|----------|
| **Trae** | 按语义着色：success/warn/error、工具 kind 图标色、codicon 语义、interactive accent | `--incipit-tool-icon-*`、`dotSuccess/Warning/Failure`、file-ref 图标 |
| **Augment** | IDE 列表密度：UI sans、mono 路径、hover 文件行 Open/Undo、`+N/−M` soft chip、Edits 浮动面板 | `ui/change-review.css` Session Edits、transcript action 行、dropdown |

**规则**：

1. 两套语言可以并存，但**同一组件不得混用**。工具卡 / Edits / 权限不出现 Reading 衬线标题；正文不出现彩虹状态点。
2. Agent chrome **一律** `--incipit-ui-font` / `--incipit-ui-mono`（跟随 VS Code），禁止 `Reading` / `Emphasis`。
3. 状态色走 Trae 语义（绿/琥珀/红/slate），interactive 走 `--incipit-icon-accent`（紫罗兰）。
4. Session Edits 行交互对齐 Augment：整行开 native diff；hover/focus 露出 Open + Undo；Keep 为唯一主 CTA。

主 token 入口：

- 色：`--app-*` + `--incipit-tool-*` + `--incipit-status-*`（见 P0）
- 字：`--incipit-type-caption|ui|body|title`
- 间距：`--incipit-space-1..4`
- 栏宽：`--incipit-conversation-column-width`（响应式，见 P1）

模块 CSS（`data/ui/`，`theme.css` 顶部 `@import`）：

| 文件 | 职责 |
|------|------|
| `ui/message.css` | 助手正文无 rim |
| `ui/tool-card.css` | 扩展名色 / MCP 色 / 禁衬线 |
| `ui/change-review.css` | 回合 review 状态色 |
| `ui/empty-state.css` | empty / offline / error 横幅 |

---

## P0 — 稳 & 不闪 ✅

目标：流式不闪边、change-review 必现、工具状态语义正确、不再因全量扫描卡死。

### P0-1 流式无闪（边框 / 阴影 / transition） ✅

| 项 | 内容 | 验收 |
|----|------|------|
| First-paint 边框 token | `:root` 锁定 `--app-input-border` / `--app-input-active-border` / `--app-transparent-inner-border` / `--app-transparent-border` | 暖黑 / 暖白各自一份 |
| JS 同步 | `APP_VAR_OVERRIDES` 与 CSS 同值，MutationObserver 防宿主写回 | reload 后 DevTools 中变量不为 `#ffffff1a` |
| 助手消息无 rim | `[data-incipit-message]` / markdown-root / contentWrapper 去 border/outline/box-shadow | 流式 30s 无白边闪 |
| 禁多余 transition | markdown-root `transition: none`；流式期间不动画背景 | 无「柔白一闪」 |

### P0-2 工具状态映射表 ✅

统一 `normalizeExplicitHostStatus` → `pending | success | error`：

| 宿主 / 语义 | 映射 |
|-------------|------|
| pending, running, in_progress, queued, started | `pending` |
| success, completed, ok, done, cancelled*, canceled* | `success` |
| error, failed, failure, rejected | `error` |
| Plan 工具 + 非 is_error 结果 | 强制 `success`（「Stayed in plan mode」） |

\* cancelled 为**刻意非错误**终态（ExitPlanMode 留下 plan 等）。

覆盖：Bash / Read / Write / Edit / Grep / Plan 族 / Ask / Skill / MCP default。

### P0-3 Change-review 挂载与 finalize 契约 ✅

| 契约 | 行为 |
|------|------|
| Finalize 通知 | `assistantTurnFinalized` **始终** `notifyChangeReviewTurnFinalized()`，不因 busy 跳过 |
| 挂载 | 优先 action-row 后；否则 markdown 后 / host 末尾 |
| 重试 | `changeReviewHasMissingMounts` + 有限 mount-retry |
| 性能 | action-row 扫描**仅在缺挂载时**触发 re-paint |
| 测试 | `tests/change-review.test.js` + `tests/deferred-next.test.js` + `tests/ui-roadmap.test.js` |

### P0-4 设计语言注释与 token 入口 ✅

`theme.css` 顶部 design languages 注释 + `@import ui/*`；token 清单见 `:root`。

---

## P1 — 一致 ✅

### P1-1 字号 / 间距 四级 token ✅

```
--incipit-type-caption: 11px
--incipit-type-ui:      12px
--incipit-type-body:    var(--incipit-body-size, 13px)
--incipit-type-title:   15px
--incipit-space-1..4
--incipit-radius-sm|md|pill
```

### P1-2 栏宽响应式 ✅

```css
--incipit-conversation-column-width: min(720px, 100% - 24px);
```

### P1-3 关键 UI 中文 ✅

`CFG.language === 'zh'`：change-review 与用户气泡 Edit / Rerun / Fork / Rewind / More / Copy。

### P1-4 无障碍底线 ✅

- `prefers-reduced-motion: reduce`
- 关键控件 `focus-visible` accent ring

### P1-5 设计语言收敛 ✅

工具 summary 强制 `--incipit-ui-font`（`ui/tool-card.css`）。

---

## P2 — 体验升级 ✅（骨架 + 可工作表面）

| 项 | 状态 | 说明 |
|----|------|------|
| 会话级改动摘要条 | ❌ 已撤回 | 用户反馈为噪音；已移除代码与 CSS（回合级 change-review 卡保留） |
| 工具类型色深化 | ✅ | 路径 `data-incipit-file-ext` + MCP `__` / `mcp*` 色相（`ui/tool-card.css`） |
| Empty / Error / Offline / Auth | ✅ | `data-incipit-surface-state` 横幅（`setupSurfaceStateBanners`） |
| 中途鉴权不弹登录墙 | ✅ | `setupAuthLoginGuard`：仅拦截 `authentication_failed → showLogin`；冷启动与 `/login` 仍可用 |
| 视觉回归 CI | ✅ 骨架 | `tests/visual/smoke.cjs`（无 host 时 SKIP）；契约在 `ui-roadmap.test.js` |
| 模块拆分 | ✅ | `data/ui/*.css` + `legacy/surface_state.js` |

Playwright 实机截图需 `INCIPIT_VISUAL_URL` + 可选 `playwright` peer，不阻塞 `npm test`。

---

## 验收清单（每次 UI PR）

- [x] 暖黑流式边框 token 首屏锁定（白边防护）  
- [x] change-review finalize 始终通知 + 挂载 fallback + 缺挂载才重渲  
- [x] Plan / ExitPlanMode 状态映射 + 图标  
- [x] `node tests/change-review.test.js` / `deferred-next` / `ui-roadmap` / `auth-login-guard` 通过  
- [x] `incipit apply` 同步 `ui/` 资源树  
- [ ] 人工：Reload Window 后流式 30s + 新会话改文件 + 旧会话 rehydrate  
- [ ] 人工：中途 `authentication_failed` 不跳出登录墙，仅见 auth 横幅；`/login` 仍可打开  

---

## 测试入口

```bash
npm test                    # includes tests/ui-roadmap.test.js + auth-login-guard
npm run test:ui-roadmap
npm run test:auth-login-guard
npm run test:visual         # optional; skips without INCIPIT_VISUAL_URL
```

---

## 变更记录

| 日期 | 内容 |
|------|------|
| 2026-07-20 | 初版路线图；落地 P0 收尾 + P1 token/响应式/中文/reduced-motion |
| 2026-07-20 | 边框 first-paint + status token + 栏宽 + 中英文表 + deferred-next 契约 |
| 2026-07-20 | **P2 全量落地**：`data/ui/*` 模块、会话摘要条、empty/offline 横幅、扩展名/MCP 色、`tests/visual` 骨架、`tests/ui-roadmap.test.js`、`LOCAL_ASSET_TREES` 含 `ui` |
| 2026-07-20 | change-review 改用 type/radius token；README 链到路线图；暖白适配 surface-state |
| 2026-07-20 | **撤回**「本会话改动」composer 摘要条（用户反馈噪音）；保留回合级 change-review 卡 |
