import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { submitImage, type SubmitImageArgs } from '../../generate/image';
import { submitVoice, type SubmitVoiceArgs } from '../../generate/voice';
import { submitSound, type SubmitSoundArgs } from '../../generate/sound';
import { submitMusic, type SubmitMusicArgs } from '../../generate/music';
import { submitVideo, type SubmitVideoArgs } from '../../generate/video';
import { trackGenerationProgress } from '../../generate/progress';
import { submitSubtitleExport, type SubmitSubtitleExportArgs } from '../../generate/subtitles';
import { submitMediaExport, type SubmitMediaExportArgs } from '../../generate/media-export';
import { timelineToFcpxml, type NleFormat } from '../../export/fcpxml';
import { recordExport } from '../../persist/exportHistoryStore';
import {
  cacheMediaFromUrl,
  patchTrackedJob,
  registerTrackedJob,
} from '../../persist/jobRegistryStore';
import { fontFallbackGate } from './font-tools';

// ═══════════════════════════════════════════════════════════════════════════
// GPT 主攻文件 —— AI 生成套件（图 / 视频 / 配音 / 音乐 / 音效）
// ---------------------------------------------------------------------------
// 在这里注册所有「生成类」agent 工具。你只需要改这个文件 + 你新建的叶子文件
// （代理插件、库模块、面板），**不要改 tools.ts / store.ts / reduce.ts / types.ts
// / TimelineComposition.tsx / Editor.tsx（这些是 Claude 的共享脊柱）**。
//
// 接线已就绪：下面的 GENERATE_TOOL_SCHEMAS 会自动汇入 TOOL_SCHEMAS（模型可见），
// GENERATE_TOOL_NAMES 会让 executeTool 自动把这些工具路由到 execGenerateTool，
// GENERATE_WORKFLOW 会自动拼进系统提示。所以加一个工具 = 只在本文件加。
//
// 工具名（务必用原名）：
//   submit_image / submit_video / submit_voice / submit_music / submit_sound
// 落地产物到时间线：ctx.commands.addMediaItem(asset) / addAsset(asset)。
// 详细分工、接线约定、验证 playbook 见仓库根 GPT-HANDOFF.md。
// ═══════════════════════════════════════════════════════════════════════════

type Args = Record<string, unknown>;

/** half-open [start, end) frame range for the export history record (only when both known). */
function frameRangeOf(start?: number, end?: number): { start: number; end: number } | undefined {
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : undefined;
}

