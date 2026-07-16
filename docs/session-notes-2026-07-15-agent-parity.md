# 最近三轮对话原文存档

> 保存位置：`chatcut-clone/docs/session-notes-2026-07-15-agent-parity.md`  
> 说明：按对话顺序收录用户原话与助手回复的完整内容（非摘要版）。

---

# 第一轮

## 用户

目前我们的这些功能都实现了吗

## 助手

**工具层面：这条链路基本都接了。**  
**和源站「一键口播成片」比：能跑通，但深度/云能力仍是本地等价，不是 100% 同源。**

---

## 按「用户上传一段视频 → Agent 操作」对照

| 步骤 | 源站 | 我们 clone | 状态 |
|------|------|------------|------|
| **用户拖进媒体池** | 编辑器上传 → S3 + 入池 + 常自动 ASR | `MediaPoolPanel` → `/upload` → 入池 | ✅ **有**（本地磁盘，非 S3） |
| **上传后自动转写** | ingest 常自动开 ASR | 需 **`manage_transcript` retry / 转写工具** 再跑 | 🟡 **半**（工具有，默认不跟上传绑死） |
| **Agent 导入文件** | `import_media` + 官方 helper 大包 | `import_media` create_session + `/upload` + `finalize_*` | ✅ **有**（本地 dev 等价，注释写明非云） |
| **URL 进库** | `download_media` / `push_asset` | 同名工具 | ✅ |
| **读工程** | `read_project` | 有 | ✅ |
| **落轨 / 改片段** | `edit_item`（adds/updates/deletes、`ripple`、`validateOnly`） | 有，且 **validateOnly 已实现** | ✅（语义仍可能比源浅） |
| **切分** | `split_item` | 有 | ✅ |
| **看源帧** | `view_asset_frames` | 有 | ✅ |
| **看时间线帧** | `view_timeline_frames` | 有 | ✅ |
| **转写 / 改错字 / 译文** | `manage_transcript` 多 action | 6-action 已对齐一批 | ✅ 偏本地 |
| **按文稿剪** | `read_script` / `apply_script` | 有 | ✅ |
| **找时间戳** | `find_transcript` | 有 | ✅ |
| **字幕** | `edit_captions` 21-action | 已重写派发 | ✅（部分 action unsupported） |
| **轨角色 / 闪避** | `edit_track` role | 有 + 渲染 duckGain | ✅（无源站级轨头菜单 UI） |
| **提案再应用** | propose → apply | `ProposalCard` + draft | ✅ |
| **等 job** | `track_progress`（转写/生成/上传） | 有（偏生成/本地） | 🟡 弱于云 job |
| **导出** | `submit_export` / `track_export` | 有 | ✅ 本地渲染 |
| **口播 skill 全流程** | 强依赖顺序 + 云生成 | 有创作模式/skill 目录 | 🟡 能引导，非云端 skill 引擎 |

---

## 一句话分层

### ✅ 已经实现（日常「上传 → 让 AI 剪」够用）

1. 用户上传进池  
2. Agent 用 `read_project` 看到资产  
3. `edit_item` 上轨 / 移动 / 批改（含 validateOnly）  
4. 转写相关工具 + 文稿剪 + 字幕  
5. 看帧自检 + 导出  
6. 提案确认再落盘  

### 🟡 有工具但弱于源站

| 点 | 说明 |
|----|------|
| 上传≠自动 ASR | 源常 ingest 即转写；我们多半要再调转写 |
| `import_media` | 无官方 2k 行 helper + 后台转码/EBU 响度那套 |
| 云生成 / 云导出队列 | 本地或简化 job，不是 S3+异步云渲染 |
| Skill 纪律 | 系统提示+创作模式，没有源站完整 skill runtime |
| `edit_captions` 部分 action | preset_*/positions 等仍 unsupported |

### ❌ / OOS（源站有、我们刻意没有或做不了）

- 真 S3 presign 云存储  
- 协作、积分、外部 MCP 会话绑定整包  
- 手机 QR / Continuity 上传  
- MG 转 **透明** webm 的完整云链路（我们偏 opaque h264 + ProRes 路径）  

---

## 对你问题的直接回答

