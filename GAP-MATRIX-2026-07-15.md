# ChatCut 源码对标缺口矩阵（更新版）

> **日期**：2026-07-15  
> **基线报告**：`../chatcut-reverse/reports/live-editor-audit-2026-07-14/`（当时加权约 **42.8%**，clone HEAD 较旧）  
> **本次方法**：读透 audit 结论 + **当前** `chatcut-clone` 工作树符号/工具扫描 + `resources/bundles` 索引（快捷键 54 / Zero serverName 169 / locale 线索）  
> **不是**：端到端 UI 验收；**不是**声称 743 个 bundle 控件逐个点过。

---

## 0. 一句话

| 维度 | 2026-07-14 audit | 2026-07-15 当前 clone |
|------|------------------|----------------------|
| MCP 52 工具**同名** | 大量缺失 | **0 缺**（含 read_project / from_code / import_media） |
| 编辑器「能剪」核心 | 已较强 | **更强**（库/FX/导出/工程/字体门/…） |
| 契约债 captions/transcript | 已标黄 | **仍在**（[C]） |
| Bundles 快捷键 54 | 已抽表 | **大多未接线**（最大前端债） |
| 云端/协作/计费 | 0% | 仍 **OOS / 不装真后端** |

**判断**：缺口主战场已从「工具有没有」转为：

1. **[C] 契约对齐**（edit_captions / manage_transcript / edit_item 深度）  
2. **Bundles 编辑器交互**（快捷键总线、nudge/shuttle/I-O、relink…）  
3. **产品壳**（协作/积分/多端）— 单机克隆刻意不做  

---

## 1. 证据索引（已盘，仍非「人肉读完 6MB editor」）

| 源 | 路径 | 可复用结论 |
|----|------|------------|
| Live audit README | `chatcut-reverse/reports/live-editor-audit-2026-07-14/README.md` | 方法、域汇总、743 控件说明 |
| 功能矩阵（旧） | 同目录 `feature-gap-matrix.md` | 132 项历史状态（**过时，仅对照**） |
| 快捷键 | `live-shortcuts.md` / `live-shortcuts.json` | **54 actions + 默认绑定** |
| 控件证据 | `live-controls.json` / `live-controls-by-bundle.md` | 标签×bundle，非同时渲染 |
| Locale | `ui-strings.en.json` | 产品文案线索 |
| Bundles 本体 | `chatcut-reverse/resources/bundles/` | 76 JS + beauty + decompiled 922 模块 |
| MCP 权威 | `chatcut-reverse/harness/mcp-tools-schema.json` | 52 工具 schema |
| 契约 TODO | `TODO-SOURCE-CODE-PARITY.md` | [C]/[G] 分工 |

**局限（必须写清）**：

- `decompiled/editor` 模块数很少；主逻辑在 monobundle / beautified 大文件 → 需**主题脚本**抽，不能一次读完。  
- locale 命中 ≠ 功能已接；云端串只证明 UI 存在。  
- 本次重评基于**代码存在性**，非浏览器点点测。

---

## 2. 域级覆盖（当前粗评，相对 7/14 矩阵）

| 域 | 7/14 加权 | 2026-07-15 观感 | 主要变化 |
|----|----------|-----------------|----------|
| 1 项目/会话 | 50% | **~90%+** | 版本历史、project 工具、read_project、followup |
| 2 时间线核心 | 79% | **~85%** | placeMode 插入/覆盖；edit_track/gif/solid 仍浅 |
| 3 音频 | 33% | **~70%** | isolate + 录音 + loudness；**ducking 仍无** |
| 4 转写 | 65% | **~75%** | gap/rename 有；**源 action 契约未齐** |
| 5 字幕 | 75% | **~80%** | 21 样式 + word override；**edit_captions 非 21-action** |
| 6 MG | 44% | **~85%** | convert/prores/from_code/manage_template |
| 7 设计风格 | 0% | **~70%** | manage_design_style 已有；brand kit 深度一般 |
| 8 AI 生成 | 43% | **~80%** | 生成工具套齐 + track_progress |
| 9 素材 | 46% | **~85%** | 库全类/LUT/stock/Firecrawl/字体；**手机传/relink 无** |
| 10 导出 | 42% | **~85%** | audio/xml/异步/字体门/fps·resolution |
| 11 Agent | 55% | **~75%** | chat 持久化、@、friction；**设置面板/thinking UI 浅** |
| 12 Skills | 0% | **~60%** | 创作模式 + manage_skill；skill_guard 无 |
| 13 协作 | 0% | **OOS** | — |
| 14 计费 | 0% | **OOS**（本地隐藏假积分） | — |
| 15 多端/MCP | 0% | **~20%** | import session 本地；无外置 MCP server 包 |
| **快捷键/NLE 导航** | 未单列 | **~25%** | **最大前端债** |

