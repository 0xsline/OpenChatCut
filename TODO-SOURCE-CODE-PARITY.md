# ChatCut 源码对标 TODO（真代码审计版）

> **生成日期**：2026-07-15  
> **依据（只认这些，不认旧 coverage 文档）**：  
> 1. 源站 MCP 权威 schema：`../chatcut-reverse/harness/mcp-tools-schema.json`（52 工具）  
> 2. 源站库目录：`../chatcut-reverse/harness/library-catalog/*.json`  
> 3. 源站着色器：`../chatcut-reverse/harness/shaders/glsl/`  
> 4. 本仓实现：`src/**`  
>
> **图例**：❌ 未做 · 🟡 半对齐/契约缩水 · ✅ 源条目已齐（可跳过）  
> **每条格式**：缺口是什么 → 源站在哪 → 本仓 UI/代码在哪 → 怎么改

---

## 0. 总览

| 桶 | 数量 | 说明 |
|----|-----:|------|
| 源站 MCP 52 工具 | 52 | 外部 MCP `tools/list` 导出 |
| 本仓有等价接线 | ~36 | 同名或明确别名（如 `create_motion_graphic`） |
| 本仓 agent 完全缺失 | 16 | 见 §1 |
| 有工具但 schema 不对齐 | ~6 大块 | 见 §2 |
| 源 library 条目 | 转场12/特效9/LUT2/Zoom4/SFX35/MG211 | **源条目 clone 已齐**，见 §4 |
| 自扩内容 | 额外转场/特效/胶片 look/合成音效 | 非源债，§4 备注 |

**推荐开工顺序（价值/成本）**：  
P0 §2.1 `edit_captions` → §2.2 `manage_transcript` → §2.3 `isolate_voice attach` → §1.3 ProRes agent → §1.1 followup 工具注册 → §1.4 `search_fonts` → §2.4 download/push 同名 → 其余。

---

## 0.5 分工（2026-07-15，Claude ⟷ grok 平均分）

> **[C] = Claude 认领 · [G] = grok 认领**。按**领域切**避免俩 agent 撞同一批文件；effort 平均（C 件少但含最重的 edit_captions/edit_item；G 件多但多数薄封装/本地等价）。

### 自 grok 初版后已完成（**勿重做**）
- ✅ `edit_asset`（`agent/edit-asset-tools.ts`，改/删库资产，code 过沙箱、删有 confirmImpact）— Claude
- ✅ `view_asset_frames`（`agent/frames-tool.ts`，渲源资产帧）— Claude
- ✅ `manage_markers` + 标尺 pin/编辑 UI — Claude(工具) + 用户(UI)
- ✅ `convert_motion_graphic_to_video` / `register_converted_video`（不透明 h264，见 §2.7）— Claude
- ✅ ripple 插入/删除 + fade(秒) 暴露（`set_item_timing`/`remove_item`/`add_*`）— Claude
- ✅ `web_browser` + Firecrawl 扩展（`agent/web-tools.ts`，§1.7）— grok
- ✅ `download_media` / `push_asset` 同名（`agent/stock-tools.ts` + `/api/import-url`，§2.4）— grok
- ✅ `search_fonts` + `submit_export` confirmFontFallback / nleFormat（`agent/font-tools.ts` + `fonts/googleFonts.ts`，§1.4 §2.5）— grok
- ✅ 工程七件套 + `get_editor_url`（`agent/project-tools.ts` + soft-delete，§1.2 §1.5）— grok
- ✅ 本地 upload 三件套（`agent/upload-tools.ts` + `/upload?assetId=`，§1.6）— grok

### 分工表

