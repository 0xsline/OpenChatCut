# chatcut-clone — 最小骨架（drop-in seam 验证）

ChatCut 复刻的**起步骨架**。目的：**验证「ChatCut 的 211 个 Remotion 模板能不能直接 drop-in 到我们自己的 Remotion `<Player>` 预览里」**——这是《底座评估-最终结论.md》里选型的第一个、也是最关键的技术假设。

## 结论：✅ 通了

真实 ChatCut 模板（原始 `({item}) => JSX` 代码串，无 import，用注入的 `useCurrentFrame/spring/interpolate/…` 全局）→ Babel 转译 + 注入 Remotion 全局 eval → 在 Remotion `<Player>` 里**像素级渲染**，属性可**实时编辑即时重渲**。7 个跨类目真实模板全部载入通过。

## 它做了什么（= ChatCut 编辑器的三块最小复现）

```
┌ 左：模板库          ┌ 中：Remotion <Player>       ┌ 右：属性检查器
│ 7 个真实 ChatCut    │ 选中模板实时渲染             │ meta.json 的 props
│ 模板(templates/)    │ (预览 seam)                 │ 改一下 → 立刻重渲
```

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/template-host.ts` | **drop-in seam 本体**：`compileTemplate(code)` 把模板代码串 → Babel 转译(classic runtime→`React.createElement`) → 在注入了 Remotion 全局(`useCurrentFrame/spring/interpolate/Easing/random/Img/AbsoluteFill/interpolateColors/Video/Audio/Sequence`)的作用域里 eval → 返回 React 组件。这套注入的全局集合已核对覆盖全部 211 模板实际用到的。 |
| `src/MotionGraphic.tsx` | Remotion 合成：把编译出的模板包进 `<AbsoluteFill>`（= 一个 "motion-graphic" 时间线 item 渲染成的样子）。含编译错误兜底 + 透明格背景。 |
| `src/App.tsx` | 三栏 UI：模板库 / `<Player>` / 属性检查器（props 实时编辑）。 |
| `src/assets/chatcut-templates.json` | 从 `chatcut-reverse/templates/` 抽取的 7 个真实模板（代码 + meta 属性 schema + 默认值）。 |
| `scripts/gen-templates.mjs` | 生成上面的 json（可改 PICKS/scan 灌更多模板，直至 211 全量）。 |

## 跑起来

```bash
npm install
npm run dev          # http://localhost:5199
# 重新抽取模板(改了 gen-templates.mjs 后):
node scripts/gen-templates.mjs
```

## 这验证了什么、还差什么

**已验证（选型最关键的假设）**：ChatCut 模板 = 标准 Remotion 组件，我们用自己的 Remotion runtime 就能直接吃，无需改写模板。→ 《底座评估-最终结论.md》的"路 α（死守 Remotion）"技术上成立。

**下一步（按最终结论的 8 步装配顺序）**：
1. 灌满 211 个模板（改 `gen-templates.mjs` 扫全目录）。
2. **沙箱化**模板 eval（现在是直接 `new Function`——生产必须隔离，见《复刻规格》§11-②：iframe/QuickJS/受限作用域，禁网禁 DOM 逃逸）。
3. timeline 内核（借 opencut-classic 的 MediaTime + EditorCore 命令模式）。
4. 导出走 `@remotion/renderer` / Lambda。
5. 转写(WhisperX/AssemblyAI) + 词↔帧模型。
6. Agent 层：Claude Agent SDK + 52 工具 schema，工具 = EditorCore 命令。
7. 数据/同步：Rocicorp Zero。
8. 生成层：Seedance/Kling/ElevenLabs/Doubao/Mureka + DeepFilterNet3。

> ⚠️ 当前的模板 eval 用 `new Function` 直接执行代码串，**仅供本地验证**。上线前必须换成沙箱（这是安全关键路径）。
> ⚠️ Remotion 商用许可：≥4 人公司需买 Company License。