粗计（本文件 §3 抽检表 116 项）：**done 84 · partial 12 · missing 15 · oos 5**。  
不可直接等同 7/14 的 132 项加权公式，但方向明确：**工具/库/导出已翻盘；交互与契约仍欠**。

---

## 3. 缺口优先级（2026-07-15）

### P0 — 契约（建议 Claude 继续）

| 项 | 源证据 | clone | 说明 |
|----|--------|-------|------|
| `edit_captions` 21-action | MCP enum 完整 | 扁平参数 + 旁路 tools | **最大契约债** |
| `manage_transcript` translation_*/retry | MCP action 枚举 | fix/renameSpeaker/translate | 变体/重试未对齐 |
| `edit_item` 全类型深度 | MCP + ripple | 有 adds/updates/deletes + ripple | 仍非源站全语义 |

### P1 — Bundles 编辑器交互（纯前端，不挡 Claude）

| 项 | 源证据 | clone | 建议 |
|----|--------|-------|------|
| **快捷键总线 54 actions** | `live-shortcuts.md` + `shortcut-dispatcher` | 仅部分硬编码 | 建 `src/shortcuts/` 注册表 + 对话框 |
| nudge / seek ±1·±1s | 同上 | 无 | 高 ROI |
| **JKL shuttle** | J/K/L 绑定 | 无 | 高 ROI |
| **I/O zone** | I/O/X/`/` | 无 | 高 ROI |
| select-all / select-after | Mod+A / Y | 无 | 中 |
| paste-effects 全局键 | Mod+Alt+V | 右键有 | 中 |
| keyboard-shortcuts 对话框 + 预设 | Mod+Alt+K + Zero 表 | 无 | 中 |
| save-version 绑定 | Mod+S | 有 UI 无绑定 | 低 |

### P2 — 媒体/音频产品深度

| 项 | 源证据 | clone |
|----|--------|-------|
| Relink missing media | locale「Click to relink」 | 无 |
| Download proxy | locale | 无 |
| 手机上传 / QR | audit §4.3 | 无 |
| Audio ducking | Zero/locale Anchor duck | 无 |
| Audio cross-fade 转场 | locale `trAudioCrossFade` | 无（假 tab 已藏） |
| Multicam sync | locale | 无 |
| gif/svg/solid 类型完整 | Zero `gif_item`/`svg`/`solid` | 部分 |
| Agent settings 面板 | Speed/Thinking/MG quality | 无 |
| skill_guard | 源技能门 | 无 |
| Thinking block UI | audit | 半（中转/真 Claude） |

### P3 / OOS — 单机克隆不装

| 项 | 原因 |
|----|------|
| 实时协作 / invite / invite | 需 Zero 后端 |
| 分享链接 / 成员角色 / 计费 Stripe | 需账号体系 |
| 云导出队列 / 云代理下载 | 需对象存储与 job 服务 |
| 真积分扣费 | 需服务端 |

---

## 4. MCP 52 工具（当前）

**同名缺失：0**

近期补齐：`read_project`、`create_motion_graphic_from_code`、`import_media`、以及既有 Firecrawl/工程/字体/upload 等。