| # | 项 | 主要文件 | 认领 |
|---|---|---|---|
| §2.1 | **`edit_captions` 21-action 重写**（最大债） | `agent/transcript-tools.ts` + `captions-tools.ts` + `captions/*` | **[C]** |
| §2.2 | `manage_transcript` translation_*/retry | `agent/transcript-tools.ts` + `transcript/variants.ts` | **[C]** |
| §2.3 | `isolate_voice` attach | `agent/isolate-tools.ts`（`setItemDenoise` 已在） | **[C] ✅** |
| §1.3 | `export_motion_graphic_prores` | `agent/mg-video-tools.ts`（薄封装 `exportClipMov`） | **[C] ✅** |
| §1.1 | `ask_followup_questions` 注册工具 | 新 `agent/followup-tools.ts`（复用现成 `<widget>`） | **[C] ✅** |
| §2.6 | `edit_item` 批处理统一/`ripple`/`validateOnly` | `agent/edit-item-tools.ts`（我已在此做过 ripple/fade） | **[C]** |
| §2.7 | convert alpha 说明（description 写清 opaque） | `agent/mg-video-tools.ts` | **[C]** |
| §1.2 | 工程会话 7 工具（create/list/delete/duplicate/edit/restore/target_project） | 新 `agent/project-tools.ts` + `persist/projectStore.ts` + `context.ts` | **[G]** |
| §1.4 + §2.5 | `search_fonts` + `submit_export` confirmFontFallback/nleFormat（字体门一体） | 新 `agent/font-tools.ts` + `generate-tools.ts`/`export-tools.ts` + `fonts/googleFonts.ts` | **[G]** |
| §2.4 | `download_media` / `push_asset` 同名（`import_url_asset` 转别名） | `agent/stock-tools.ts` | **[G]** |
| §1.6 | 上传/下载三件套本地等价（request_upload/finalize/request_download） | `agent/*`(新) + `vite-plugin-upload.ts` | **[G]** |
| §1.5 | `get_editor_url` | `agent/project-tools.ts`（依赖 §1.2） | **[G]** |
| §1.7 | `web_browser`(进行中) + `report_user_friction` | `agent/web-tools.ts` | **[G]** |
| §4.2/4.3/4.4/4.6 | UX：隐藏假音频转场入口 / ripple 工具栏模式 / credits mock 或隐藏 / `@`引用结构化 | `Timeline.tsx` / `ChatComposer.tsx` / `Editor.tsx`（都是用户/grok 常动的 UI） | **[G]** |

### 协调注意（俩 agent 同一工作树）
- **`src/agent/tools.ts` 是唯一共享接线文件**：各自只**在末尾 append** 自己的 `import`+`...SCHEMAS`+`NAMES.has` 三件套,**别改别人已有的行**;冲突时后提交者重跑 `tsc -p tsconfig.app.json`+`-p tsconfig.node.json`。
- **Claude 的旧 `TODO-SOURCE-PARITY.md` 有 3 处 ✅ 是错的**（ask_followup / edit_captions / manage_transcript——按"功能"算而非"契约"算）;**以本文（真 schema 契约）为准**,那份仅作产品覆盖视角参考。
- 各自认领项做完在 §7 勾选并标 commit;新发现的 schema diff 直接补条目。

---

## 1. 源站 MCP 有、本仓 agent 完全没有（16）

### 1.1 ✅ `ask_followup_questions` — 交互问答卡（工具层）**[C 已完成]**

