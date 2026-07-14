import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import { submitImage, type SubmitImageArgs } from '../generate/image';
import { submitVoice, type SubmitVoiceArgs } from '../generate/voice';
import { submitSound, type SubmitSoundArgs } from '../generate/sound';
import { submitMusic, type SubmitMusicArgs } from '../generate/music';
import { submitVideo, type SubmitVideoArgs } from '../generate/video';
import { trackGenerationProgress } from '../generate/progress';
import { submitSubtitleExport, type SubmitSubtitleExportArgs } from '../generate/subtitles';
import { submitMediaExport, type SubmitMediaExportArgs } from '../generate/media-export';

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
// 源站真名（务必用原名，见 chatcut-reverse/复刻规格-Agent工具与后端.md）：
//   submit_image / submit_video / submit_voice / submit_music / submit_sound
// 落地产物到时间线：ctx.commands.addMediaItem(asset) / addAsset(asset)。
// 详细分工、接线约定、验证 playbook 见仓库根 GPT-HANDOFF.md。
// ═══════════════════════════════════════════════════════════════════════════

type Args = Record<string, unknown>;

/** 生成类工具的 Anthropic schema。往这个数组里 push 即可（自动进模型可见工具列表）。 */
export const GENERATE_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'submit_image',
    description: 'Generate one or more AI images, save them to the project media pool, and add them to the active timeline. This spends generation credits; call only when the user explicitly requested the generation.',
    input_schema: {
      type: 'object',
      properties: {
        model: { type: 'string', enum: ['gpt-image-2', 'nano-banana'], description: 'gpt-image-2 is the default; nano-banana is best for reference-heavy work.' },
        prompt: { type: 'string', description: 'Detailed description of the image to generate.' },
        name: { type: 'string', description: 'Short descriptive asset name shown in the media pool.' },
        aspectRatio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'], description: 'Defaults to 16:9.' },
        imageSize: { type: 'string', enum: ['1K', '2K', '4K'], description: 'Defaults to 1K. Use 2K/4K only when explicitly requested.' },
        quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: 'gpt-image-2 quality; defaults to high.' },
        referenceAssetIds: { type: 'array', items: { type: 'string' }, maxItems: 14, description: 'Project image asset IDs used as visual references.' },
        count: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of images; defaults to 1.' },
      },
      required: ['prompt', 'name'],
    },
  },
  {
    name: 'submit_voice',
    description: 'Generate one TTS audio asset. This spends generation credits and creates an asset only; it does not place or replace timeline items. Call only after the user has confirmed a concrete provider and voiceId.',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['elevenlabs', 'doubao'], description: 'elevenlabs for multilingual/non-Chinese; doubao for Chinese-optimized speech.' },
        text: { type: 'string', minLength: 1, description: 'Text to synthesize.' },
        voiceId: { type: 'string', minLength: 1, description: 'Provider-specific curated preset ID or raw provider voice ID.' },
        modelId: { type: 'string', description: 'ElevenLabs only. Defaults to the configured current model.' },
        stability: { type: 'number', minimum: 0, maximum: 1, description: 'ElevenLabs only. Defaults to 0.5.' },
        speed: { type: 'number', minimum: 0.7, maximum: 1.2, description: 'ElevenLabs only. Defaults to 1.' },
        speedRatio: { type: 'number', minimum: 0.5, maximum: 2, description: 'Doubao only. Defaults to 1.' },
        emotion: { type: 'string', description: 'Doubao only. Provider emotion label for a voice that supports it.' },
        emotionScale: { type: 'number', minimum: 1, maximum: 5, description: 'Doubao only. Requires emotion.' },
        loudnessRatio: { type: 'number', minimum: 0.5, maximum: 2, description: 'Doubao only. Defaults to 1.' },
        pitch: { type: 'number', minimum: -12, maximum: 12, description: 'Doubao only. Post-process pitch shift in semitones.' },
        performancePrompt: { type: 'string', maxLength: 200, description: 'Doubao only. Natural-language performance direction.' },
        explicitDialect: { type: 'string', enum: ['dongbei', 'shaanxi', 'sichuan'], description: 'Doubao only; supported by the Vivi preset.' },
        name: { type: 'string', description: 'Optional media-pool asset name.' },
      },
      required: ['provider', 'text', 'voiceId'],
    },
  },
  {
    name: 'submit_sound',
    description: 'Generate one original/custom sound effect with ElevenLabs and create an audio asset in the media pool. This spends generation credits and does not place timeline items. For ordinary whooshes, clicks, impacts, dings, and similar editing sounds, use the existing library first.',
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
    description: 'Submit an instrumental music generation job and create one audio asset in the project media pool. This spends generation credits and does not place or replace timeline items.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 1024, description: 'Style description, for example "Upbeat electronic for a tech intro".' },
        name: { type: 'string', description: 'Optional media-pool asset name.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'submit_video',
    description: 'Submit a Seedance 2.0 or Kling video generation job and create one video asset in the project media pool. This spends generation credits and does not place the video on the timeline. Keep image, video, and audio references in their matching arrays.',
    input_schema: {
      type: 'object',
      properties: {
        model: { type: 'string', enum: ['seedance2', 'kling'] },
        prompt: { type: 'string', description: 'Required for normal generation and Kling intelligence; omit for Kling customize.' },
        name: { type: 'string' },
        durationSeconds: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Integer seconds, 4–15 for Seedance and 3–15 for Kling.' },
        ratio: { type: 'string', description: 'Seedance: 16:9, 4:3, 1:1, 3:4, 9:16, 21:9, adaptive. Kling: 16:9, 9:16, 1:1.' },
        resolution: { type: 'string', enum: ['720p', '1080p'] },
        mode: { type: 'string', enum: ['std', 'pro'], description: 'Kling only; std=720p, pro=1080p.' },
        firstFrame: { type: 'string', description: 'Project image asset ID, asset:// ID, short unique ID prefix, or same-project asset path.' },
        lastFrame: { type: 'string', description: 'Project image asset reference; requires firstFrame.' },
        refImages: { type: 'array', items: { type: 'string' } },
        refVideos: { type: 'array', items: { type: 'string' } },
        refAudios: { type: 'array', items: { type: 'string' } },
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
        assetIds: { type: 'string', description: 'Reserved for source compatibility; generation jobs are tracked by jobIds.' },
        timeoutSeconds: { type: 'number', minimum: 0, maximum: 3600, description: 'wait timeout; defaults to 90 seconds.' },
      },
      required: ['action', 'target', 'jobIds'],
    },
  },
  {
    name: 'submit_export',
    description: 'Export the active timeline synchronously as MP4/WebM video, MP3/WAV audio, or SRT/TXT subtitles. Optional frame boundaries use a half-open [startFrame, endFrameExclusive) range.',
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['video', 'audio', 'subtitles'] },
        codec: { type: 'string', enum: ['h264', 'vp8', 'mp3', 'wav'], description: 'Video: h264 (default) or vp8. Audio: mp3 (source default) or local WAV extension.' },
        subtitleFormat: { type: 'string', enum: ['srt', 'txt'], description: 'Defaults to srt.' },
        name: { type: 'string', description: 'Download filename.' },
        startFrame: { type: 'integer', minimum: 0 },
        endFrameExclusive: { type: 'integer', minimum: 1 },
        startSeconds: { type: 'number', minimum: 0, description: 'Legacy; prefer startFrame.' },
        endSeconds: { type: 'number', minimum: 0, description: 'Legacy; prefer endFrameExclusive.' },
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
        };
        const assets = await submitImage(input, ctx.getState());
        for (const asset of assets) {
          ctx.commands.addAsset(asset);
          ctx.commands.addMediaItem(asset);
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
          performancePrompt: typeof args.performancePrompt === 'string' ? args.performancePrompt : undefined,
          explicitDialect: args.explicitDialect as SubmitVoiceArgs['explicitDialect'],
          name: typeof args.name === 'string' ? args.name : undefined,
        };
        const asset = await submitVoice(input, ctx.getState());
        ctx.commands.addAsset(asset);
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
        };
        const submission = await submitMusic(input);
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
          multiPrompts: Array.isArray(args.multiPrompts) ? args.multiPrompts as SubmitVideoArgs['multiPrompts'] : undefined,
          shotType: args.shotType as SubmitVideoArgs['shotType'],
        };
        const submission = await submitVideo(input, ctx.getState());
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
        const result = await trackGenerationProgress({
          action,
          jobIds,
          timeoutSeconds: typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined,
        }, ctx.getState());
        for (const asset of result.completedAssets) ctx.commands.addAsset(asset);
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
        if (format === 'subtitles') {
          const input: SubmitSubtitleExportArgs = {
            subtitleFormat: args.subtitleFormat as SubmitSubtitleExportArgs['subtitleFormat'],
            name: typeof args.name === 'string' ? args.name : undefined,
            startFrame: typeof args.startFrame === 'number' ? args.startFrame : undefined,
            endFrameExclusive: typeof args.endFrameExclusive === 'number' ? args.endFrameExclusive : undefined,
            startSeconds: typeof args.startSeconds === 'number' ? args.startSeconds : undefined,
            endSeconds: typeof args.endSeconds === 'number' ? args.endSeconds : undefined,
          };
          return { ok: true, ...await submitSubtitleExport(input, ctx.getState()) };
        }
        if (format === 'audio' || format === 'video') {
          const input: SubmitMediaExportArgs = {
            format,
            codec: args.codec as SubmitMediaExportArgs['codec'],
            name: typeof args.name === 'string' ? args.name : undefined,
            startFrame: typeof args.startFrame === 'number' ? args.startFrame : undefined,
            endFrameExclusive: typeof args.endFrameExclusive === 'number' ? args.endFrameExclusive : undefined,
            startSeconds: typeof args.startSeconds === 'number' ? args.startSeconds : undefined,
            endSeconds: typeof args.endSeconds === 'number' ? args.endSeconds : undefined,
          };
          return { ok: true, ...await submitMediaExport(input, ctx.getState()) };
        }
        return { error: 'format must be video, audio, or subtitles' };
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
- Use submit_image only after the user explicitly asks to generate an image; generation spends credits.
- Always provide a short descriptive name. Default to model gpt-image-2, aspectRatio 16:9, imageSize 1K, quality high, and count 1.
- If the project is not 16:9, ask for the desired aspect ratio. Never upgrade to 2K/4K unless the user explicitly requests it.
- Pass project image asset IDs through referenceAssetIds; never fetch reference bytes yourself.
- Generated images are saved to the media pool and placed on the active timeline.

