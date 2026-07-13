# chatcut-clone 工程规范

复刻 ChatCut(对话式 AI 视频编辑器)。目标:后期可维护。以下为**硬约束**。

## 文件与模块

- **单个源文件 ≤ 500 行(硬上限)**。逼近 400 行就拆。生成/数据文件(如 `chatcut-templates.json`)豁免。
- **函数 < 50 行**;嵌套 < 4 层。
- 多而小 > 少而大;高内聚、低耦合;**按领域/功能分目录,不按类型分**。
- 一个文件一个清晰职责;跨文件用显式导出的类型/接口连接。

## 目录职责(单一真源)

| 目录 | 职责 |
|---|---|
| `src/editor/` | 时间线状态与命令(EditorCore)。`store.ts`=useEditor(reducer+undo/redo);`types.ts`=领域类型;`TimelineComposition.tsx`=整条时间线→Remotion。**不含 UI、不含 LLM。** |
| `src/agent/` | 对话 Agent。`client.ts`=Anthropic client+MODEL(唯一改模型处);`runtime.ts`=tool_use 循环;`tools.ts`=工具 schema+executeTool;`systemPrompt.ts`;`useAgent.ts`=React 绑定。**只经 EditorCore 命令改状态。** |
| `src/components/` | 纯展示/交互组件。props 进、回调出,不直接持有业务逻辑。 |
| `src/template-host.ts` | 模板编译+沙箱(安全关键)。改这里必跑 `scripts/check-sandbox.mjs`。 |
| `src/theme.ts` `src/types.ts` | 设计 token / 共享类型。 |

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