| | |
|--|--|
| **缺口（已补）** | 源站是正式 tool：`required: ['fields']`。本仓过去只有 UI 解析 `<widget>`，**未注册 tool**；现已注册 + execute。 |
| **源站** | schema：`mcp-tools-schema.json` → tool `ask_followup_questions`；UI 参考：`chatcut-reverse` 里 `ui://chatcut/followup-questions-v31` / 资源 `misc/followup-questions-widget.html`（若在 reverse 仓）。 |
| **本仓 UI** | `src/components/chat/WidgetCard.tsx`、`widget-parse.ts`、`ChatMessage.tsx`（渲染 widget）；`src/agent/systemPrompt.ts`（教模型发卡）。 |
| **本仓 agent** | `src/agent/followup-tools.ts`（新建）：schema `fields[{id,label,type:single\|multi,options[{value,display}],required,allowOther}]` + `buildFollowupWidget()` 序列化成 `<widget>` 文本 + `execFollowupTool` 返回 `{__followup, note}`。 |
| **落地** | 1. ✅ `followup-tools.ts`：`exec` 把 fields 序列化成现有 `<widget>` 文本，无选项字段降级为提问行。2. ✅ `runtime.ts` 特判 `__followup`：以 assistant text 发卡（复用 text-start/text-delta）+ **停 loop 等作答**（答案经现成 `onWidgetSubmit`→下条用户消息）。3. ✅ `tools.ts` 注册 `FOLLOWUP_TOOL_SCHEMAS`+`FOLLOWUP_TOOL_NAMES`+`exec`（末尾追加，不碰 grok 行）。4. ✅ UI 零改动，`WidgetCard.onSubmit` 原样回填。5. ✅ `followup-tools.check.ts` 往返自检（并入 `npm test`）。tsc app+node 双过。 |

---

### 1.2 ✅ 工程会话域（7 工具）

`create_project` · `list_projects` · `delete_project` · `duplicate_project` · `edit_project` · `restore_project` · `target_project`

| | |
|--|--|
| **本仓** | `src/agent/project-tools.ts`；`projectStore` 软删/`restoreProject`；`AgentContext.getProjectId` + `openProject`（Editor hash 导航）。 |
| **状态** | ✅ 2026-07-15 [G] |

---

### 1.3 ✅ `export_motion_graphic_prores` — agent 导出透明 ProRes **[C 已完成 · a521cf5]**

| | |
|--|--|
| **缺口（已补）** | 源站 agent 可批量按 assetId/itemId 出 `.mov`；本仓过去仅右键 UI，现已加同名 agent 工具。 |
| **源站** | schema：`export_motion_graphic_prores`（`itemId(s)` / `assetId(s)` / `filenameMode` / `preferTimelineInstance`…）。 |
| **本仓 agent** | `src/agent/mg-video-tools.ts` → `export_motion_graphic_prores`：`resolveMgItems`（itemId(s)/assetId(s) 去重解析）→ 循环 `exportClipMov(state, item)`（`codec:'prores', transparent:true`）→ 返回 `{ok, exported, failed?, format:'prores4444_mov', transparent:true}`。渲染逻辑复用 `media/clipExport.ts`，薄封装。 |

---

### 1.4 ✅ `search_fonts`

| | |
|--|--|
| **源站** | schema：`search_fonts`，`required: ['query']`。 |
| **本仓** | `src/agent/font-tools.ts` + `src/fonts/googleFonts.ts` `FONT_CATALOG` / `searchFontCatalog`。支持中文别名（得意黑/鸿蒙…）；`loadable` 标是否 export-safe。 |
| **状态** | ✅ 2026-07-15 [G] |

---

### 1.5 ✅ `get_editor_url`

| | |
|--|--|
| **本仓** | `project-tools.ts` → `buildEditorUrl`（`origin#/editor/<id>`）。 |
| **状态** | ✅ 2026-07-15 [G] |

---

### 1.6 ✅ 上传/下载预签名链（3）本地等价

`request_asset_upload_url` · `finalize_uploaded_asset` · `request_asset_download`

| | |
|--|--|
| **本仓** | `src/agent/upload-tools.ts`；`POST|PUT /upload?name=&assetId=` 确定性落盘；`localDev:true` 标明非 S3。 |
| **状态** | ✅ 2026-07-15 [G] |

---

### 1.7 ✅ Firecrawl 联网工具 · ❌ `report_user_friction`

