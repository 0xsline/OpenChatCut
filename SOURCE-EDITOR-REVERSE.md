# ChatCut 编辑器源码逆向结论

> 目标：以源站代码为准，而不是只照单张截图描 UI。源码来自 `/Users/qinpx/Desktop/project/chatcut-reverse/resources/bundles/decompiled/editor/entry.js` 及其依赖 bundle。

## 1. 源站真实面板树

源站不是“顶栏 + 三列 + 全屏宽时间线”，而是 Dockview 嵌套树：

```text
TopBar
└─ horizontal
   ├─ AI（从顶栏下方一直贯穿到底）
   └─ vertical
      ├─ horizontal
      │  ├─ Assets（My Assets / Library / Transcript 同组标签）
      │  └─ Canvas / Viewer
      └─ Timeline（只跨 Assets + Canvas，不跨 AI）
```

源码证据：

- `x8 = ["ai", "canvas", "timeline", "assets", "library", "transcript"]`
- `canvas.direction = "right"`, `referencePanel = "ai"`
- `timeline.direction = "below"`, `referencePanel = "canvas"`
- `assets.direction = "left"`, `referencePanel = "canvas"`
- `library`、`transcript` 使用 `direction = "within"`，与 Assets 同组。
- 默认布局由 `bee()` 按上述顺序调用 Dockview `addPanel()` 构建。

## 2. 源站默认尺寸算法

`Qn` 与 `_8()` 给出的默认规则：

| 区域 | 默认 | 最小值 |
|---|---:|---:|
| AI | `34%` 总宽；静态初始值 `490` | `320` |
| Assets | `24%` 总宽；静态初始值 `346` | `176` |
| Canvas | 剩余约 `42%` | `280` |
| Timeline | Dock 高度的 `34%` | `260` |

时间线最大高度为 `dockHeight - 300`，即至少给上方 Viewer 留 300px。旧独立时间线状态默认值是 `300`，键为 `remotion-editor-starter.timeline-height`。

当 Canvas 不足 280px 时，`_8()` 先压缩 Assets 到 176px，再压缩 AI 到 320px。

## 3. 用户截图中的已保存布局

截图 `/Users/qinpx/Desktop/Snapzy/Snapzy_2026-07-14_12-34-12_227.png` 实际尺寸 `2857 × 1710`，分割线为：

| 区域 | 像素 | 占总宽/高 |
|---|---:|---:|
| AI | 642 | 22.47% |
| Assets | 792 | 27.72% |
| Canvas | 1423 | 49.81% |
| TopBar | 86 | 5.03% |
| 上方 Assets + Canvas | 1004 | 58.71% |
| Timeline | 620 | 36.26% 总高；顶栏以下的 38.18% |

这不是 `_8()` 的默认 34/24/42，而是用户拖动后保存的 Dockview 状态。源站通过：

- `QBe()` → `api.toJSON()` 保存；
- `wee()` → `api.fromJSON()` 恢复；
- key：`chatcut-dockview-layout-v9:${preset}`；
- preset：`default / media / portrait / script`。

本 worktree 现在按这张截图的保存状态初始化，同时保留源站的 320/176/280/260 约束和拖动持久化。

## 3.1 登录态 Chrome 运行时核验（2026-07-14）

已在用户登录态 Chrome 中直接核验源站工程
`https://app.chatcut.io/zh/editor/609f5542-8f74-4ec3-8955-bb04688aa60a`。当前画面是一个 03:05.00 的真实工程，包含 V1、A1、A2 三轨和真实音频波形。

源站当前可见控件：

- 顶栏：项目库、项目重命名、邀请协作者、撤销、重做、版本、工作区、导出、积分/账号。
- 素材：我的素材/资源库/文字稿、搜索、上传、新建文件夹、网格/列表、排序、筛选；素材卡还有全屏查看、收藏、更多操作和转写状态。
- 时间线：新建时间线、选择模式 `V`、修剪编辑模式 `N`、刀片模式 `B`、分割、吸附、录制旁白/录制设置、播放、缩放、适配视图、画幅比例、字幕开关/字幕样式、全屏。
- 轨道头：隐藏、静音、字幕/源下拉、角色标识、删除等轨道级入口。

这次运行时核验也确认源站修剪快捷键是 `N`；本地 `Timeline.tsx` 已同步修正并完成浏览器回归。

## 4. 编辑器功能对标，不只是 UI

### 已有

- 片段拖动、首尾裁剪、跨轨类型约束、切分、吸附。
- 轨道隐藏/静音，预览与导出生效。
- 多时间线、复制、比例副本、Agent `manage_timelines`。
- 动态轨道：稳定 id + 动态 V/A 别名，增删、排序、命名、角色、锁定、折叠、隐藏、静音、收紧；Agent `edit_track` 已接，旧工程自动迁移。
- 角色闪避：anchor 轨活动区间驱动 follower 轨动态降音量，默认 -12 dB，支持手动深度，Audio 与视频内嵌音频均生效。
- 轨道头字幕下拉：已移除误放的轨道管理菜单，按源站还原 21 个字幕样式、CC 开关与 8 种翻译语言；支持点击外部关闭，翻译经真实 `/llm/v1/messages` 回归并直接用于双语预览/导出。
- 变换、基础滤镜、缩放/Reframe 曲线、转场、标记。
- 文字稿删词剪片、`read_script/apply_script`、字幕、提案审阅。
- 素材池文件夹、搜索、筛选、排序、收藏、网格/列表、Agent 管理。

### 仍需按源站补齐

| 优先级 | 源站能力 | 当前缺口 |
|---|---|---|
| P1 | Ripple / 插入覆盖模式 | 已有波纹删除自动合缝，以及修剪模式下右边缘变化带动同轨后续片段；仍缺 move/add 的 insert/overwrite 语义、左边缘完整 ripple/roll 行为和统一 Agent 参数 |
| P1 | 真实音频峰值 | 当前时间线波形只是视觉占位；源站有 peak finder、静音平台检测和真实峰值绘制 |
| P1 | 完整片段手柄 | 缺 roll edit、淡入淡出手柄、音量线命中与拖动 |
| P1 | Viewer 直接编辑 | 缺 Canvas 内选框、拖动缩放旋转、裁剪和 Reframe 直接操控 |
| P1 | Dockview 功能 | 缺完整面板显隐、四种 layout preset、布局 JSON 保存/恢复与重置 |
| P1 | 顶栏产品功能 | 版本历史、协作者邀请和工作区菜单目前仍是无业务处理的占位入口 |
| P1 | 自定义字幕样式保存 | 轨道头 CC 下拉、21 个内置预设与翻译菜单已完成；“保存当前样式”需等自定义样式编辑器后启用 |
| P2 | 字幕逐词覆盖/多轨源路由 | 当前只有部分字幕源模型 |
| P2 | 素材卡完整操作 | 缺源站式素材全屏预览；收藏、更多操作已有基础实现但菜单内容仍需逐项核对 |

## 5. 实施顺序

1. ✅ Dock 树、比例、最小尺寸和持久化行为已锁定。
2. ✅ 动态轨道模型、`edit_track` 与 role ducking 已完成。
3. 下一步实现 Ripple/插入覆盖，统一鼠标操作和 Agent `edit_item` 语义。
4. 再接真实 waveform/peak 数据，补 fade、volume line、roll edit。
5. 最后补 Canvas 直接操控与 Dockview 四种 preset。
