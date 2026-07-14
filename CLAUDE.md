# chatcut-clone 工程规范

复刻 ChatCut(对话式 AI 视频编辑器)。目标:后期可维护。以下为**硬约束**。

## 文件与模块

- **单个源文件 ≤ 500 行(硬上限)**。逼近 400 行就拆。生成/数据文件(如 `chatcut-templates.json`)豁免。
- **函数 < 50 行**;嵌套 < 4 层。
- 多而小 > 少而大;高内聚、低耦合;**按领域/功能分目录,不按类型分**。
- 一个文件一个清晰职责;跨文件用显式导出的类型/接口连接。

## 目录职责(单一真源)

**按领域/功能分目录,不按技术类型堆。** 资源数据 → `assets/`；资源库 UI → `library/`；文字稿逻辑+UI → `transcript/`；字幕 → `captions/`；壳层 chrome → `components/`。新增文件必须落入对应领域,禁止把业务 UI 再往 `components/` 根目录堆。

| 目录 | 职责 |
|---|---|
| `src/assets/` | **静态资源数据**(非运行时代码):`chatcut-templates.json`、占位图等。脚本读写路径也指向这里。 |
| `src/library/` | **资源库** UI 与卡片:LibraryPanel、MG/音效/转场/特效/LUT/Audio FX 浏览器、GLSL 缩略图。 |
| `src/transcript/` | 文字稿:AssemblyAI 客户端、词级编辑算法、TranscriptPanel/Views。 |
| `src/captions/` | 字幕 overlay:类型、样式、resolve、CaptionsControls、CaptionsLayer。 |
| `src/audio/` | 音频域:音效目录(soundLibrary)、人声隔离客户端、响度、录音。 |
| `src/media/` | 用户媒体:上传、clip 导出、MediaPoolPanel(我的素材)。 |
| `src/editor/` | 时间线状态与命令(EditorCore)。`store.ts`/`reduce.ts`/`types.ts`/`TimelineComposition.tsx`。**不含 UI、不含 LLM。** |
| `src/agent/` | 对话 Agent。`client.ts`=MODEL 唯一入口;`runtime.ts`;`tools.ts`;`systemPrompt.ts`;`useAgent.ts`。**只经 EditorCore 命令改状态。** |
| `src/components/` | **壳层 chrome only**:TopBar、Timeline、Preview、Chat、Inspector、Dashboard 等跨域布局。**不要**再塞领域浏览器(库/文字稿/素材池)。 |
| `src/gl/` | WebGL 转场/特效 runtime 与 shaders。 |
| `src/generate/` | AI 生成客户端(图/视频/语音/音乐/音效 job)。 |
| `src/persist/` | 工程/聊天/版本 IDB 持久化。 |
| `src/export/` | 导出(FCPXML 等)。 |
| `src/reframe/` `src/script/` `src/hooks/` `src/fonts/` | 各自领域。 |
| `src/template-host.ts` | 模板编译+沙箱(安全关键)。改这里必跑 `scripts/check-sandbox.mjs`。 |
| `src/theme.ts` `src/types.ts` | 设计 token / 共享类型。 |
| `public/` | 运行时静态文件:sound-effects、media、library-previews 等(URL 路径,非 TS 模块)。 |

### 放哪?(速查)

| 要加的东西 | 放这里 |
|---|---|
| 新资源库 tab / 卡片 / 缩略图 | `src/library/` |
| 新音效元数据 / peaks | `src/audio/soundLibrary.ts`(+ `public/sound-effects/`) |
| 转写/删词/说话人 | `src/transcript/` |
| 字幕样式/翻译/overlay | `src/captions/` |
| 时间线命令 / item 字段 | `src/editor/` |
| Agent 工具 | `src/agent/*-tools.ts` 并在 `tools.ts` 注册 |
| 纯布局 chrome | `src/components/` |
| 大 JSON 模板数据 | `src/assets/` |

移动文件后**同步改所有 import 与 scripts 路径**,再 `npx tsc --noEmit`。

## 代码约束

- **不可变**:永远返回新对象,不原地改(reducer、props 更新都遵守)。
- **边界校验**:LLM 输出、模板代码、用户输入都视为不可信,先校验再用。
- **错误显式处理**:UI 面向的给友好信息,不静默吞。
- 无硬编码魔数(进 `theme.ts`/常量);无 `console.log` 入库。

## 验证(改完必做)