| | |
|--|--|
| **源站** | schema 仅 `web_browser`（scrape）。 |
| **本仓** | ✅ `web_browser`（scrape，含官方 branding/summary format）+ **`web_search` / `web_map` / `web_crawl` / `web_batch_scrape`**。`src/agent/web-tools.ts` + `vite-plugin-firecrawl.ts`（`/api/web-browser`、`/api/firecrawl/{search,map,crawl,batch}`）。key=`FIRECRAWL_API_KEY`。 |
| **未接** | Firecrawl interact / monitor / parse 等。 |
| **反馈** | `report_user_friction` 仍未做。 |

---

## 2. 有工具，但与源站 schema 严重不对齐

### 2.1 🟡 `edit_captions` — **最大契约债**

| | |
|--|--|
| **源站 action**（schema 原文 enum） | `enable, disable, display_text, template, style, layout, layout_policy, positions, preset_apply, preset_delete, preset_list, preset_rename, preset_save, bilingual, language_mode, source_add, source_list, source_remove, source_set, source_update, track` |
| **源站位置** | `mcp-tools-schema.json` → `edit_captions`；参数 `captionsItemId/json/preset/templatePreset/trackId…` |
| **本仓 agent** | `src/agent/transcript-tools.ts`（`edit_captions`：扁平 `enabled/template/pacing/track/translateTo/variantLang`） |
| **本仓 词级覆盖** | `src/agent/captions-tools.ts`（`read_captions` / `edit_caption_words` / `set_caption_sources`） |
| **本仓 UI** | 轨道头字幕：`src/components/Timeline.tsx`（CC 菜单）；样式：`src/captions/styles.ts`（21）；渲染：`src/captions/` + `CaptionsLayer`；库侧文字稿底栏字幕控件（若有 `CaptionsControls`）。 |
| **怎么改** | 1. **以源站 enum 为 action 机** 重写 `edit_captions` schema（保留内部实现可调现有 store）。2. 映射表：`enable/disable`→现 enabled；`template`→template id；`display_text`→接到 `wordOverrides`/`edit_caption_words`；`source_*`→`set_caption_sources`；`bilingual/language_mode`→translate/variant。3. 暂未实现的 action（layout/positions/preset_*）返回明确 `not_implemented` 列表，避免 silent no-op。4. check：`transcript-tools.check.ts` / 新 `edit-captions-parity.check.ts` 对照源 enum。 |

---

### 2.2 🟡 `manage_transcript`

| | |
|--|--|
| **源站 action** | `fix, retry_transcription, translation_create, translation_ensure, translation_list, translation_read` |
| **源站位置** | `mcp-tools-schema.json` → `manage_transcript` |
| **本仓 agent** | `src/agent/transcript-tools.ts`：`fix | renameSpeaker | translate` |
| **本仓 UI** | `src/transcript/TranscriptPanel.tsx`、`TranscriptViews.tsx`、`segment.ts`、`edit.ts`、`variants.ts` |
| **本仓 转写入口** | `transcribe_track` + `assemblyai.ts` |
| **怎么改** | 1. schema action 扩到源站集合。2. `translation_create/ensure/list/read`：映射现有 `variants.ts` + `translate` 逻辑，**不要改词时间戳**。3. `retry_transcription`：复用 `transcribe_track`/AssemblyAI，支持可选 `audioBase64`（可二期）。4. `fix`：保留 wordIndex/find，并兼容源站 `content` 批命令（解析 `FIX` 行）若需要。5. `renameSpeaker` 可保留为扩展 action（源 MCP enum 无，但对 UI 有用）。 |

---

### 2.3 ✅ `isolate_voice` `attach` **[C 已完成 · a521cf5]**

| | |
|--|--|
| **源站** | action: `apply \| attach \| clear`；`attach` 要 `denoisedAssetId` |
| **本仓 agent** | `src/agent/isolate-tools.ts`：三 action 齐。`attach` 校验媒体池 audio asset（`ctx.getDoc().assets` 前缀匹配）→ `commands.setItemDenoise(item.id, asset.src, strength)`，复用池内已隔离 wav 不重跑管线。schema enum `['apply','attach','clear']` + `denoisedAssetId`。 |