## TTS voice generation
- Use submit_voice only for an explicitly requested TTS generation after the user has confirmed a concrete provider and voiceId.
- Use doubao for Chinese-optimized speech and elevenlabs for English or multilingual speech. Never mix their voice catalogs.
- Curated Doubao examples include vivi, xiaohe, yunzhou, dayi, liuchang, and morgan. Curated ElevenLabs examples include amelia, hope, peter, james, and sully.
- Voice samples are available at /voice-samples/<provider>-<voiceId>.mp3. If the user has not chosen a concrete voice, offer a few matching samples before generating.
- submit_voice creates one media-pool audio asset only. Do not claim it was placed on the timeline.

## Sound-effect generation
- Use submit_sound only after the user explicitly requests a new/original/custom sound, or when the existing sound-effects library has no suitable result.
- For ordinary whoosh, riser, impact, notification, click, ding, censor beep, record scratch, shutter, typing, or reaction sounds, use the existing library first.
- Default to 4 seconds and promptInfluence 0.3. submit_sound creates one media-pool audio asset only and does not place it on the timeline.

## Music generation
- Use submit_music only after the user explicitly requests newly generated music; it starts a paid asynchronous Mureka generation job.
- Describe the style, mood, instrumentation, and intended edit context in prompt. Do not silently request extra variants.
- submit_music returns immediately with a jobId. Call track_progress target=generation with action=status or action=wait; only a successful tracked result creates the media-pool audio asset.

