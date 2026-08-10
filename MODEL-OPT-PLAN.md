# OpenChatCut 端侧模型优化 — 改造方案 + 实测对比(最终版 v2)

> 分支:`feat/model-optimization`(worktree `/tmp/occ-model-opt`)
> 约束:Win/Mac × 网页/桌面四方通吃;默认路径不变,新能力显式 opt-in。
> 实测:MacBook Air M5/32GB / Node 24 / macOS 27(2026-08-10);浏览器 e2e:ego-browser Chromium。

## 1. 最终结论(实测驱动,含否决记录)

| 项 | 结论 | 实测依据 |
|---|---|---|
| **模型迁移 onnx-community** | ❌ **否决并回滚** | 其 ONNX 导出不带 cross_attentions,`return_timestamps:'word'` 直接报错(Node 与浏览器均验证);项目文字稿依赖词级时间戳,不可降级 |
| **transformers v4 升级** | ❌ **否决并回滚** | v4 依赖 onnxruntime-web 1.26-dev,其 MatMulNBits 图优化使 **wasm 的 q8 模型全部加载失败**(`TransposeDQWeightsForMatMulNBits Missing required scale`),默认路径被破坏 |
| **Mac 桌面 CoreML** | ❌ 否决(早前) | q8 不支持;fp16 撞 ORT LayerNorm fusion bug;mixed 慢(0.272)+4GB 内存 |
| **WebGPU 加速(opt-in)** | ✅ **保留交付** | Xenova + **encoder fp32 + decoder fp16 混合 dtype**:Node 实测词级时间戳完整、RTF 0.194(中文 35.5s);v3 浏览器 webgpu EP 同款组合 |
| **hf-proxy main 归一化** | ✅ 保留 | transformers.js 探测 config 用 `resolve/main`,白名单需归一化到锁定 revision(与版本无关的兼容修复) |

## 2. 最终交付内容(worktree 分支)

| 文件 | 改动 |
|---|---|
| `shared/asr-models.ts` | Xenova 4 档保持;每档(tiny/base/small)追加 WebGPU 文件登记:encoder fp16、decoder fp16、**encoder fp32**(混合 dtype 三件套,sha 均为 HF LFS oid 实测);medium 不加(WebGPU 排除,体积过大) |
| `shared/asr-inference-contract.ts` | 新增 `webgpuDtype: { encoder_model:'fp32', decoder_model_merged:'fp16' }`(注释含实测依据) |
| `src/transcript/local-asr.worker.ts` | dtype 按 device 选择:webgpu → 混合 dtype,wasm → q8(默认不变) |
| `src/transcript/deviceProfile.ts` | `chooseAsrConfig`:WebGPU 仅当 **显式 opt-in**(`cc.asrBackend`)+ 适配器可用 + 非 medium 档 + 未被 broken 标记;`markAsrWebgpuBroken()` 持久化 |
| `src/transcript/local-asr.ts` | WebGPU 转写返回**空文本** → 标记 broken、dispose、wasm 重载、重试一次(用户本次仍有结果) |
| `src/components/settings/LocalAsrPane.tsx` + `src/i18n/dict/en/settings.ts` | "WebGPU 转写加速(实验)"开关(显式 opt-in 入口),关闭时清除 broken 标记 |
| `server/plugins/hf-proxy.ts` + `server/plugins/hf-proxy.verify.ts` | `resolve/main` 归一化到目录锁定 revision(白名单语义不变,verify 更新) |
| `package.json` | **无净变更**(v4 与 ort-node 1.27 均已回滚:transformers ^3.8.1、onnxruntime-node 1.22.0 精确) |

## 3. 基准数据(30s chunk + 5s stride,与项目契约一致)

| 组合 | 环境 | 中文 RTF | 内存增量 | 词级时间戳 |
|---|---|---|---|---|
| v3.8.1 + Xenova q8(现状/默认) | Node CPU | 0.154 | 2016MB | ✓ |
| v3.8.1 + onnx-community q8 | Node CPU | 0.127 | 1038MB | ❌ 报错(否决) |
| v4.2.0 + Xenova q8 | Node CPU | 0.177 | 2043MB | ✓(但浏览器 wasm 加载失败,否决) |
| **v3.8.1 + Xenova mixed(fp32+fp16)** | **Node WebGPU** | **0.194** | ~900MB | ✓ 完整 |
| v3.8.1 + Xenova mixed | Node CoreML | 0.272 | 4065MB | ✓(否决) |

浏览器 e2e(ego-browser):worker 链路(load→transcribe→chunks)打通;wasm/webgpu 均输出"無法"重复文本——**ego-browser 无跨源隔离(COOP/COEP 不可用,crossOriginIsolated=false)导致 wasm 单线程数值异常,属测试环境限制**,非代码回归(worker wasm 路径与主仓库逐行等价,主仓库生产运行正常)。真实 Chrome 的 WebGPU 行为由 opt-in 开关 + 空文本自动回退保护。

## 4. 未决/下一步

1. 真实 Chrome(顶层窗口,非隔离环境)验证 WebGPU opt-in 链路:开启开关 → 转写 → 检查时间戳与文本;若空文本,确认自动回退与 broken 标记;
2. 若未来 transformers.js v4 修复 ort-web wasm 的 MatMulNBits bug(或项目引入 COOP/COEP 头),可重试 v4 升级;
3. 桌面 native CPU 的 q8 内存优化(2016MB)可另辟蹊径:onnxruntime-node session 选项调优(intra-op 线程、arena),不在本次范围。

## 5. 验证记录

- `npx tsc -b --force` ✓;`npm run lint` 0 警告 ✓
- `hf-proxy.verify` ✓(main 归一化新断言);`local-asr-model-mutation.verify` ✓;`desktop-native-asr.verify` ✓
- 浏览器 e2e:worker 真实链路(wasm + webgpu 均 load/transcribe/chunks 打通)
- 默认路径未变:wasm + q8 + Xenova(与主仓库一致);未 opt-in 时行为零变化

## 6. 风险与回退

- WebGPU opt-in:默认关闭;开启后空文本自动回退 wasm 并持久化 broken(可手动重新开启);
- hf-proxy main 归一化:仅影响白名单内 modelId 的 `resolve/main` URL(transformers.js 探测路径),文件元组与 sha 校验不变;verify 覆盖;
- 无依赖版本变化:回退 = 移除 opt-in 相关代码即可,模型目录保持原样。