---

### 2.4 ✅ `download_media` / `push_asset` 同名工具

| | |
|--|--|
| **源站** | `download_media` required `url`（可数组≤4）；`push_asset` required `filePath`（公网 URL） |
| **本仓** | `src/agent/stock-tools.ts`：同名 `download_media` / `push_asset` + 遗留 `import_url_asset` 别名 + `search_stock_media`。本地 `POST /api/import-url`（`vite-plugin-upload.ts`）拉字节进 `/media/uploads`；无代理时回退 remote `src`。返回 `{ failed, succeeded, results }`。 |
| **本仓 UI** | 媒体池：`src/media/MediaPoolPanel.tsx` |
| **状态** | ✅ 2026-07-15 [G] |

---

### 2.5 ✅ `submit_export` 与字体门

| | |
|--|--|
| **源站** | `confirmFontFallback`、`nleFormat: fcp_xml \| fcp_xml_resolve` |
| **本仓** | `generate-tools.ts` submit_export：video/xml 前 `fontFallbackGate`；`nleFormat` → `timelineToFcpxml`（Resolve 加 colorSpace + event 名）。 |
| **状态** | ✅ 2026-07-15 [G] |

---

### 2.6 🟡 `edit_item` 批处理语义

| | |
|--|--|
| **源站** | `adds/updates/deletes` 数组 + `ripple` + `validateOnly` |
| **本仓** | `src/agent/edit-item-tools.ts` + 大量拆分工具（`move_item`…） |
| **本仓 UI** | 时间线拖拽：`Timeline.tsx`；命令：`src/editor/store.ts` |
| **怎么改** | 1. 读源 schema 把 `edit_item` 收成**唯一批入口**（内部仍调 store）。2. `validateOnly` 干跑不写 history。3. `ripple` 与 `rippleDeleteItem` / add 的 ripple 对齐。4. 拆分工具可保留但 description 写「prefer edit_item」。 |

---

### 2.7 🟡 `convert_motion_graphic_to_video` 无 alpha

| | |
|--|--|
| **源站** | 转可复用视频资产（云端可透明） |
| **本仓** | `mg-video-tools.ts` + `clipExport`/`/render-clip` → **不透明 h264**（代码自陈） |
| **本仓 UI** | 右键转视频 / ProRes 另路径 |
| **怎么改** | 1. 短期：工具 description 明确 opaque。2. 中期：`render` 支持 vp8/webm alpha 或统一引导 `export_motion_graphic_prores`。3. 环境 ffmpeg 能力写进 doctor/README。 |

---

## 3. 源 library 条目 — 已齐（维护用，非债）

> 改库前先读：`../chatcut-reverse/harness/library-catalog/`

### 3.1 ✅ 画面转场 12/12

| 源 ID（去掉 builtin:tr- 前缀） | 本仓 |
|------------------------------|------|
| anticipation-zoom … whip-pan（完整 12） | `src/editor/types.ts` `TRANSITION_ORDER`；`src/gl/transitions.ts`；`src/gl/shaders/*.frag` |
| **UI** | `src/library/LibraryPanel.tsx` 转场 tab；`ResourceBrowser` + `TransitionThumb.tsx` |
| 额外（非源） | circle-wipe / radial-blur / glitch-cut / dip-to-color |

### 3.2 ✅ 特效 9/9

| 源 ID | 本仓 shader / registry |
|-------|------------------------|
| rect-mask, circle-mask, local-mosaic, magnify, tilt-shift, crt, ascii-rain, shake, luma-key | `src/gl/fx/*.frag` + `src/gl/fx/effects.ts` `FX_EFFECTS` |
| **UI** | LibraryPanel 特效 tab；`FxThumb.tsx`；Inspector 调参 |
| 额外 | chroma-key 及大量 stylize（非源库） |

### 3.3 ✅ LUT 2/2