/** 生成类工具的 Anthropic schema。往这个数组里 push 即可（自动进模型可见工具列表）。 */
export const GENERATE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'submit_image',
    description: 'Generate one or more AI images (gpt-image-2, nano-banana, or MiniMax image-01), save them to the project media pool, and add them to the active timeline. Call only when the user explicitly requested the generation.',
    input_schema: {
      type: 'object',
      properties: {
        model: { type: 'string', enum: ['gpt-image-2', 'nano-banana', 'image-01'], description: 'gpt-image-2 is the default; nano-banana is best for reference-heavy work; image-01 is MiniMax (no reference images, at most 9 per call; actual MiniMax model from settings).' }, // minimax: image-01 enum + note
        prompt: { type: 'string', description: 'Detailed description of the image to generate.' },
        name: { type: 'string', description: 'Short descriptive asset name shown in the media pool.' },
        aspectRatio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'], description: 'Defaults to 16:9.' },
        imageSize: { type: 'string', enum: ['1K', '2K', '4K'], description: 'Defaults to 1K. Use 2K/4K only when explicitly requested. Ignored for image-01.' },
        quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: 'gpt-image-2 quality; defaults to high. Ignored for image-01.' },
        referenceAssetIds: { type: 'array', items: { type: 'string' }, maxItems: 14, description: 'Project image asset IDs used as visual references. Not supported for image-01.' },
        count: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of images; defaults to 1. image-01 max 9.' },
        promptOptimizer: { type: 'boolean', description: 'MiniMax image-01 only. prompt_optimizer; default true. Set false for more literal prompts.' },
      },
      required: ['prompt', 'name'],
    },
  },
  {
    name: 'submit_voice',
    description: 'Generate one TTS audio asset with ElevenLabs, Doubao, or MiniMax. Creates an asset only; it does not place or replace timeline items. Call only after the user has confirmed a concrete provider and voiceId.',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['elevenlabs', 'doubao', 'minimax'], description: 'elevenlabs for multilingual/non-Chinese; doubao for Chinese-optimized speech; minimax for MiniMax Chinese TTS.' }, // minimax: provider enum
        text: { type: 'string', minLength: 1, description: 'Text to synthesize.' },
        voiceId: { type: 'string', minLength: 1, description: 'Provider-specific curated preset ID or raw provider voice ID. MiniMax system voices: male-qn-qingse, male-qn-jingying, female-shaonv, female-yujie (default), female-chengshu, female-tianmei.' }, // minimax: system voice list
        modelId: { type: 'string', description: 'ElevenLabs only. Defaults to the configured current model.' },
        stability: { type: 'number', minimum: 0, maximum: 1, description: 'ElevenLabs only. Defaults to 0.5.' },
        speed: { type: 'number', minimum: 0.5, maximum: 2, description: 'ElevenLabs (0.7–1.2) or MiniMax (0.5–2). Defaults to 1.' }, // minimax: widened range, server enforces per provider
        speedRatio: { type: 'number', minimum: 0.5, maximum: 2, description: 'Doubao only. Defaults to 1.' },
        emotion: { type: 'string', description: 'Doubao or MiniMax emotion label. MiniMax accepts: happy, sad, angry, fearful, disgusted, surprised, calm, fluent, whisper.' }, // minimax: shared with doubao
        emotionScale: { type: 'number', minimum: 1, maximum: 5, description: 'Doubao only. Requires emotion.' },
        loudnessRatio: { type: 'number', minimum: 0.5, maximum: 2, description: 'Doubao only. Defaults to 1.' },
        pitch: { type: 'number', minimum: -12, maximum: 12, description: 'Doubao: post-process semitones. MiniMax: native voice_setting.pitch (-12–12).' },
        volume: { type: 'number', minimum: 0, maximum: 10, description: 'MiniMax only. voice_setting.vol (0–10). Defaults to 1.' },
        performancePrompt: { type: 'string', maxLength: 200, description: 'Doubao only. Natural-language performance direction.' },
        explicitDialect: { type: 'string', enum: ['dongbei', 'shaanxi', 'sichuan'], description: 'Doubao only; supported by the Vivi preset.' },
        name: { type: 'string', description: 'Optional media-pool asset name.' },
      },
      required: ['provider', 'text', 'voiceId'],
    },
  },
  {
    name: 'submit_sound',
    description: 'Generate one original/custom sound effect with ElevenLabs and create an audio asset in the media pool. Does not place timeline items. For ordinary whooshes, clicks, impacts, dings, and similar editing sounds, use the existing library first.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, description: 'Detailed sound description.' },
        durationSeconds: { type: 'number', minimum: 0.5, maximum: 22, description: 'Defaults to 4 seconds.' },
        promptInfluence: { type: 'number', minimum: 0, maximum: 1, description: 'Prompt adherence; defaults to 0.3.' },
        name: { type: 'string', description: 'Optional media-pool asset name.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'submit_music',
    description: 'Submit a music generation job (Mureka instrumental, MiniMax t2m with optional lyrics, or MiniMax music-cover with referenceAssetId). Creates one media-pool audio asset; does not place timeline items.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 2000, description: 'Style description. Mureka max 1024; MiniMax t2m max 2000; music-cover style prompt 10–300.' },
        provider: { type: 'string', enum: ['mureka', 'minimax'], description: 'Defaults to mureka (instrumental only). minimax: t2m or music-cover when referenceAssetId is set.' }, // minimax: optional provider
        lyrics: { type: 'string', maxLength: 3500, description: 'minimax only. Lyrics with \\n and section tags. Cover mode optional 10–1000 chars.' }, // minimax: optional lyrics
        isInstrumental: { type: 'boolean', description: 'minimax t2m only. Force instrumental (default true when no lyrics and lyricsOptimizer is false).' },
        lyricsOptimizer: { type: 'boolean', description: 'minimax t2m only. Auto-generate lyrics from prompt when lyrics empty.' },
        sampleRate: { type: 'integer', enum: [16000, 24000, 32000, 44100], description: 'minimax only. Default 44100.' },
        bitrate: { type: 'integer', enum: [32000, 64000, 128000, 256000], description: 'minimax only. Default 256000.' },
        audioFormat: { type: 'string', enum: ['mp3', 'wav', 'pcm'], description: 'minimax only. Default mp3. pcm is raw bytes the browser cannot preview/place — use it only when the user explicitly needs raw PCM.' },
        referenceAssetId: { type: 'string', description: 'minimax music-cover only. Project audio asset id to cover. Requires MINIMAX_MUSIC_MODEL music-cover or music-cover-free.' },
        name: { type: 'string', description: 'Optional media-pool asset name.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'submit_video',
    description: 'Submit a Seedance 2.0, Kling, or MiniMax Hailuo video generation job and create one video asset in the project media pool. Does not place the video on the timeline. Keep image, video, and audio references in their matching arrays.',
    input_schema: {
      type: 'object',
      properties: {
        model: { type: 'string', enum: ['seedance2', 'kling', 'hailuo'], description: 'hailuo is MiniMax: 6 or 10s; firstFrame optional; lastFrame allowed with firstFrame; no multi-ref or multi-shot. 1080p is 6s only.' }, // minimax: hailuo enum
        prompt: { type: 'string', description: 'Required for normal generation and Kling intelligence; omit for Kling customize.' },
        name: { type: 'string' },
        durationSeconds: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Integer seconds, 4–15 for Seedance, 3–15 for Kling, exactly 6 or 10 for Hailuo (Hailuo 1080p → 6 only).' }, // minimax: hailuo durations
        ratio: { type: 'string', description: 'Seedance: 16:9, 4:3, 1:1, 3:4, 9:16, 21:9, adaptive. Kling: 16:9, 9:16, 1:1. Ignored for hailuo.' },
        resolution: { type: 'string', enum: ['480p', '720p', '1080p', '4k'], description: 'Seedance: 480p/720p(default)/1080p/4k. Hailuo: 720p→API 768P, 1080p (6s only). Kling: pair with mode std/pro (no 480p/4k).' },
        mode: { type: 'string', enum: ['std', 'pro'], description: 'Kling only; std=720p, pro=1080p.' },
        firstFrame: { type: 'string', description: 'Project image asset ID, asset:// ID, short unique ID prefix, or same-project asset path.' },
        lastFrame: { type: 'string', description: 'Project image asset reference; requires firstFrame. Supported on seedance2, kling, and hailuo (not with multi-ref on seedance2).' },
        refImages: { type: 'array', items: { type: 'string' } },
        refVideos: { type: 'array', items: { type: 'string' } },
        refAudios: { type: 'array', items: { type: 'string' } },
        refVideoMode: { type: 'string', enum: ['feature', 'base'], description: 'Kling only with refVideos. feature (default)=motion/camera/style guide; base=edit that source clip (keep_original_sound).' },
        promptOptimizer: { type: 'boolean', description: 'Hailuo only. MiniMax prompt_optimizer; default true. Set false for more literal prompts.' },
        fastPretreatment: { type: 'boolean', description: 'Hailuo only. MiniMax fast_pretreatment when promptOptimizer is true; default false.' },
        multiPrompts: {
          type: 'array', minItems: 2, maxItems: 6,
          items: { type: 'object', properties: { prompt: { type: 'string' }, duration: { anyOf: [{ type: 'number' }, { type: 'string' }] }, index: { type: 'integer', minimum: 1 } }, required: ['prompt', 'duration', 'index'] },
          description: 'Kling customize storyboard; indexes start at 1 and durations sum to durationSeconds.',
        },
        shotType: { type: 'string', enum: ['customize', 'intelligence'], description: 'Kling multi-shot mode.' },
      },
      required: ['model'],
    },
  },
  {
    name: 'track_progress',
    description: 'Inspect or wait for asynchronous generation jobs returned by submit_music and submit_video. Successful results are added to the project media pool exactly once.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['params', 'status', 'wait'], description: 'params returns submitted settings, status checks immediately, wait polls until terminal or timeout.' },
        target: { type: 'string', enum: ['generation'] },
        jobIds: { type: 'string', minLength: 1, description: 'One or more comma-separated generation job IDs.' },
        assetIds: { type: 'string', description: 'Reserved; generation jobs are tracked by jobIds.' },
        timeoutSeconds: { type: 'number', minimum: 0, maximum: 3600, description: 'wait timeout; defaults to 90 seconds.' },
      },
      required: ['action', 'target', 'jobIds'],
    },
  },
  {
    name: 'submit_export',
    description: [
      'Export the active timeline synchronously as MP4/WebM video, MP3/WAV audio, SRT/TXT subtitles,',
      'or an FCPXML project (format=xml) for Premiere / Resolve / FCP.',
      'When MG/captions reference fonts the renderer cannot load, the first call returns unsupportedFonts',
      '— relay to the user and retry with confirmFontFallback=true only after they accept.',
      'For XML, pass nleFormat=fcp_xml (default, Premiere) or fcp_xml_resolve (DaVinci Resolve).',
      'Optional frame boundaries use a half-open [startFrame, endFrameExclusive) range.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['video', 'audio', 'subtitles', 'xml'] },
        codec: { type: 'string', enum: ['h264', 'vp8', 'mp3', 'wav'], description: 'Video: h264 (default) or vp8. Audio: mp3 (default) or wav.' },
        subtitleFormat: { type: 'string', enum: ['srt', 'txt'], description: 'Defaults to srt.' },
        nleFormat: {
          type: 'string',
          enum: ['fcp_xml', 'fcp_xml_resolve'],
          description: 'NLE XML format for format=xml. Defaults to fcp_xml (Premiere). Use fcp_xml_resolve for DaVinci Resolve.',
        },
        name: { type: 'string', description: 'Download filename.' },
        fps: {
          type: 'number',
          description: 'Video output fps: 24|25|30|50|60. Omit to match timeline. Frame counts stay; real duration scales.',
        },
        resolution: {
          type: 'string',
          enum: ['480p', '720p', '1080p'],
          description: 'Video max-height ladder (default timeline size). Scales width to keep aspect.',
        },
        timelineId: {
          type: 'string',
          description: 'Export a non-active timeline by id/prefix without switching (video/audio/xml).',
        },
        startFrame: { type: 'integer', minimum: 0 },
        endFrameExclusive: { type: 'integer', minimum: 1 },
        startSeconds: { type: 'number', minimum: 0, description: 'Legacy; prefer startFrame.' },
        endSeconds: { type: 'number', minimum: 0, description: 'Legacy; prefer endFrameExclusive.' },
        confirmFontFallback: {
          type: 'boolean',
          description: 'Required true when export would burn unsupported fonts. First call without it returns the unsupported list.',
        },
      },
    },
  },
];

