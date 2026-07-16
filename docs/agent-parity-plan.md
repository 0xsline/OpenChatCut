# ChatCut 复刻 · 贴源改造计划（已对照源码核实）

> 来源：`session-notes-2026-07-15-agent-parity.md`（用户 × grok 三轮差异清单）。
> 本文是**核实版**：每条都对照过 clone 真码 + 逆向规格 `chatcut-reverse/复刻规格-Agent工具与后端.md`，
> 修正了 grok 的错处，并标注本会话已完成项。
> **执行方式：一个一个来。** 每条含 `状态 / 差距 / 改法 / 证据(文件:行) / 备注`。
> 图例：`[ ]` 待做 · `[~]` 部分 · `[x]` 已完成 · `[OOS]` 单机做不了/刻意不做。

---

## 0. 核实修正（grok 说缺、其实已有/已做）

- **track tighten** —— grok 说「弱/需实现」，**实际早已实现**：`edit_track action=tighten` → `store.tightenTrack` → `track.tighten`（`src/agent/track-tools.ts:117`、`src/editor/store.ts:358`）。**从待办移除。**
- **MG「禁止 opaque 冒充透明」** —— grok 的改法 #6 里这条**已做**：`convert_motion_graphic_to_video` 明确回 `opaque:true` + note 引导用 ProRes，不静默当透明（`src/agent/mg-video-tools.ts:105-106`）。仅「本地编码 webm-alpha」仍缺（环境限制）。
- **本会话新增（一种 skill runtime + 沙箱执行）** —— 15 个 plugin `SKILL.md` 逐字搬 + `load_skill` 渐进式披露 + `run_code`（自有 e2b 沙箱，含 `chatcut-media` 预装 ffmpeg 模板）+ `files.url` 拉真实媒体 ffprobe。**这为 A1/A2 提供了现成的执行底座。**
- **edit_item / edit_captions 的 validateOnly** —— 已实现（grok 亦确认）。

---

## 阶段 A — 上传 → Agent 主路径（P0，最影响「传完就能剪」的体感）

### A1. 上传成功 → 自动转写 + track_progress `[x]`（2026-07-15 完成）
- **差距**：源站 ingest 常自动 ASR，用户拖 mp4 后 Agent 默认「已有词级稿」；本仓 `/upload` 只入池，转写要再调 `manage_transcript`/转写工具。
- **证据**：`vite-plugin-upload.ts`/`upload-tools.ts` 无任何 transcribe/enqueue 钩子；转写机器在 `src/transcript/assemblyai.ts` 但未绑上传。逆向：`复刻规格` 域A `import_media` + `track_progress target:transcription`；`skills/transcription/SKILL.md`（逐字搬）已定契约「finalization starts ASR but does not wait; always use track_progress action:wait target:transcription assetIds」。
- **已实现**：
  1. **资产级转写**（对齐源站「asset 标转写完成」，非本仓原来的 clip 级）：`MediaAsset` 加 `transcript / transcribeStatus / transcribeError`（`editor/types.ts`）；新命令 `setAssetTranscription` + reducer `pool.setTranscription`（`store.ts`/`reduce.ts`）。
  2. **ASR job 表**（客户端，因转写在浏览器跑）：`src/transcript/transcribe-jobs.ts`——`shouldTranscribe`（audio 恒真 / video 除非 hasAudioTrack=false）、`enqueueTranscription`（幂等）、`waitForTranscribeJobs`、`transcriptionReport`（纯，含 check）。
  3. **finalize 触发**：`finalize_uploaded_asset` 用 `hasAudioTrack` 门控，入池即 `enqueueTranscription`，回 `next: track_progress action=wait target=transcription`（`upload-tools.ts`）。
  4. **track_progress target=transcription**：新 Claude 侧 `src/agent/transcription-progress.ts`；`tools.ts` 拦截 + `withTranscriptionTarget` 免改 grok 的 `generate-tools.ts` 就扩 schema。终态把词写回资产（drafted，同源站 generation completedAssets）。
  5. **clip 继承**：`addMediaItem` 把 `asset.transcript` 拷进 `item.transcript`（copy，护城河③）。
  6. **UI 上传即转写**：`Editor.tsx` `ingestToPool`（拖池/拖画布/录旁白三处），完成后写回资产 + 回填已放置 clip。
  7. **systemPrompt**：写明上传即转写 + 转写完成前不要 apply_script/删词/上字幕（`systemPrompt.ts`）。