- `npx tsc --noEmit` 通过。
- 动模板/沙箱 → `node scripts/check-sandbox.mjs`(211 过 + 5 恶意拦)。
- 动 Agent/预览 → 浏览器端到端跑一条(localhost:5199)。

## Agent = Anthropic 原生 tool-use(忠实源站)

官方 `@anthropic-ai/sdk`,Messages API `tool_use`/`tool_result`。换真 Claude 只改 `client.ts` 的 `MODEL`。中转站坑见 `memory/chatcut-clone-build.md`。

## 对标源站(每做一个功能都遵守)⭐

我们已对 ChatCut 做过完整逆向,原始数据在 `~/Desktop/project/chatcut-reverse/`。**做任何功能前,先去逆向资料里找源站怎么做的,能用原数据/原算法/原命名就用,不要凭空发明。**

1. **先查逆向再动手**:相关规格/事实优先读
   - `复刻规格-Agent工具与后端.md` —— 52 个 Agent 工具的权威语义(名字/参数/后端映射)。**加 agent 工具就从这里取真名真语义**(如 `clean_script`/`edit_captions`/`find_transcript`),别自造。
   - `PRD.md` / `deep_mining.md` / `architecture_findings.md` / `oss_stack.md` —— 架构与栈事实。
   - `resources/bundles/decompiled/editor/{entry.js,oGe.js}` —— 反编译前端。要精确算法/常量时挖它(单行大文件,用 `python3` 正则,别裸 `grep`)。
2. **用原数据**:模板(211)、音频清单、工具 schema、算法常量、UI 文案,凡逆向里有的一律复用,不重造。
3. **算法对齐**:功能行为对标源站语义。例:静音压缩=源站 `clean_script`(词级时间戳规则处理,非 LLM;`silence`/`longSilence` 阈值;"较长停顿压到阈值,较短的从原录音恢复");字幕=单例 overlay,样式为命名预设。
4. **三条护城河不变式**(源站 §11,复刻必守):① NL→确定性可撤销的时间线变更(propose→apply);② MG/shader eval 安全沙箱;③ **词↔帧双向一致**(转写词、帧、item source 映射永远对齐——删词/压静音/切割必须同时更新文本与帧位)。
5. 找不到源站依据时,在提交说明里注明"源站无据,自定",便于日后对齐。

## UI 像素对齐(所有布局/视觉/控件复刻,优先看这里)⭐

**新扒的像素级素材在 `~/Desktop/project/chatcut-pixel-clone/`(1GB:全站 HTML/DOM/CSS/字体 + 20k 截图 + 控件级 JSON)。做任何 UI 对齐(header/面板/控件/间距/主题色/字体)先查这里,别照记忆或截图猜。** 逆向那份(`chatcut-reverse/`)管**功能/Agent 语义**,这份管**像素/视觉**,分工不同。

**检索顺序(照素材库自带索引 `INDEX.md` / `AGENTS.md`):**
1. 入口先读 `INDEX.md` + `index/CATALOG.json`;按中文/英文标签找控件 → `index/LABEL_INDEX.json`(285 键);任务配方 → `index/QUERY_RECIPES.json`。
2. **主题令牌(起步)**:`supplement/tokens/theme.slim.css`(239 营销 + 400 编辑器 CSS vars);字体在 `supplement/fonts/`(Inter / Stack Sans Notch / JetBrains Mono)。
3. **编辑器控件级(首选)**:`supplement/elements-full/`——56 状态 × 全量控件,每控件 JSON `{id,tag,role,label,text,rect{x,y,w,h},region,styles{},path,html}`,`region∈{topbar|ai_panel|media_panel|preview|timeline}`;裁剪图 `elements-full/crops/{state}/`,整窗 `elements-full/states/{state}.png`。
4. **编辑器整窗对照**:`supplement/editor-states/CURATED/`(~90 去重精选)。
5. **营销页像素复刻**:`pages/perfect-web-clone/{slug}/`(DOM+样式+全页图)+ `preview-shots/` + `supplement/components/`。
6. 高置信状态优先:`00_baseline` `01_export_default` `20_agent_settings` `21_design_style`(413 控件) `22_skills` `60_empty_project` `50_preview_*`。**勿优先翻** `editor-states/full`、`elements/crops`、`_trash_nonpages`(噪声)。

> 只读参考,不改它;拿到 rect/styles 后回本仓 `src/components|Editor.tsx|theme.ts` 落地。像素改动照常跑 `tsc` + 浏览器端到端。
