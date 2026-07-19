# Incipit UI 路线图（P0 / P1 / P2）

> 基于 `theme.css`、`warm-white-override.css`、`enhance_legacy.js` 与线上问题（白边闪、Reject 消失、Plan 红点、旧会话 change-review 不挂载、全量扫描卡顿）的系统性规划。  
> 约束不变：**不改引擎**（模型请求、鉴权、tool schema、CLI 协议）；只改表面与宿主桥接。

---

## 0. 设计立场（先定边界）

| 层级 | 语言 | 用途 |
|------|------|------|
| **Transcript 正文** | 文学阅读（衬线可选 / 窄栏） | 助手散文、引用、标题 |
| **Agent 工作面** | IDE 面板（UI 无衬线 / 全宽卡） | 工具卡、change-review、权限、composer chrome |

**规则**：两套语言可以并存，但**同一组件不得混用**。工具卡不出现 Reading 衬线标题；正文不出现彩虹状态点。

主 token 入口：

- 色：`--app-*` + `--incipit-tool-*` + `--incipit-status-*`（见 P0）
- 字：`--incipit-type-caption|ui|body|title`
- 间距：`--incipit-space-1..4`
- 栏宽：`--incipit-conversation-column-width`（响应式，见 P1）

---

## P0 — 稳 & 不闪（1～2 周）

目标：流式不闪边、change-review 必现、工具状态语义正确、不再因全量扫描卡死。

### P0-1 流式无闪（边框 / 阴影 / transition）

| 项 | 内容 | 验收 |
|----|------|------|
| First-paint 边框 token | `:root` 锁定 `--app-input-border` / `--app-input-active-border` / `--app-transparent-inner-border` / `--app-transparent-border` | 暖黑 / 暖白各自一份 |
| JS 同步 | `APP_VAR_OVERRIDES` 与 CSS 同值，MutationObserver 防宿主写回 | reload 后 DevTools 中变量不为 `#ffffff1a` |
| 助手消息无 rim | `[data-incipit-message]` / markdown-root / contentWrapper 去 border/outline/box-shadow | 流式 30s 无白边闪 |
| 禁多余 transition | markdown-root `transition: none`；流式期间不动画背景 | 无「柔白一闪」 |

**状态**：已实现（2026-07-20）+ 文档化 token 表。

### P0-2 工具状态映射表

统一 `normalizeExplicitHostStatus` → `pending | success | error`：

| 宿主 / 语义 | 映射 |
|-------------|------|
| pending, running, in_progress, queued, started | `pending` |
| success, completed, ok, done, cancelled*, canceled* | `success` |
| error, failed, failure, rejected | `error` |
| Plan 工具 + 非 is_error 结果 | 强制 `success`（「Stayed in plan mode」） |

\* cancelled 为**刻意非错误**终态（ExitPlanMode 留下 plan 等）。

覆盖工具类型：Bash / Read / Write / Edit / Grep / Plan 族 / Ask / Skill / MCP default。

**状态**：cancelled→success、Plan 特例、Plan 图标与色已实现；本轮补「状态表」注释与 token 命名对齐。

### P0-3 Change-review 挂载与 finalize 契约

| 契约 | 行为 |
|------|------|
| Finalize 通知 | `assistantTurnFinalized` **始终** `notifyChangeReviewTurnFinalized()`，不因 busy 跳过 |
| 挂载 | 优先 action-row 后；否则 markdown 后 / host 末尾 |
| 重试 | `changeReviewHasMissingMounts` + 有限 mount-retry |
| 性能 | action-row 扫描**仅在缺挂载时**触发 re-paint |
| 测试 | 源码契约 +（本轮）可见性/挂载/finalize 断言加强 |

**状态**：逻辑已落地；本轮加强测试与文档。

### P0-4 设计语言注释与 token 入口

在 `theme.css` 顶部写死分层规则 + 导出 P0 token 清单，避免后续 PR 再混用。

---

## P1 — 一致（2～4 周）

### P1-1 字号 / 间距 四级 token

```
--incipit-type-caption: 11px
--incipit-type-ui:      12px
--incipit-type-body:    var(--incipit-body-size, 13px)
--incipit-type-title:   15px
--incipit-space-1: 4px
--incipit-space-2: 8px
--incipit-space-3: 12px
--incipit-space-4: 16px
--incipit-radius-sm: 4px
--incipit-radius-md: 8px
--incipit-radius-pill: 999px
```

新样式只用 token；旧硬编码逐步替换（本轮先定义 + 关键表面替换）。

### P1-2 栏宽响应式

```css
--incipit-conversation-column-width: min(720px, 100% - 24px);
```

窄侧栏（容器 < ~420px）时消息列仍 `width:100%`，避免 Reject/stats 被挤没。

### P1-3 关键 UI 中文

`CFG.language === 'zh'` 时：

- change-review：Reject turn / N files changed / Show more…
- 用户气泡：Edit / Rerun / Fork / Rewind / More / Disabled while streaming…

### P1-4 无障碍底线

- `@media (prefers-reduced-motion: reduce)`：关掉 status 脉冲与非必要 transition  
- 交互控件保留 `focus-visible` 2px accent ring（不全局 `outline: none`）  
- disabled 可用低对比；**非 disabled 装饰** opacity ≥ 0.5

### P1-5 设计语言收敛（文档 + 最小 CSS）

- 正文：`--incipit-ui-font`（agent 向，与当前 transcript 一致）  
- 工具卡：明确使用 `--incipit-tool-card-*`，不引入衬线  
- 禁止在 tool-summary 上使用 Reading/Emphasis

---

## P2 — 体验升级（按产品目标）

| 项 | 说明 |
|----|------|
| 会话级改动摘要条 | 输入框上方 `本会话 N files · +X −Y`，不依赖 per-turn 挂载 |
| 工具类型色深化 | 文件扩展名图标、MCP 色相轮 |
| Empty / Error / Offline | 首屏与失败态统一 |
| 视觉回归 CI | Playwright：流式 30s + Plan + review 截图 diff |
| 模块拆分 | `ui/tool-card`、`ui/change-review`、`ui/message` CSS+JS 同目录 |

P2 **不在本轮代码范围**，只进文档排期。

---

## 验收清单（每次 UI PR）

- [ ] 暖黑流式 30s 无白边闪  
- [ ] 新会话改文件 → 回合结束后出现 change-review  
- [ ] 旧会话 reload → 3s 内卡片重挂  
- [ ] Plan / ExitPlanMode 绿点 + 副标题缩进  
- [ ] `node tests/change-review.test.js` 与 `deferred-next` 通过  
- [ ] `incipit apply` 后 Reload Window 验证  

---

## 变更记录

| 日期 | 内容 |
|------|------|
| 2026-07-20 | 初版路线图；落地 P0 收尾 + P1 token/响应式/中文/reduced-motion |