- **验证**：tsc app+node 干净；21 个 check 全过（含新 `transcribe-jobs.check.ts`）；:5210 加载零 console 报错。**未做**：真 ASR 活体端到端（复用已在产的 transcribePath/assemblyai 代理，类型+单测已覆盖）。
- **未尽（小）**：reload 时 in-flight job 丢失（资产无 transcript → 需重触发）；`retry_transcription` 对齐留给 manage_transcript 细化。

### A2. `import_media` mini-helper（探测 + 触发 ASR）`[x]`（2026-07-15 完成，探测这一刀）
- **差距**：源站有官方 `upload-media.mjs`（ffprobe 探测/转码/先传音轨 ASR/EBU 响度）；本仓只有 session + `POST /upload` + finalize，`localDev:true`。
- **证据**：`src/agent/upload-tools.ts:8`「Do NOT pretend this is cloud storage — localDev:true」。逆向域A `import_media` 大 helper 语义；`skills/asset-import/SKILL.md`（逐字）+ `scripts/upload-media.mjs`（2348 行，云 multipart 协议，**不可移植**）。
- **已实现（忠实那一刀 = 探测）**：源 helper 那 2348 行是打 ChatCut 云端签名分片上传的，克隆无此后端 → 不移植。取其**探测步**（`ffprobe -show_streams -show_format` 读 codec_type）落成 `probe_media` 工具（`src/agent/probe-tools.ts`），走本会话已建的 `/e2b/run`（files.url 把本地 `/media` 拉进沙箱）跑 ffprobe，`parseProbe` 归一 `hasAudioTrack/fps/时长/尺寸/codec`（纯，带 8 例 check）。**接上 A1**：agent finalize 前先 probe_media → 传真 hasAudioTrack → 无音轨 b-roll 不触发无谓转写、fps/时长也准。import_media `next` + systemPrompt 导入流程改为 create_session→传字节→probe_media→finalize→track_progress。源站无独立探测工具（在 helper 内）→ 工具名自定并注明。
- **验证**：tsc app+node 干净；22 check 全过（含 `probe-tools.check.ts`）；**真 e2b ffprobe 端到端**（沙箱拉李白 mp3→合法 JSON audio/mono/14.136s，parseProbe 命中 audio-only 例）；:5210 零 console 报错。
- **未做（可选后续）**：转码到 30fps / EBU 响度归一 / 抽 64k 转写音轨先传（源 helper 里有；沙箱可跑但落地需把产物搬回浏览器，价值有限，留待）；静音音轨（有 audio stream 但纯静音）用 volumedetect 跳 ASR。