| 源 | 本仓 |
|----|------|
| slog3-s709, canon-log3-709 | `effects.ts` `LUT_EFFECTS` + frag |
| **UI** | LibraryPanel LUT tab |
| 额外 | look-fuji-* / ricoh / kodak… 公式胶片感 |

### 3.4 ✅ Zoom 4/4

| 源 | 本仓 |
|----|------|
| punch, instant, slow-push, hold | `types.ts` `ZOOM_SHAPE_*`；`src/editor/zoom.ts`；`ZoomThumb.tsx` |
| 额外 | zoom-out, ease-in, bounce, snap, pulse, whip-in |

### 3.5 ✅ 音效 35/35 + 4 合成

| | |
|--|--|
| **源资源** | reverse 仓 sound-library 35 mp3 |
| **本仓** | `src/audio/soundLibrary.ts` + `public/sound-effects/*.mp3`（39=35+4） |
| **UI** | `SoundBrowser.tsx`；拖拽：`library/drag.ts` |

### 3.6 ✅ MG 211

| | |
|--|--|
| **本仓** | `src/assets/chatcut-templates.json`；`template-host.ts`；`TemplateBrowser.tsx` |

### 3.7 源 audio-fx 库条目 = 0

源 `audio-fx.json` total=0。本仓隔离是 **工具+面板**，不是 browse_library 条目——无需硬凑库卡。

---

## 4. 编辑器 UX 债（非 MCP 52，但是产品）

### 4.1 ✅ 资源库拖到时间线 + 片段标记（已做）

| | |
|--|--|
| **代码** | `src/library/drag.ts`；`ResourceBrowser`/`SoundBrowser`/`TemplateBrowser`；`Timeline.tsx` `applyLibraryToClip`；CSS `.cc-clip-badge` |
| **若回归** | 查 MIME `application/x-chatcut-library`；徽章读 `item.effects` / `zoom` / `denoisedSrc` / transitions |

### 4.2 🟡 音频转场 UI 占位

| | |
|--|--|
| **UI** | `LibraryPanel.tsx` 转场子 tab「音频转场」空态文案 |
| **源** | library-catalog 无独立音频转场列表（或未导出） |
| **怎么改** | 有产品定义再接；否则隐藏子 tab，避免假入口 |

### 4.3 🟡 Ripple 全模式（insert/overwrite）

| | |
|--|--|
| **本仓** | `store.rippleDeleteItem`；add 可选 ripple；**无工具栏 insert/overwrite 模式** |
| **UI** | `Timeline.tsx` 工具栏 |
| **怎么改** | 工具栏模式 state + 落轨/粘贴/move 走统一策略；agent `edit_item.ripple` 共用 |

### 4.4 ❌ 积分门（源 G4）

| | |
|--|--|
| **本仓** | `src/Editor.tsx`：`credits={18.5}` 写死；`TopBar.tsx` 展示 |
| **怎么改** | 无后端则：本地 mock 钱包 + 生成工具扣减；或隐藏 credits。真扣费需服务端。 |

### 4.5 🟡 Followup UI vs 工具

见 §1.1：UI 已在 chat，差 tool 注册。

### 4.6 🟡 `@` 引用结构化

| | |
|--|--|
| **UI** | `ChatComposer.tsx` |
| **怎么改** | 插入 `{type,id,name}` 上下文块，runtime 拼进 user message；对照源 `chat_context_entry`（若 reverse 有描述）。 |

---

## 5. 注册表：本仓 agent 接线入口（改工具必碰）

| 文件 | 职责 |
|------|------|
| `src/agent/tools.ts` | **总注册**：`TOOL_SCHEMAS` 展开 + `executeTool` 分发 |
| `src/agent/runtime.ts` | agent loop / system prompt 注入 |
| `src/agent/context.ts` | `AgentContext`（getState/commands） |
| `src/agent/*-tools.ts` | 各工具 schema + exec |
| `src/editor/store.ts` | 时间线命令（工具最终应落到这里） |
| `src/editor/reduce.ts` | 状态突变 |