**有名但契约缩水（仍债）**：

- `edit_captions`、`manage_transcript`  
- 部分 `edit_track` / `edit_item` 边界 case  
- 生成类依赖真实 API key（工具在，链路属配置）

**clone 多于源的扩展**（不算债）：`web_search/map/crawl/batch`、`edit_gap`、`find_highlights`、`normalize_loudness` 等。

---

## 5. 快捷键对照（摘要）

完整表见：`chatcut-reverse/reports/live-editor-audit-2026-07-14/live-shortcuts.md`（54 行）。

| 源 action | 默认键 | clone |
|-----------|--------|-------|
| interaction-mode-selection | V | ✅ |
| interaction-mode-trim | N | ✅ |
| interaction-mode-blade | B | ✅ |
| split | C / Enter | ✅ 部分 |
| snapping | S | ✅ |
| play-pause | Space | ✅ 部分 |
| undo/redo | Mod+Z … | ✅ |
| delete / ripple delete | ⌫ / ⇧⌫ | ✅ 部分 |
| marker-add / prev/next | M / [ ] | ✅ 部分 |
| zoom-fit / zoom in-out | ⇧Z / ⌘± | ✅ 部分 |
| paste-effects | Mod+Alt+V | 🟡 仅菜单 |
| nudge-left/right | E/R 等 | ❌ |
| seek / seek-sec | ←→ ⇧←→ | ❌ |
| shuttle J/K/L | J K L | ❌ |
| zone-in/out/clear/clip | I O X / | ❌ |
| select-all / select-after | ⌘A / Y | ❌ |
| keyboard-shortcuts | ⌘⌥K | ❌ |
| save-version | ⌘S | ❌ |
| ask-ai | Tab | ❌ |
| fullscreen | \` | 🟡 时间线有全屏 |

---

## 6. 与 7/14 audit 结论的对齐 / 纠偏

| 7/14 说法 | 2026-07-15 |
|-----------|------------|
| 版本历史 ❌ | ✅ VersionHistory + versionStore |
| ask_followup ❌ | ✅ 工具 + runtime |
| get_editor_url / target ❌ | ✅ project-tools |
| Ripple 插入/覆盖 ❌ | ✅ placeMode + edit_item.ripple |
| isolate / 录音 ❌ | ✅ |
| design style 0% | ✅ manage_design_style |
| skills 0% | 🟡 创作模式 + manage_skill |
| 媒体池深度不足 | 🟡 文件夹/收藏有；手机传/relink 仍无 |
| Library 只有 MG | ✅ 转场/FX/LUT/Zoom/SFX 库 UI |
| 导出 audio/XML/异步 ❌ | ✅ 基本齐 |
| 加权 42.8% | **工具面已显著上升**；快捷键/协作仍拉低产品完整度 |

---

## 7. 建议执行顺序（不挡 Claude）

1. **快捷键注册表**（只动 `shortcuts/*` + Timeline/Editor 监听，少碰 agent 工具）  
2. nudge / seek / I-O / JKL  
3. 快捷键对话框（只读预设即可 v1）  
4. relink missing media（本地）  
5. ducking（可选）  
6. Claude 并行 captions/transcript 契约  

共享文件约定：`tools.ts` 只 append；大改 `Timeline.tsx` 时与 Claude 错开。

---

## 8. 如何「真·索引全」以后再更新

```text
1. 以 reports/live-editor-audit-2026-07-14 脚本为模板
2. 对 bundles/live-2026-07-14 或最新 app.chatcut.io 再抽 controls/shortcuts/locale
3. 对 chatcut-clone 跑符号/工具扫描（本文件 §3 脚本可固化）
4. 输出 diff → 改本 GAP 矩阵版本号
```

**禁止**把 FEATURE-COVERAGE.md / 旧 42.8% 当真理；**禁止**把 locale 命中直接当 ✅。

---

*维护：完成一批交互债后更新 §3 状态；契约项以 TODO-SOURCE-CODE-PARITY.md 为准。*