### A3. 统一异步 Job 模型（JobStore）`[x]`（2026-07-15 完成，含 premise 修正）
- **修正 1（不揉 wire 字符串）**：核对源站发现"统一 job"是**两个家族**——`track_progress`(生成族)与 `track_export`(渲染族)是两条线，词汇可不同；且克隆里异步导出的 `completed` 是**故意对齐同步 `submit_export`(grok 冻结)的 `status:'completed'`**。所以强行把生成族 `succeeded` 与导出族 `completed` 揉成一个字符串**反而不忠实**、且破坏导出族内部一致。
- **修正 2（不硬塞 jobId）**：源站 track_progress schema 本就 `jobIds`(生成)/`assetIds`(转写)分开——转写按 assetId 是忠实的,计划原话"所有长任务只回 jobId"过度化,不采。
- **修正 3（边界）**：生成 `track_progress` handler + 同步 `submit_export` 在 grok 的 `generate-tools.ts`,**冻结不可改**;服务端 job 库 `vite-generation-jobs.ts` 已 canonical-正确,亦不碰(避免 node strip-types 跨上下文 import 脆弱)。
- **已实现（各家族 wire 之下的共享语义层）**：新 `src/agent/job-model.ts`——canonical `JobStatus`(`pending|running|complete|failed|not_found`)+ `normalizeStatus`(各家族 wire→canonical)+ `isTerminal/isComplete/isFailed` 单一 terminal 权威 + `JobReportBase<S>` 骨架(句柄字段名家族特定故不进基类)。把散落 **6 处**硬编码终态判断(`===succeeded`/`===completed`/`done`/`failed`,分布在 export-tools/transcribe-jobs/transcription-progress/generate·progress 四文件)全部收敛到该权威;三报告类型 `extends JobReportBase`。**wire 字符串零改动**,逐点行为等价。
- **验证**：tsc app+node 干净;26 check 全过(新 `job-model.check.ts`：归一化全表 + 三家族终态同构断言;原 transcribe/generation check 回归);6 处替换在各自真实取值域上**逐一证明等价**(见提交说明),故无可观测行为变化,不需浏览器 e2e。
- **未接入（按需)**：`vite-generation-jobs.ts` 服务端 TERMINAL 集(已正确,dedup 收益<跨上下文 import 风险);源站 `upload`/`visual-analysis` 两个 track_progress target(克隆未实现该两类 job,JobKind 已留注释）。

### A4. `edit_item` 全类型统一 + parity check `[x]`（2026-07-15 完成，含 premise 修正）
- **修正**：核对 `mcp-tools-schema.json` 发现 **`split_item` 是源站独立工具**（不是要 deprecate 的拆分件）；`move_item` 才是 clone 便利品（源用 edit_item.updates 移动）。故不删任何工具（clone 细粒度工具是有意设计），只把 edit_item **补成源式统一入口**。
- **差距（真）**：源 `edit_item` 覆盖 video/image/audio/gif/svg/mg/effect/transition 的 adds/updates/deletes；本仓 edit_item 只做**库放置**（effect/transition/mg/sfx adds），泛型 move/trim/delete 甩给独立工具。
- **已实现**：
  1. 泛型逻辑抽到纯模块 `src/agent/edit-item-generic.ts`（只依赖 editor types，避开 GL `.frag` 链好跑 tsx）：`GENERIC_ITEM_KINDS`、`validateGenericUpdate`（move/trim/props/volume/fade 秒→帧 + 校验轨/item）、`validateGenericDelete`（任意类型 + per-entry ripple）、`applyGeneric`（**委托**既有命令 moveItem/setItemTiming/updateItemProps/setItemVolume/setItemFade/remove/rippleDelete，零逻辑重复）。
  2. `edit-item-tools.ts` 的 `validateUpdate/validateDelete` 派发泛型类型 → 泛型校验器；`commitPlan` 走 `applyGeneric`。原子批 + validateOnly 语义不变。
  3. schema description 对齐源（列全类型 + updates/deletes 泛型形态）；move_item/set_item_timing/remove_item 便利工具保留（源 split_item 也保留）。
  4. `edit-item-parity.check.ts`：GENERIC_KINDS 覆盖 + 校验/委托/钳制/原子中止黑盒测（纯模块,tsx 跑）。
- **验证**：23 check 全过；tsc app+node 干净；:5210 零 console 报错。

### A5. MG → webm-alpha（e2b 沙箱编码）`[x]`（2026-07-15 完成，真 e2b e2e）
- **原现状**：`convert_*` 只 opaque h264 + 引导 ProRes（本机 ffmpeg 编不出 alpha webm）。
- **已实现**：本机 Remotion 能渲透明 **ProRes 4444**，缺的只是 alpha-webm 编码——放进 e2b 沙箱（ffmpeg 可 vp9-alpha）。
  - 服务端 `vite-plugin-e2b.ts` 加 `/e2b/transcode-alpha`：收 `/media` 源（透明 ProRes）→ 沙箱 `ffmpeg -c:v libvpx-vp9 -pix_fmt yuva420p -metadata:s:v:0 alpha_mode=1 -auto-alt-ref 0` → **`files.read(format:'bytes')` 二进制安全读回** → 写 `media/uploads` → 回 path。
  - 客户端 `clipExport.ts` `bakeClipToAlphaWebm`（本机烘 ProRes → 调端点）。`mg-video-tools.ts convert`：MG/text/svg 走透明 webm（`ALPHA_CAPABLE`），**沙箱不可用/失败优雅回退 opaque h264**（永不比原来差）；raster 仍 h264；`opaque:true` 可强制。
- **验证**：**真 e2b e2e**——造 `yuva444p12le` 透明 ProRes → 端点出 15KB webm 落盘，ffprobe `TAG:alpha_mode=1`（vp9-webm alpha 真指标；主 pix_fmt yuv420p 属正常，alpha 走独立流）。tsc app+node 干净；:5210 零报错。
- **备注**：源 §0「MG opaque-guard」现升级为真透明；vp9 编码慢（~几十秒），故有超时+回退。

---

## 阶段 B — 编辑器壳（像源站 NLE）

### B1. 闪避 UI = 轨头 `⋯` 菜单 `[x]`（2026-07-15 完成，浏览器 e2e）
- **差距**：源站 `edit_track` role 是 menu-item；本仓引擎有 duck，但缺源式菜单入口（轨头下拉已删）。
- **已实现**：轨头加 `sliders` ⋯ 触发（有角色时琥珀色 tint），开 `cc-duck-menu` 下拉（复用 caption 菜单样式）：关闭 / 主轨·说话(anchor) / 跟随·背景音乐(follower)；选 follower 才留菜单出 **闪避强度** −6/−12/−18/−24 dB（默认 −12，对齐引擎 `duckGain`）；anchor/off 选完即关。走既有 `updateTrack({role})`/`updateTrack({audioRouting:{duckDepthDb}})`，reduce 里 role≠follower 自动清 audioRouting。引擎 `TimelineComposition.duckGain`（follower 在 anchor 说话区间压 dB）本就在跑，纯 UI 接线。
- **证据**：`src/components/Timeline.tsx`（duckMenu state + 外部点击关 + 轨头触发/下拉）。浏览器 e2e：follower→深度行+名牌"·跟随"+tint 琥珀；−18 高亮；anchor→名牌"·主轨"菜单关；off→清空名牌+tint 复灰,全过。

### B2. track lock（tighten 已完成）`[x]`（2026-07-15 完成）
- **核实**：lock **强制早已很全**——reducer 挡 add/move/retime(trim)/remove/split（`reduce.ts:117/137/147/572/592`），UI 挡拖移/落轨 + not-allowed 光标（`Timeline.tsx`）。缺的只是**用户没法从 UI 锁**（`toggleTrackFlag` flag 集不含 lock,只有 agent edit_track 能设）。
- **已实现**：`toggleTrackFlag` flag 集 + `toggleTrack` action 加 `'locked'`；轨头 hide/mute 后加**锁按钮**（lock/unlock 图标切换 + 锁定时琥珀 tint，title「锁定轨道（禁止移动/裁剪/删除/落轨）」/「解锁轨道」）。
- **验证**：tsc app+node 干净；浏览器 e2e：点锁→title 变「解锁」+ 琥珀 tint→再点还原。enforcement 反编译级已在(reducer 挡结构编辑)。

### B3. Viewer 去原生控件 `[x]`（2026-07-15 完成）
- **核实**：`controls={false}` 早已设、时间线工具栏有 play/pause 键（`Timeline.tsx:1093`）+ Space 走 app 快捷键（`catalog play-pause → playPause → player.toggle`，全局 window keydown 独立于 Player）、安全框 overlay 也在。剩的是 Remotion Player 的**默认值**没关。
- **已实现**（`PreviewPanel.tsx`）：`clickToPlay={false}`（点画面不再切播放，纯 viewer）+ `spaceKeyToPlayOrPause={false}`（**修掉隐性双处理**：Player 自带的 Space 处理与 app 全局处理会双切成 no-op，尤其点过 Player 拿到焦点后；现 app 是唯一 Space 源）+ 预览台 `onContextMenu preventDefault`（去浏览器原生 `<video>` 右键菜单：下载/画中画/循环）。
- **验证**：tsc app 干净；:5210 零 console 报错;app Space 派发链代码追踪确认独立于 Player（隔离工程无 clip,活体点击测未跑,行为由 Remotion prop 语义 + 既有独立 transport 保证）。

### B4. 自定义快捷键改绑 `[x]`（2026-07-15 完成，浏览器 e2e）
- **差距**：本仓 `src/shortcuts/`（固定总线 + `ShortcutsDialog` 只读帮助），无改绑/localStorage keymap。
- **已实现**：`keymap.ts` 用户覆盖层（localStorage `cc.keymap.v1`，`effectiveCatalog()` 默认叠覆盖+memoized、`chordFromEvent` KeyboardEvent→canonical 串、`findConflicts` chord 签名比对、set/reset/subscribe）；`useShortcutDispatcher` 改读 `effectiveCatalog()`；`ShortcutsDialog` 从只读→可改绑（点绑定 capture-相 window 监听拦真快捷键、冲突弹「已被占用」确认、↺ 恢复默认、全部重置）；`keymap.check.ts`。
- **验证**：24 check 全过；tsc app 干净；**浏览器 e2e**：Mod+Alt+K 开框→点 undo→Cmd+Alt+Y 直接绑（LS `{"undo":"Mod + Alt + Y"}`）→Cmd+Shift+Z(=redo) 冲突不绑→全部重置回默认+清 LS。

### B5.（可选·大）dockview 布局 `[ ]`
- **差距**：源站 dockview 可拖面板；本仓固定 CSS grid（`Editor.tsx:255` `display:'grid'`，`package.json` dockview 依赖 0）。
- **改法**：接入 MIT dockview，三区入 dock，布局序列化 localStorage。工作量大，是「壳最像源站」的关键，但优先级低。

---

## 阶段 C — Agent 契约 / 产品长尾

### C1. captions preset 库 + multi-source layout `[x]`（2026-07-15 完成预设库这刀）
- **差距**：`edit_captions` 的 `preset_save/apply/rename/delete/list` + `layout_policy/positions` 曾全回 unsupported。
- **已实现（用户预设库 IDB）**：`src/captions/presetStore.ts`（自有 `chatcut-captions` DB,keyed by id,getAll 列出;node 内存回退可测;`resolveCaptionPreset` id/前缀/名）。`captions-actions.ts` 5 个 preset action 接上:`preset_save`(捕当前 template+styleOverride+pacing 存库)、`preset_list`、`preset_apply`(updateCaptions 恢复,drafted)、`preset_rename`、`preset_delete`。从 UNSUPPORTED 移除。
- **仍 unsupported（诚实,非假入口）**：`layout_policy/positions`——本仓字幕是**单例堆叠流**,per-source 位置需多轨道数据模型升级(源站架构差异,刻意不做),`action=layout` 整块移动仍在。
- **验证**：25 check 全过（新 `presetStore.check.ts` 存储 + `captions-tools.check.ts` 补 preset_save→list→apply→delete 全链,原 preset→unsupported 断言已更新）；tsc app+node 干净;:5210 零报错。IDB 路径镜像已验证的 projectStore 模式。

### C2. relink 批量 `[x]`（2026-07-15 完成）
- **核实**：本仓早有**丢文件标红**（`MediaPoolPanel` probe file-backed 素材，加载失败入 `missing` 集+橙 banner）+ 单文件 relink + relink-all 模态（逐个）。缺的只是 banner 早许诺的「选择文件夹搜索」。
- **已实现**：relink-all 模态加**「选择文件夹批量重链（按文件名匹配）」**：`<input webkitdirectory>`（React 无 typed prop → useEffect setAttribute）选文件夹 → 按 `file.name` 匹配每个 missing 素材 → `importMedia` 重传 + `onRelinkAsset` 换 src/元数据 + 清 missing，顺序跑；无同名的保持 missing；结果行「已重链 N 个 / 无同名」。
- **未做（OOS）**：云拉副本（需对象存储后端）。
- **验证**：tsc app 干净；:5210 零报错。批量匹配=Map by name 直查，复用已验证的 importMedia/onRelinkAsset；活体测需先造 missing 素材（未跑）。

### C3. skill runtime 依赖门禁（checkpoints）`[x]`（2026-07-15 完成，含 premise 修正）
- **修正**：核对 `harness/技能全文-中英对照.md:1227` + `HARNESS_AND_TOOLS.md:18`——源站**没有** skill 上的结构化 `requiredTools`/`checkpoints` 字段。checkpoint 是**系统提示里的 prose 纪律**（「每个大阶段先跟用户确认再进下一步；关键点:A-roll 定稿→MG 生成前确认风格→MG 后→B-roll/配乐/字幕同理；别把多 checkpoint 塞一条回复」），工具过滤是**服务端 allowedTools**（单机不可复制）。故不建客户端硬门（源站无据），照源站真机制做 prose。
- **已实现**：`systemPrompt.ts` 加「# 多阶段创作 · 分步确认」段(逐条对齐 source 1227:分阶段确认 / MG 生成前确认方向&overlay-vs-全帧 / 不 bundle checkpoint / 上游改下游全重来烧积分 / skill_guard 花钱工具必确认)。成本门 `skillGuard`(高成本工具不自动应用)本就在(`agentSettings.ts`)。
- **验证**：tsc app 干净(模板字面量无破坏)。纯 prose 无运行时逻辑。

### C4. FCPXML / 导出 golden tests `[x]`（2026-07-15 完成）
- **修正**：源站**没导出真 .fcpxml** 供比对（reverse 里只有反编译 bundle，无 XML 产物）。但从 bundle 挖到属性词汇 `colorSpace/frameDuration/hasVideo/fcp_xml_resolve` **与我方一致**（token 级 parity 确认）。故做**自 golden 全文回归**（锁我方序列化器输出防漂移）+ 补 resolve 变体。
- **已实现**：`fcpxml.check.ts` 加 ①**全文 golden**（确定性 fixture → 整份 FCPXML 字节级 `strictEqual`，任何格式漂移炸并显 diff）②**fcp_xml_resolve 变体**（断言 `colorSpace="1-1-1 (Rec. 709)"` + `event name=(Resolve)`，且默认 Premiere 版无 colorSpace，两版恰好差 2 行=format+event）。原 6 条结构断言保留。
- **验证**：golden check 过；25 check 全过；tsc app+node 干净。

---

## 阶段 D — 云同源（仅当要「和 app.chatcut.io 同栈」）

### D1. S3 presign + 元数据库 + 异步 worker `[OOS-ish]`
- 完整贴源需对象存储 + 元数据表 + 云渲染农场；否则明确「单机产品」。要贴源：`request_asset_upload_url` 真签名 + finalize 验 size。

---

## OOS（完整贴源也难单机完成）

| 项 | 原因 |
|----|------|
| 实时协作 / 多端 sync | 需源后端 |
| 邀请/成员/分享链接 | 账号体系 |
| 真积分 / Stripe | 支付后端 |
| 云导出农场 | 对象存储 + worker 集群 |
| 手机 / QR / Continuity 上传 | 账号 + 中继 |
| 系统提示原文 | reverse 拿不到，只能自研等价 |

---

## 执行顺序（一个一个来）

~~推荐先做 **A1**~~ ✅ **A1 已完成**（上传→自动转写+track_progress，资产级 ASR job 表已落地）。
~~A3(JobStore) 待后续~~ ✅ **A3 已完成**（`src/agent/job-model.ts`：各家族 wire 之下的共享 canonical 状态 + 单一 terminal 权威;零 wire 改动、逐点等价重构）。

**下一条：______（待用户点名 / 默认 A2 import_media mini-helper —— 可直接复用 A1 的 `enqueueTranscription` + 本会话的 run_code/e2b ffprobe 抽音底座）**