**新增工具标准步骤**：  
1. 读 `mcp-tools-schema.json` 该 tool 的 `inputSchema`  
2. 写 `src/agent/xxx-tools.ts`（schema 字段名尽量同名）  
3. 实现 exec → `ctx.commands.*` / persist / fetch  
4. `tools.ts` import + spread + `NAMES.has` 分支  
5. 加 `xxx-tools.check.ts` 或最小 assert  
6. 若有 UI：LibraryPanel / Inspector / Chat 接线  

---

## 6. 源站路径速查（本机）

```
chatcut-reverse/
  harness/
    mcp-tools-schema.json          # 52 工具权威
    mcp-tools-schema.md
    library-catalog/
      transitions_items.json       # 12 转场
      fx_*.json / fx.json          # 9 特效分组
      luts_items.json              # 2 LUT
      zoom_items.json              # 4 zoom
      sound-effects.json           # 35 音效分组 overview
      audio-fx.json                # 空库
    shaders/glsl/                  # 源 GLSL 文件名
  resources/sound-library/         # 若存在 35 mp3
```

```
chatcut-clone/
  src/agent/tools.ts               # 总开关
  src/library/LibraryPanel.tsx     # 资源库 UI 壳
  src/library/drag.ts              # 拖拽协议
  src/components/Timeline.tsx      # 时间线 + 徽章 + drop
  src/gl/fx/effects.ts             # FX+LUT 注册
  src/gl/transitions.ts            # 转场注册
  src/audio/soundLibrary.ts        # 音效目录
  src/assets/chatcut-templates.json
```

---

## 7. 检查清单（每完成一项勾）

### P0 契约

- [ ] **[C]** `edit_captions` action 机对齐源 enum（§2.1）
- [ ] **[C]** `manage_transcript` translation_* + retry（§2.2）
- [x] **[C]** `isolate_voice` attach（§2.3）
- [x] **[C]** `export_motion_graphic_prores` 注册（§1.3）
- [x] **[C]** `ask_followup_questions` 注册（§1.1）

### P1 资产/字体/导出

- [x] **[G]** `download_media` / `push_asset` 同名（§2.4）
- [x] **[G]** `search_fonts` + export `confirmFontFallback`（§1.4 §2.5）
- [ ] **[C]** `edit_item` 批处理/ripple/validateOnly 文档化或对齐（§2.6）
- [ ] **[C]** MG convert 透明策略写清或实现 alpha（§2.7）

### P2 工程 MCP

- [x] **[G]** project 七件套 + `target_project`（§1.2）
- [x] **[G]** `get_editor_url`（§1.5）
- [x] **[G]** 本地 upload 三件套等价（§1.6）

### P3 可选

- [x] `web_browser` Firecrawl（§1.7）
- [ ] `report_user_friction`（§1.7）
- [ ] 隐藏音频转场假入口（§4.2）
- [ ] Ripple 模式工具栏（§4.3）
- [ ] credits 隐藏或 mock（§4.4）

---

## 8. 不要做的（写清以免误开）

| 项 | 原因 |
|----|------|
| 把 FEATURE-COVERAGE.md 当真理 | 过时，与 mcp-tools-schema 冲突 |
| 为 audio-fx 硬凑源库条目 | 源 catalog total=0 |
| 删掉自扩 LUT/转场 | 非源债；可标「扩展」 |
| 无后端做真 Stripe/协作同步 | 无对象可服务 |
| 伪造系统提示原文 | reverse 也拿不到 |

---

## 9. 变更记录

| 日期 | 说明 |
|------|------|
| 2026-07-15 | 初版：对照 mcp-tools-schema.json + library-catalog + src 真代码写入 |

---

*维护约定：完成某项时在 §7 勾选，并在对应 § 条目标注 commit；新发现的 schema  diff 直接补条目，勿改回旧 coverage 文档。*