| 问法 | 答 |
|------|-----|
| 上一节说的那些 **功能/工具有没有？** | **绝大多数有，且已注册进 agent。** |
| **是否等于源站完整行为？** | **否。** 同名工具 + 本地等价管线，不是同一套云 ingest/ASR/skill。 |
| **用户传一段视频，Agent 能不能操作？** | **能**：入池 → 读项目 → 落轨 → 转写/剪/字幕/导出，主路径通。 |
| **卡点在哪？** | 自动转写绑定、云 job、skill 强流程、个别契约深度。 |

若你关心的是「打开编辑器拖一个 mp4，跟 AI 说剪一下能不能真改时间线」——**可以**。  
若关心的是「和 app.chatcut.io 同一套上传+自动转写+云 skill」——**还没到**。

需要的话我可以按「用户拖 mp4 → 说一句剪口播」写一份 **本仓实际 tool 调用顺序**（对照源站差异点标 🟡）。

---

# 第二轮

## 用户

我的目标是完整的贴合源站 你直接给我指出差异 并说明怎么改

## 助手

目标是**完整贴合源站**时，按「差什么 → 为什么差 → 怎么改」列清单。  
范围：可本地/可复刻的产品与契约；**协作/计费/真云**标 OOS。

---

# 一、总判断

| 层 | 贴合度 | 说明 |
|----|--------|------|
| MCP **工具同名** | ~95%+ | 52 工具基本都有注册 |
| 工具 **行为深度** | ~70–85% | 多是本地等价，`localDev`、简化 job |
| 编辑器 **UI/NLE** | ~80% | 能剪；布局/深度/部分入口不像 |
| 后端/云 | ~15% | 刻意本地，不是源站栈 |
| 6MB monobundle 全行为 | 未通读 | 只能主题抽，不能保证「源站每个细节」 |

**结论：** 不是「差几个按钮」，而是 **ingest/转写/云 job/字幕模型/UI 壳** 几条主轴还没对齐。

---

# 二、P0 — 上传 → Agent 主路径（你最关心的）

### 1. 用户上传后不自动转写  
| | |
|--|--|
| **源站** | `import_media`/编辑器 ingest 有可读音轨 → **自动 ASR**；`track_progress target:transcription` |
| **本仓** | UI `/upload` 只入池；转写要再调 `manage_transcript` / 转写工具 |
| **差** | 用户拖 mp4 后，Agent 不能默认「已有词级稿」 |
| **怎么改** | 1）`importMedia` / 池导入成功后：有音轨则 **enqueue 转写 job**（AssemblyAI/本地 Whisper 皆可）。2）进度挂 `track_progress`。3）失败可重试，对齐 `retry_transcription`。4）systemPrompt 写：上传完成前不要 `apply_script`。 |

### 2. `import_media` 不是源站 helper 管线  
| | |
|--|--|
| **源站** | `create_session` + `upload-media.mjs`（探测/转码/先传音轨 ASR、响度等） |
| **本仓** | session + `POST /upload` + finalize，`localDev:true` |
| **差** | 无官方 helper、无先 ASR 后大文件、无 EBU 响度副作用 |
| **怎么改** | 1）本地写 **mini helper**（ffprobe + 可选抽音轨 + 上传 + 触发 ASR）。2）`import_media` 返回形状对齐源：`token/endpoint/assetId`。3）文档标明：行为对齐，存储仍是本地。 |

### 3. 云存储 / presign  
| | |
|--|--|
| **源站** | S3 presign、`fileKey`、服务端 probe 旋转尺寸 |
| **本仓** | 磁盘 `/media/uploads` |
| **差** | 无多端/跨会话云资产 |
| **怎么改** | **完整贴源**必须接对象存储 + 元数据表；或明确「单机产品」不做云。要贴源：实现 `request_asset_upload_url` 真签名 + finalize 验 size。 |

---

# 三、P0 — Agent 契约残差

### 4. `edit_captions` 未建模 action  
| | |
|--|--|
| **源站** | 21 action 全语义（含 preset 库、多源 positions） |
| **本仓** | 主路径有；`layout_policy` / `positions` / `preset_*` / `source_update` → **unsupported** |
| **怎么改** | **A. 真做：** 用户预设 IDB 库 + per-source 样式/位置（数据模型升级）。**B. 贴源不扩模型：** 保持 unsupported，但 UI 不提供假入口。完整贴源选 A。 |

