// Media probes that are not a plain authenticated GET.
//
// Fal exposes no authenticated read-only endpoint: the queue API needs a request
// id from a billable submit, and the public model list is gone (rest.alpha.fal.ai
// /models → 404 for any key). The probe therefore reports key presence and says
// so instead of spending credits. Local Whisper is answered from disk: the
// whisper-cli binary plus at least one downloaded model tier.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ASR_MODELS } from '../shared/asr-models.ts';
import { resolveGgmlPath } from '../shared/asr-ggml-cache.ts';
import { whisperCliBin } from './media-binaries.ts';
import { modelCacheDir } from './plugins/hf-proxy.ts';
import type { ProbeDef } from './key-probes.ts';

interface LocalVerdict { ok: boolean; note?: string; error?: string }

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });

/** Fal: key presence only — an authenticated read-only call does not exist. */
export const falProbe: ProbeDef = {
  needs: [['FAL_KEY']],
  run: async () => jsonResponse({ ok: true }),
  okText: () => 'FAL_KEY 已配置 · Fal 无只读鉴权端点，未发起生成请求（不会计费）',
};

async function fileReady(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/** Local Whisper readiness: binary + at least one downloaded tier (ONNX or GGML). */
export async function inspectLocalAsr(): Promise<LocalVerdict> {
  const cache = modelCacheDir();
  const binaryReady = await fileReady(whisperCliBin());
  const tiers: string[] = [];
  for (const entry of ASR_MODELS) {
    const onnx = await fileReady(join(cache, entry.modelId, ...entry.files[0]!.path.split('/')));
    const ggml = entry.ggmlFile ? await fileReady(resolveGgmlPath(cache, entry.ggmlFile.fileName)) : false;
    if (onnx || ggml) tiers.push(entry.id);
  }
  if (tiers.length === 0) {
    return {
      ok: false,
      error: `本地模型未下载 · 请在 本地模型 → 本地转写 下载（缓存目录 ${cache}）`,
    };
  }
  const engine = binaryReady ? 'whisper-cli 已就绪' : 'whisper-cli 未找到（浏览器端 ONNX 仍可用）';
  return { ok: true, note: `本地转写可用 · ${engine} · 已下载模型:${tiers.join(', ')}` };
}

export const localAsrProbe: ProbeDef = {
  // Always testable: an empty group means "the default local engine", legal unset.
  needs: [[]],
  run: async () => jsonResponse(await inspectLocalAsr()),
  postCheck: (bodyText) => {
    try {
      const body = JSON.parse(bodyText) as LocalVerdict;
      return body.ok ? null : (body.error ?? '本地转写检查失败');
    } catch {
      return null;
    }
  },
  okText: (bodyText) => {
    try {
      return (JSON.parse(bodyText) as LocalVerdict).note ?? null;
    } catch {
      return null;
    }
  },
};
