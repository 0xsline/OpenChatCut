# OpenChatCut 端侧模型优化 — 改造方案 + 实测对比(最终版)

> 分支:`feat/model-optimization`(worktree `/tmp/occ-model-opt`)
> 约束:Win/Mac × 网页/桌面四方通吃;默认路径不变,新能力按需启用。
> 所有数据实测于 MacBook Air M5 / 32GB / Node 24 / macOS 27(2026-08-10)。

## 1. 实测方法(公平性说明)

- 音频:macOS `say` 生成 16k 单声道 wav,中文 35.49s / 英文 26.54s;
- 推理契约与项目一致:`chunk_length_s=30, stride_length_s=5`(`ASR_INFERENCE_CONTRACT`);
- **关键修正**:不带 chunking 时 v3 的 decoder 会在 max_length 截断(35.5s 音频只转写出前半段,RTF 虚低 4 倍)。两版均按项目真实契约分块后对比;
- 模型文件经 HF 官方源(代理)下载,sha256 与项目目录校验逻辑一致;
- 指标:loadMs(加载)、RTF(转写耗时/音频时长)、RSS 增量、转写文本质量。

## 2. 实测对比表(核心交付)

| # | 组合 | 后端 | 中文 RTF | 英文 RTF | 内存增量 | 文本 |
|---|---|---|---|---|---|---|
| A0 | **改造前现状**:v3.8.1 + `Xenova/whisper-base` q8 | CPU | **0.154** | — | **2016MB** | ✓ |
| A1 | v3.8.1 + `onnx-community/whisper-base` q8 | CPU | **0.127** | — | **1038MB** | ✓ 与 A0 逐字一致 |
| B1 | v4.2.0 + onnx-community q8(回归) | CPU | 0.177 | — | 1057MB | ✓ |
| B2 | v4.2.0 + mixed(enc fp32 + dec q8) | CPU | — | 0.084 | 1075MB | ✓ |
| B3 | **v4.2.0 + mixed(enc fp32 + dec fp16)** | **WebGPU** | **0.092** | **0.032** | 943MB | ✓ 中英均完整 |
| B4 | v4.2.0 + mixed(enc fp32 + dec q8) | CoreML | 0.272 | — | 4065MB | ✓(不可用,见 §4) |

### 结论
1. **模型迁移(onnx-community)是确定性收益**:同 v3 CPU 下 **RTF -18%、内存 -48%**,文本逐字一致;
2. **WebGPU 混合 dtype(enc fp32 + dec fp16)是当前最优配置**:中文 RTF 0.092(较现状 1.7×)、英文 0.032;文本完整;
3. v4 的 CPU 路径较 v3 有小幅退化(q8:0.127→0.177),需路由权衡;
4. WebGPU 陷阱(实测):encoder 用 fp16 会产出**空文本**;decoder 用 fp16 则正常 → 必须 enc fp32 + dec fp16。

## 3. 已实施改动(worktree 分支)

| 文件 | 改动 | 理由 |
|---|---|---|
| `shared/asr-models.ts` | tiny/base/small → `onnx-community/whisper-*`(新 revision + 全部 size/sha256 实测值);**medium 保留 Xenova**(onnx-community medium 在 HF 401 不可达,且兼容已下载数据) | 单一真源;hf-proxy 白名单自动放行;旧 Xenova 缓存不删除 |
| `package.json` | `@huggingface/transformers` ^3.8.1 → ^4.2.0;`onnxruntime-node` 1.22.0 → 1.27.0 | v4 解锁 WebGPU/CoreML/WebNN;1.27 含 CoreML/WebGPU EP 修复 |
| `scripts/bench/local-model-bench.mjs` | 新增基准脚本(不入主流程) | 可复现矩阵测试 |

## 4. 实测否决的选项(避免踩坑)

- **CoreML(Mac 桌面)不启用,回滚**:q8(int8)不被 CoreML EP 支持;fp16 撞 onnxruntime LayerNorm fusion bug(`InsertedPrecisionFreeCast_...SimplifiedLayerNormFusion`);mixed 组合慢(0.272)且内存 4GB。**结论:Mac 桌面 ASR 保持 native-cpu**(与现状一致,改动已回滚);
- **WebGPU + q8/int8 全量**:不可用(WebGPU 不支持 int8 路径);
- **WebGPU + encoder fp16**:空文本,不可用。

## 5. 下一步(未在本轮交付,需浏览器 e2e)

1. **浏览器 WebGPU 路由**:`deviceProfile.ts` 的 `chooseAsrConfig` 增加 WebGPU 分支(仅 onnx-community + mixed dtype + A/B 通过才启用),默认仍 wasm(现状);
2. `shared/asr-models.ts` 需登记 fp16 文件(encoder fp16 41MB / decoder fp16 105MB)供浏览器经 hf-proxy 下载;当前目录只含 q8 契约文件;
3. 浏览器 e2e:起 dev server(带 token)验证网页端 wasm/webgpu 真实转写链路。

## 6. 验证记录

- `npx tsc -b --force` ✓
- `npm run lint`(oxlint)0 警告 ✓
- `tsx src/components/settings/local-asr-model-mutation.verify.ts` ✓(renderer credential forwarded)
- `tsx src/transcript/desktop-native-asr.verify.ts` ✓(opt-in success and browser fallback contracts OK)
- 基准脚本:主仓库(v3 基线)与 worktree(v4)同一脚本、同一音频、同一契约

## 7. 风险与回退

- 模型迁移:目录是单一真源,回退 = 恢复 `Xenova/whisper-*` 一条 diff;旧缓存文件未被删除;
- v4 升级:6 个 transformers 调用点 API 已审计兼容;回退 = package.json 单文件 revert;
- CPU 小幅退化(0.127→0.177):换取 WebGPU 能力,路由层按设备选择;
- 浏览器 wasm 默认路径不变:未启用 WebGPU 前,浏览器行为与 v3 一致。