### 5. `edit_item` 类型拆分  
| | |
|--|--|
| **源站** | 一个 `edit_item` 覆盖 video/image/… |
| **本仓** | `edit_item` 批入口 + 大量 `move_item` 等；video 通用路径有时走拆分工具 |
| **怎么改** | 1）schema description 与源一致。2）**所有类型**走同一 `adds/updates/deletes` 校验器。3）拆分工具标 deprecated / prefer `edit_item`。4）对照源 schema 做 `edit-item-parity.check.ts`。 |

### 6. MG → 视频 alpha  
| | |
|--|--|
| **源站** | `convert_motion_graphic_to_video` → **vp8/WebM alpha** + `register_converted_video` |
| **本仓** | 池内 **opaque h264**；透明走 ProRes 下载 |
| **怎么改** | 1）`/render-clip` 增加 **webm+alpha**（ffmpeg/vp8 或 vp9）。2）`convert_*` 默认透明 webm 入池。3）不能编码则 **硬失败** 并引导 ProRes，禁止静默 opaque 当透明。 |

### 7. 异步 Job 模型  
| | |
|--|--|
| **源站** | 生成/转写/上传/导出统一 job + `track_progress` / `track_export` |
| **本仓** | 部分同步、部分简化 |
| **怎么改** | 统一 `JobStore`：`pending|running|complete|failed`，所有长任务只回 `jobId`，轮询同构。 |

---

# 四、P1 — 编辑器 UI / NLE（源站壳）

### 8. 闪避 UI 位置  
| | |
|--|--|
| **源站** | `edit_track` role + 控件是 **menu-item**（非轨头常驻大表单） |
| **本仓** | 引擎有 duck；轨头下拉已删；**缺少源式菜单入口** |
| **怎么改** | 轨头 **⋯ 菜单**：关 / 主轨 / 跟随；跟随再出 depth。不要回到轨头常驻长 select。 |

### 9. 轨道深度  
| | |
|--|--|
| **源站** | lock、tighten、效果 lane、完整增删排序 |
| **本仓** | hide/mute/collapse/部分 lock；**tighten 等弱** |
| **怎么改** | 对照 locale/`tighten`：实现 `track.tighten`（同轨片段左收无缝）；锁结构编辑已有则对齐文案与禁用态。 |

### 10. 自定义快捷键  
| | |
|--|--|
| **源站** | 预设 + 冲突检测 + 可改绑定 |
| **本仓** | 54 默认总线 + 只读帮助 |
| **怎么改** | keymap → localStorage；设置页改绑定；`match.ts` 读用户表。 |

### 11. Dockview 布局  
| | |
|--|--|
| **源站** | dockview 可拖面板（beauty 里命中极多） |
| **本仓** | 固定 CSS grid |
| **怎么改** | 接入 MIT dockview，三区入 dock，布局序列化 localStorage。工作量大，但是「壳像源站」关键。 |

### 12. 预览器 / Viewer  
| | |
|--|--|
| **源站** | 自有 canvas viewer，播放在时间线工具栏 |
| **本仓** | Remotion Player，交互模型不同 |
| **怎么改** | 隐藏浏览器原生 controls；播放/逐帧只走时间线工具栏；safe area 等与源对齐。 |

### 13. Relink 边界  
| | |
|--|--|
| **源站** | 离线媒体、可能云拉副本、按文件夹搜 |
| **本仓** | 池内单文件 relink |
| **怎么改** | 补：批量 relink、丢文件标红、可选「从原路径旁搜同名」。云下载标 OOS 或 stub。 |

---

# 五、P1 — 媒体 / 导出产品

### 14. Proxy / 云副本  
源有 proxy/presign 线索 → 本仓无。  
**改：** 要么 OOS，要么「本地低清 proxy 生成」仅编辑用。

### 15. Multicam  
源有 multicam 字符串 → 本仓无。  
**改：** 大功能；完整贴源要单独 epic（同步点、多角度轨）。

### 16. 手机 / QR 上传  
源有 → 本仓无。  
**改：** 需账号+中继；完整贴源要移动端通道，否则 OOS。

### 17. 导出字体门 / NLE  
本仓已有 `confirmFontFallback` / FCPXML 一批。  
**改：** 用源站真工程 XML 做 **golden file** 回归，修字段差。

---

# 六、P2 — Agent 产品壳