/** 工具名集合，executeTool 用它把调用路由到这里（由上面的 schema 自动推导）。 */
export const GENERATE_TOOL_NAMES = new Set(GENERATE_TOOL_SCHEMAS.map((t) => t.name));

/** 执行一个生成类工具。返回 JSON 可序列化结果。产物落时间线走 ctx.commands.*。 */
export async function execGenerateTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  switch (name) {
    case 'submit_image': {
      try {
        const input: SubmitImageArgs = {
          model: args.model as SubmitImageArgs['model'],
          prompt: String(args.prompt ?? ''),
          name: String(args.name ?? ''),
          aspectRatio: args.aspectRatio as SubmitImageArgs['aspectRatio'],
          imageSize: args.imageSize as SubmitImageArgs['imageSize'],
          quality: args.quality as SubmitImageArgs['quality'],
          referenceAssetIds: Array.isArray(args.referenceAssetIds) ? args.referenceAssetIds.map(String) : undefined,
          count: typeof args.count === 'number' ? args.count : undefined,
          promptOptimizer: typeof args.promptOptimizer === 'boolean' ? args.promptOptimizer : undefined,
        };
        const assets = await submitImage(input, ctx.getState());
        for (const asset of assets) {
          ctx.commands.addAsset(asset);
          ctx.commands.addMediaItem(asset);
          void cacheMediaFromUrl(asset.src, asset.name);
        }
        return {
          ok: true,
          model: input.model ?? 'gpt-image-2',
          generated: assets.map((asset) => ({ assetId: asset.id, name: asset.name, src: asset.src, width: asset.width, height: asset.height })),
          addedTo: 'media-pool-and-proposed-timeline',
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    case 'submit_voice': {
      try {
        const input: SubmitVoiceArgs = {
          provider: args.provider as SubmitVoiceArgs['provider'],
          text: String(args.text ?? ''),
          voiceId: String(args.voiceId ?? ''),
          modelId: typeof args.modelId === 'string' ? args.modelId : undefined,
          stability: typeof args.stability === 'number' ? args.stability : undefined,
          speed: typeof args.speed === 'number' ? args.speed : undefined,
          speedRatio: typeof args.speedRatio === 'number' ? args.speedRatio : undefined,
          emotion: typeof args.emotion === 'string' ? args.emotion : undefined,
          emotionScale: typeof args.emotionScale === 'number' ? args.emotionScale : undefined,
          loudnessRatio: typeof args.loudnessRatio === 'number' ? args.loudnessRatio : undefined,
          pitch: typeof args.pitch === 'number' ? args.pitch : undefined,
          volume: typeof args.volume === 'number' ? args.volume : undefined,
          performancePrompt: typeof args.performancePrompt === 'string' ? args.performancePrompt : undefined,
          explicitDialect: args.explicitDialect as SubmitVoiceArgs['explicitDialect'],
          name: typeof args.name === 'string' ? args.name : undefined,
        };
        const asset = await submitVoice(input, ctx.getState());
        ctx.commands.addAsset(asset);
        void cacheMediaFromUrl(asset.src, asset.name);
        return { ok: true, provider: input.provider, voiceId: input.voiceId, assetId: asset.id, name: asset.name, src: asset.src, addedTo: 'media-pool' };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    case 'submit_sound': {
      try {
        const input: SubmitSoundArgs = {
          prompt: String(args.prompt ?? ''),
          durationSeconds: typeof args.durationSeconds === 'number' ? args.durationSeconds : undefined,
          promptInfluence: typeof args.promptInfluence === 'number' ? args.promptInfluence : undefined,
          name: typeof args.name === 'string' ? args.name : undefined,
        };
        const asset = await submitSound(input, ctx.getState());
        ctx.commands.addAsset(asset);
        void cacheMediaFromUrl(asset.src, asset.name);
        return { ok: true, assetId: asset.id, name: asset.name, src: asset.src, durationInFrames: asset.durationInFrames, addedTo: 'media-pool' };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    case 'submit_music': {
      try {
        const input: SubmitMusicArgs = {
          prompt: String(args.prompt ?? ''),
          name: typeof args.name === 'string' ? args.name : undefined,
          provider: args.provider === 'mureka' || args.provider === 'minimax' ? args.provider : undefined, // minimax: optional provider
          lyrics: typeof args.lyrics === 'string' ? args.lyrics : undefined, // minimax: optional lyrics
          isInstrumental: typeof args.isInstrumental === 'boolean' ? args.isInstrumental : undefined,
          lyricsOptimizer: typeof args.lyricsOptimizer === 'boolean' ? args.lyricsOptimizer : undefined,
          sampleRate: typeof args.sampleRate === 'number' ? args.sampleRate : undefined,
          bitrate: typeof args.bitrate === 'number' ? args.bitrate : undefined,
          audioFormat: args.audioFormat === 'mp3' || args.audioFormat === 'wav' || args.audioFormat === 'pcm' ? args.audioFormat : undefined,
          referenceAssetId: typeof args.referenceAssetId === 'string' ? args.referenceAssetId : undefined,
        };
        // Cover mode needs project assets; pass state when available.
        const submission = await submitMusic(input, ctx.getState());
        const projectId = ctx.getProjectId?.();
        if (projectId) {
          void registerTrackedJob({
            jobId: submission.jobId,
            projectId,
            kind: 'generation',
            label: input.name || input.prompt.slice(0, 80),
            status: submission.status,
            params: { tool: 'submit_music', prompt: input.prompt, provider: input.provider },
          });
        }
        return { ok: true, ...submission, next: `Call track_progress with target=generation and jobIds=${submission.jobId}.` };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    case 'submit_video': {
      try {
        const input: SubmitVideoArgs = {
          model: args.model as SubmitVideoArgs['model'],
          prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
          name: typeof args.name === 'string' ? args.name : undefined,
          durationSeconds: typeof args.durationSeconds === 'number' || typeof args.durationSeconds === 'string' ? args.durationSeconds : undefined,
          ratio: typeof args.ratio === 'string' ? args.ratio : undefined,
          resolution: args.resolution as SubmitVideoArgs['resolution'],
          mode: args.mode as SubmitVideoArgs['mode'],
          firstFrame: typeof args.firstFrame === 'string' ? args.firstFrame : undefined,
          lastFrame: typeof args.lastFrame === 'string' ? args.lastFrame : undefined,
          refImages: Array.isArray(args.refImages) ? args.refImages.map(String) : undefined,
          refVideos: Array.isArray(args.refVideos) ? args.refVideos.map(String) : undefined,
          refAudios: Array.isArray(args.refAudios) ? args.refAudios.map(String) : undefined,
          refVideoMode: args.refVideoMode === 'base' || args.refVideoMode === 'feature' ? args.refVideoMode : undefined,
          promptOptimizer: typeof args.promptOptimizer === 'boolean' ? args.promptOptimizer : undefined,
          fastPretreatment: typeof args.fastPretreatment === 'boolean' ? args.fastPretreatment : undefined,
          multiPrompts: Array.isArray(args.multiPrompts) ? args.multiPrompts as SubmitVideoArgs['multiPrompts'] : undefined,
          shotType: args.shotType as SubmitVideoArgs['shotType'],
        };
        const submission = await submitVideo(input, ctx.getState());
        const projectId = ctx.getProjectId?.();
        if (projectId) {
          void registerTrackedJob({
            jobId: submission.jobId,
            projectId,
            kind: 'generation',
            label: input.name || input.prompt?.slice(0, 80) || input.model,
            status: submission.status,
            params: { tool: 'submit_video', model: input.model, prompt: input.prompt },
          });
        }
        return { ok: true, model: input.model, ...submission, next: `Call track_progress with target=generation and jobIds=${submission.jobId}.` };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    case 'track_progress': {
      try {
        if (args.target !== 'generation') return { error: 'this local track_progress implementation currently supports target=generation only' };
        const action = args.action as 'params' | 'status' | 'wait';
        if (!['params', 'status', 'wait'].includes(action)) return { error: 'action must be params, status, or wait' };
        const jobIds = String(args.jobIds ?? '').split(',').map((id) => id.trim()).filter(Boolean);
        const projectId = ctx.getProjectId?.();
        // Ensure every polled id is registered (e.g. resumed after refresh from chat text).
        if (projectId) {
          for (const jobId of jobIds) {
            void registerTrackedJob({ jobId, projectId, kind: 'generation', status: 'running' });
          }
        }
        const result = await trackGenerationProgress({
          action,
          jobIds,
          timeoutSeconds: typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined,
        }, ctx.getState());
        if (projectId) {
          for (const report of result.reports) {
            void patchTrackedJob(projectId, report.jobId, {
              status: report.status,
              error: report.error,
              resultPath: report.result?.path,
              resultAssetId: report.result?.assetId,
            });
          }
        }
        for (const asset of result.completedAssets) {
          ctx.commands.addAsset(asset);
          void cacheMediaFromUrl(asset.src, asset.name);
        }
        return {
          ok: true,
          target: 'generation',
          action,
          reports: result.reports,
          addedAssets: result.completedAssets.map((asset) => ({ assetId: asset.id, name: asset.name, src: asset.src, kind: asset.kind })),
          addedTo: result.completedAssets.length ? 'media-pool' : undefined,
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    case 'submit_export': {
      try {
        const format = args.format ?? 'video';
        let state = ctx.getState();
        // Optional non-active timeline export
        if (typeof args.timelineId === 'string' && args.timelineId.trim()) {
          const q = args.timelineId.trim();
          const tl = ctx.getDoc().timelines.find((t) => t.id === q || t.id.startsWith(q));
          if (!tl) return { error: `timeline not found: ${args.timelineId}` };
          state = tl;
        }
        // Font gate for video burn-in and XML handoff (MG/caption families).
        if (format === 'video' || format === 'xml') {
          const gate = fontFallbackGate(state, args.confirmFontFallback, {
            captions: state.captions ?? null,
          });
          if (gate) return gate;
        }
        if (format === 'subtitles') {
          const input: SubmitSubtitleExportArgs = {
            subtitleFormat: args.subtitleFormat as SubmitSubtitleExportArgs['subtitleFormat'],
            name: typeof args.name === 'string' ? args.name : undefined,
            startFrame: typeof args.startFrame === 'number' ? args.startFrame : undefined,
            endFrameExclusive: typeof args.endFrameExclusive === 'number' ? args.endFrameExclusive : undefined,
            startSeconds: typeof args.startSeconds === 'number' ? args.startSeconds : undefined,
            endSeconds: typeof args.endSeconds === 'number' ? args.endSeconds : undefined,
          };
          const result = await submitSubtitleExport(input, state);
          void recordExport({
            name: result.name ?? `subtitles.${input.subtitleFormat ?? 'srt'}`,
            format: 'subtitles',
            frameRange: frameRangeOf(input.startFrame, input.endFrameExclusive),
            createdAt: Date.now(),
          });
          return { ok: true, ...result };
        }
        if (format === 'audio' || format === 'video') {
          const fpsArg = typeof args.fps === 'number' ? args.fps : undefined;
          if (fpsArg != null && ![24, 25, 30, 50, 60].includes(fpsArg)) {
            return { error: 'fps must be one of 24, 25, 30, 50, 60' };
          }
          const resolution = args.resolution === '480p' || args.resolution === '720p' || args.resolution === '1080p'
            ? args.resolution
            : undefined;
          const input: SubmitMediaExportArgs = {
            format,
            codec: args.codec as SubmitMediaExportArgs['codec'],
            name: typeof args.name === 'string' ? args.name : undefined,
            startFrame: typeof args.startFrame === 'number' ? args.startFrame : undefined,
            endFrameExclusive: typeof args.endFrameExclusive === 'number' ? args.endFrameExclusive : undefined,
            startSeconds: typeof args.startSeconds === 'number' ? args.startSeconds : undefined,
            endSeconds: typeof args.endSeconds === 'number' ? args.endSeconds : undefined,
            fps: fpsArg,
            resolution,
          };
          const result = await submitMediaExport(input, state);
          void recordExport({
            name: result.name,
            format: result.format,
            codec: result.codec,
            sizeBytes: result.sizeBytes,
            frameRange: frameRangeOf(result.startFrame, result.endFrameExclusive),
            createdAt: Date.now(),
          });
          return { ok: true, ...result };
        }
        if (format === 'xml') {
          // FCPXML：纯序列化（fcpxml.ts）+ 客户端 blob 下载（无需渲染，秒出）。
          const nleFormat: NleFormat = args.nleFormat === 'fcp_xml_resolve' ? 'fcp_xml_resolve' : 'fcp_xml';
          const xml = timelineToFcpxml(state, {
            title: typeof args.name === 'string' ? args.name : undefined,
            nleFormat,
          });
          const base = (typeof args.name === 'string' && args.name ? args.name : 'timeline').replace(/\.(?:fcpxml|xml)$/i, '');
          const filename = `${base}.fcpxml`;
          const blob = new Blob([xml], { type: 'application/xml' });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = filename; // JS 字符串，中文安全
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(url);
          void recordExport({ name: filename, format: 'xml', sizeBytes: blob.size, createdAt: Date.now() });
          return { ok: true, format: 'xml', nleFormat, name: filename, sizeBytes: blob.size };
        }
        return { error: 'format must be video, audio, subtitles, or xml' };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    default:
      return { error: `generate tool not implemented: ${name}` };
  }
}

/** 系统提示里的「生成工作流」说明段（自动拼进 SYSTEM_PROMPT）。填你的工具用法指引。 */
export const GENERATE_WORKFLOW = `
## AI image generation
- Use submit_image only after the user explicitly asks to generate an image.
- Default model gpt-image-2; use nano-banana for reference-heavy work; image-01 (MiniMax) for stills without references (prompt ≤1500 chars, count ≤9, no referenceAssetIds; optional promptOptimizer).
- Always provide a short descriptive name. Default aspectRatio 16:9, imageSize 1K, quality high, and count 1 (imageSize/quality are gpt-image-2-oriented).
- If the project is not 16:9, ask for the desired aspect ratio. Never upgrade to 2K/4K unless the user explicitly requests it.
- Pass project image asset IDs through referenceAssetIds; never fetch reference bytes yourself.
- Generated images are saved to the media pool and placed on the active timeline.

## TTS voice generation
- Use submit_voice only for an explicitly requested TTS generation after the user has confirmed a concrete provider and voiceId.
- Providers: doubao (Chinese-optimized), elevenlabs (English/multilingual), minimax (when configured). Never mix voice catalogs across providers.
- MiniMax supports speed (0.5–2), pitch (-12–12), volume (0–10), and emotion natively. Doubao pitch is post-process; emotionScale/performancePrompt are Doubao-only.
- Curated Doubao examples include vivi, xiaohe, yunzhou, dayi, liuchang, and morgan. Curated ElevenLabs examples include amelia, hope, peter, james, and sully. MiniMax examples include female-yujie, male-qn-qingse.
- Voice samples are available at /voice-samples/<provider>-<voiceId>.mp3 when bundled. If the user has not chosen a concrete voice, offer a few matching samples before generating.
- submit_voice creates one media-pool audio asset only. Do not claim it was placed on the timeline.
- Only call providers whose keys are configured (capabilities prompt).

## Sound-effect generation
- Use submit_sound only after the user explicitly requests a new/original/custom sound, or when the existing sound-effects library has no suitable result.
- For ordinary whoosh, riser, impact, notification, click, ding, censor beep, record scratch, shutter, typing, or reaction sounds, use the existing library first.
- Default to 4 seconds and promptInfluence 0.3. submit_sound creates one media-pool audio asset only and does not place it on the timeline.

## Music generation
- Use submit_music only after the user explicitly requests newly generated music; it starts an asynchronous generation job (Mureka or MiniMax).
- Default provider mureka (instrumental). Use minimax for vocals/lyrics or cover. MiniMax t2m: lyrics, lyricsOptimizer, isInstrumental, sampleRate/bitrate/audioFormat. MiniMax cover: referenceAssetId + style prompt (10–300); set MINIMAX_MUSIC_MODEL to music-cover.
- Describe the style, mood, instrumentation, and intended edit context in prompt. Do not silently request extra variants.
- submit_music returns immediately with a jobId. Call track_progress target=generation with action=status or action=wait; only a successful tracked result creates the media-pool audio asset.

## Video generation
- Use submit_video only after an explicit video-generation request. Default to seedance2 when configured, 5 seconds, 16:9, and 720p; never silently add variants, duration, or quality.
- Seedance supports 4–15 seconds, resolution 480p/720p(default)/1080p/4k, and typed image/video/audio references. Kling supports 3–15 seconds, std/pro, images (≤7, or ≤4 with one refVideo), refVideoMode feature|base, customize/intelligence multi-shot; use @ImageN/@Video1 in prompts. Hailuo supports 6 or 10 seconds (1080p → 6 only), firstFrame/lastFrame, optional promptOptimizer/fastPretreatment, or S2V-01 subject-reference via firstFrame when that model is selected; no multi-ref multi-shot.
- References must be project asset IDs and must stay in refImages/refVideos/refAudios by media type. lastFrame requires firstFrame.
- For Kling customize, omit top-level prompt; use 2–6 consecutive multiPrompts whose integer durations sum to durationSeconds.
- submit_video returns immediately with a jobId. Call track_progress target=generation with action=status or action=wait; only a successful tracked result creates the media-pool video asset.

## Generation job progress
- Use track_progress only with target=generation for submit_music/submit_video job IDs. action=params reads submitted settings, status is non-blocking, and wait is explicitly bounded by timeoutSeconds.
- Do not claim a generated asset exists until track_progress reports succeeded and addedAssets includes it. Retrying track_progress is idempotent and never duplicates an existing asset.

## Export
- Use submit_export with format=video for MP4/WebM, format=audio for MP3/WAV, format=subtitles for SRT/TXT, or format=xml for FCPXML (nleFormat fcp_xml|fcp_xml_resolve). codec defaults to h264 for video and mp3 for audio; subtitleFormat defaults to srt.
- Prefer startFrame/endFrameExclusive for partial exports. The range is half-open, export is synchronous, and it does not change the timeline.
- If submit_export returns unsupportedFonts, use search_fonts for alternatives or ask the user, then retry with confirmFontFallback=true only after they accept fallback.
`;