## Video generation
- Use submit_video only after an explicit paid-generation request. Default to seedance2, 5 seconds, 16:9, and 720p; never silently add variants, duration, or quality.
- Seedance supports 4–15 seconds and typed image/video/audio references. Kling supports 3–15 seconds, std/pro, image references, and customize/intelligence multi-shot storyboards.
- References must be project asset IDs and must stay in refImages/refVideos/refAudios by media type. lastFrame requires firstFrame.
- For Kling customize, omit top-level prompt; use 2–6 consecutive multiPrompts whose integer durations sum to durationSeconds.
- submit_video returns immediately with a jobId. Call track_progress target=generation with action=status or action=wait; only a successful tracked result creates the media-pool video asset.

## Generation job progress
- Use track_progress only with target=generation for submit_music/submit_video job IDs. action=params reads submitted settings, status is non-blocking, and wait is explicitly bounded by timeoutSeconds.
- Do not claim a generated asset exists until track_progress reports succeeded and addedAssets includes it. Retrying track_progress is idempotent and never duplicates an existing asset.

## Export
- Use submit_export with format=video for MP4/WebM, format=audio for MP3/WAV, or format=subtitles for SRT/TXT. codec defaults to h264 for video and mp3 for audio; subtitleFormat defaults to srt.
- Prefer startFrame/endFrameExclusive for partial exports. The range is half-open, export is synchronous, and it does not change the timeline.
`;