### 18. Skill runtime  
| | |
|--|--|
| **源站** | 真 skill 目录 + 依赖顺序 + 分步确认 + 工具过滤 |
| **本仓** | 创作模式注入 body + `manage_skill` |
| **怎么改** | skill 声明 `requiredTools` / checkpoints；runtime 强制 A-roll 完成前禁 MG 生成类工具。 |

### 19. Thinking / 真 extended thinking  
本仓已删假设置。  
**改：** 中继支持则接 API thinking blocks + UI 折叠；不支持则不做假开关。

### 20. 生成积分 / 外链 MCP 消费规则  
源站 tool 描述有 spend rule。  
**改：** 本地可 mock 额度；真 Stripe = OOS。

---

# 七、OOS（完整贴源也难单机完成）

| 项 | 原因 |
|----|------|
| 实时协作 / Zero sync | 需源后端 |
| 邀请/成员/分享链接 | 账号体系 |
| 真积分 / Stripe | 支付后端 |
| 云导出农场 | 对象存储 + worker 集群 |
| 系统提示原文 | reverse 拿不到 |

这些要「贴源」= **自建后端仿 API**，不是只改前端。

---

# 八、建议改造路线（可执行）

### 阶段 A — 主路径同源（优先）
1. **上传 → 自动转写 → track_progress**  
2. **import_media mini-helper**（探测+可选抽音+入池+ASR）  
3. **JobStore 统一** 转写/生成/导出  
4. **edit_item 全类型 + parity check**  
5. **MG webm-alpha 或硬失败策略**

### 阶段 B — 编辑器壳像源
6. 轨 **⋯ 菜单** 设 duck role  
7. track **tighten / lock** 补齐  
8. Viewer 去原生控件  
9. 自定义快捷键  
10. （可选大）dockview  

### 阶段 C — 契约长尾  
11. captions **preset 库 + multi-source layout**  
12. relink 批量  
13. skill runtime 门禁  
14. FCPXML/导出 golden tests  

### 阶段 D — 仅当你要「云同源」
15. S3 + 元数据库 + 异步 worker  

---

# 九、直接回答你的目标

| 问 | 答 |
|----|-----|
| 工具都有了吗？ | **同名基本有。** |
| 行为贴源了吗？ | **主路径能用，ingest/ASR/云 job/部分 captions/UI 壳未贴死。** |
| 完整贴源最大缺口？ | **① 上传即转写+job ② import 真管线 ③ MG alpha ④ 字幕/预设完整模型 ⑤ 布局/Viewer 壳 ⑥ 云（若坚持）。** |
| 怎么改？ | 上表「怎么改」列；先做 **阶段 A**，否则 Agent 永远不像源站「传完就能剪口播」。 |

如果你愿意落地，下一步最划算的是 **阶段 A 第 1 条：上传成功自动转写 + track_progress**——改完后「用户传一段视频 → Agent 操作」会最接近源站体感。说「做 A1」我可以直接在 `chatcut-clone` 开工。

---

# 第三轮

## 用户

那理解视频中的画面什么的 是怎么做到的呢？源码

## 助手

源站 **不是**在服务端跑一套「视频理解大模型 API」把整段片摘要成文字。  
**理解画面 = 抽帧成图 → 以多模态图片塞进 Claude → 模型用眼睛看。**

---

## 1. 总原理

```text
视频/时间线
    │
    ▼  抽静止帧（ffmpeg / 前端 blob / 云渲染）
一张（或网格）JPEG
    │
    ▼  tool_result 里带 image block（多模态）
Claude Vision 读像素
    │
    ▼  决定：选 B-roll、落点、改构图、验收……
edit_item / 继续看帧
```

两条严格分开的「视觉表面」（源 skill 原文精神）：

| 表面 | 工具 | 看的是什么 | 不能当什么 |
|------|------|------------|------------|
| **源素材** | `view_asset_frames` | 媒体池里原始视频/图 | 不能证明字幕、叠层、转场、时间线布局 |
| **合成时间线** | `view_timeline_frames`（Codex 侧还有 `render_cloud_screenshot`） | 当前工程合成画面 | 不能代替「源片里有什么」 |

另有：

- **口播内容** → 转写 / `find_transcript` / `read_script`（便宜、准），**不是**看帧  
- **本地有路径时** → 可用只读 `ffmpeg` 抽帧（Codex helper）；编辑器里无本地路径则走 `view_asset_frames`

---

## 2. `view_asset_frames`（看源片）

**干什么：**  
检查项目资产库里的 **SOURCE**（不是时间线）。

**视频：**

- 入参：`assetId` + 可选 `sourceTimesMs: [ms, …]`（约 1–25 个）  
- 在源时间轴上抽 raw 帧  
- **拼成一张带时间标签的网格图**（类似 contact sheet）  
- 返回：**内联多模态图片** + JSON（含 `renderedBy: frontend | ffmpeg`）

**怎么抽：**

1. 优先：打开的编辑器标签页 / 本地 blob 缓存 → **frontend** 抽帧  
2. 否则：有 `remoteUrl` → **后端 ffmpeg**  
3. 都没有 → 失败（让用户开工程/等上传）

**模型侧用法（源 description 教的）：**

1. 长片先 **广撒 12–25 个均匀时间点** 看网格  
2. 每格代表**附近时间段**，不单是标签那一毫秒  
3. 再 **只对有戏的区间** 二次细采  
4. 配合 `read_project` 拿 assetId / 时长  

**典型用途：** 挑 B-roll、找 logo 出现、判断镜头质量、长上传里哪段能用。

---

## 3. `view_timeline_frames`（看合成结果）

**干什么：**  
渲染 **当前时间线合成** 若干帧 → 一张标注 `f<frame>` 的网格图。

**用途：**

- 改完 MG/字幕/裁切/转场后 **验收**  
- 对用户做「画面上已经…」类断言前 **重新取证**  

**渲染路径：**

- 有桌面/打开的编辑器：可能走前端预览像素（`renderedBy: frontend`）  
- 否则云端/导出级渲染（`cloud`）  
- 外部 MCP 无前端时：**永远 cloud**，本地 blob 必须先变成云可读 URL  

图会写到沙箱 `timeline-frames/…jpg` 供后续回合再读；**不会**自动进用户媒体池（要留下用 `push_asset`）。

---

## 4. 和「听内容」怎么分工

| 问题 | 用什么 |
|------|--------|
| 他说了什么、何时说 | `find_transcript` / script（**词级时间戳**） |
| 画面上有什么、哪段好看 | `view_asset_frames` |
| 叠了字幕/MG 后时间线长什么样 | `view_timeline_frames` |
| B-roll 语义选片（脚本向） | 有时还有 `read_av_script` 等辅助，最终仍要帧或 stock |

源站明确：**不要用看帧代替转写剪口播**；口播剪辑走 script 工具。

---

## 5. Agent 一次完整「看懂再剪」循环

```text
用户上传视频 → 入池（assetId）
       │
       ├─ 有人声 → 转写 job（理解「说什么」）
       │
       └─ 要看画面 →
            view_asset_frames(assetId, sourceTimesMs=[…])
                 │
                 │  tool_result = 网格 JPEG（多模态）
                 ▼
            Claude 描述/挑选可用片段
                 │
            edit_item 上轨 / 裁切 / 加 B-roll
                 │
            view_timeline_frames(frames=[…])
                 │
            确认合成正确 → 继续或导出
```

**没有**单独的「video embedding / 场景检测 SaaS」写在这套 MCP 主路径里；  
场景感来自：**多次抽帧 + 大模型看图 +（可选）本地 ffmpeg 只读诊断**。

---

## 6. 和我们 clone 的对应

本仓 `src/agent/frames-tool.ts` 同构：

- `view_timeline_frames` / `view_asset_frames`  
- `POST /render-still` → base64 → runtime 转成 Anthropic **image** tool_result  
- 源片：`view_asset_frames` 构造「单资产时间线」再 still 渲染  

差异主要在：源有 **frontend blob / 云 ffmpeg 双路径** 与更细的 `sourceTimesMs` 策略文案；clone 统一走本地 headless 渲染，但 **「给模型看图」机制一样**。

---

## 7. 一句话

源站 Agent「理解视频画面」=  

1. **抽帧**（资产源 or 时间线合成）  
2. **拼图/单图** 进多模态 tool 结果  
3. **Claude 视觉** 做判断  
4. 再用 `edit_item` 等改时间线  

口播语义靠 **ASR+文稿工具**，画面语义靠 **帧图+Vision**，两者刻意拆开。
