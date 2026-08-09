import type { MediaAsset, TimelineItem, TimelineState } from '../../editor/types';
import { sourceRevisionOf } from '../../editor/mediaSourceRevision';
import { reserveGenerationOperation } from '../../persist/jobRegistryStore';
import type { AgentContext } from '../context';
import { executeGenerateCommand } from './generate-tool-handlers';
import type { GenerateArgs } from './generate-tool-input';
import { GENERATE_TOOL_SCHEMAS } from './generate-schemas';

const IDEMPOTENT_GENERATION_TOOLS: Record<string, true> = {
  submit_image: true,
  submit_voice: true,
  submit_sound: true,
  submit_music: true,
  submit_video: true,
};
const DURABLE_GENERATION_TOOLS: Partial<Record<string, 'submit_music' | 'submit_video'>> = {
  submit_music: 'submit_music',
  submit_video: 'submit_video',
};
const IDEMPOTENCY_WINDOW_MS = 60_000;

interface AcceptedSubmission {
  acceptedAt: number;
  operationId?: string;
  jobId?: string;
  result: unknown;
}

const acceptedSubmissions = new Map<string, AcceptedSubmission>();
const submissionQueues = new Map<string, Promise<void>>();

/** Test/reload seam: durable operation reservations intentionally survive this reset. */
export function resetGenerationIdempotencyMemory(): void {
  acceptedSubmissions.clear();
  submissionQueues.clear();
}

type GenerationReferenceResolver = 'asset-id' | 'music-asset' | 'video-source';

interface GenerationReferenceField {
  name: string;
  multiple?: true;
  resolver: GenerationReferenceResolver;
}

interface GenerationSourceIdentity {
  entity: 'media-asset' | 'timeline-item';
  id: string;
  src: string;
  sourceRevision: string;
}

interface CurrentGenerationReference {
  field: string;
  index?: number;
  sources: GenerationSourceIdentity[];
}

const GENERATION_REFERENCE_FIELDS: Partial<Record<string, readonly GenerationReferenceField[]>> = {
  submit_image: [
    { name: 'referenceAssetIds', multiple: true, resolver: 'asset-id' },
    { name: 'maskAssetId', resolver: 'asset-id' },
  ],
  submit_music: [
    { name: 'referenceAssetId', resolver: 'music-asset' },
    { name: 'sourceAssetId', resolver: 'music-asset' },
  ],
  submit_video: [
    { name: 'firstFrame', resolver: 'video-source' },
    { name: 'lastFrame', resolver: 'video-source' },
    { name: 'refImages', multiple: true, resolver: 'video-source' },
    { name: 'refVideos', multiple: true, resolver: 'video-source' },
    { name: 'refAudios', multiple: true, resolver: 'video-source' },
  ],
};

const PUBLIC_GENERATION_FIELDS: Record<string, readonly string[]> = Object.fromEntries(
  GENERATE_TOOL_SCHEMAS.map((schema) => [schema.name, Object.keys(schema.input_schema.properties ?? {})]),
);

function semanticSourceLocation(src: string): string {
  const value = src.trim();
  if (/^data:/i.test(value)) return `data:[inline-source-omitted]:${sourceRevisionOf({ src: value })}`;
  if (/^https?:/i.test(value)) {
    try {
      const url = new URL(value);
      const publicLocation = `${url.origin}${url.pathname}`;
      return url.username || url.password || url.search || url.hash
        ? `${publicLocation}#source:${sourceRevisionOf({ src: value })}`
        : publicLocation;
    } catch {
      return `[invalid-source-url]:${sourceRevisionOf({ src: value })}`;
    }
  }
  const suffix = value.search(/[?#]/);
  return suffix < 0 ? value : `${value.slice(0, suffix)}#source:${sourceRevisionOf({ src: value })}`;
}

function publicSemanticGenerationArgs(name: string, args: GenerateArgs): GenerateArgs {
  const publicFields = PUBLIC_GENERATION_FIELDS[name];
  if (!publicFields) return {};
  const referenceFields = GENERATION_REFERENCE_FIELDS[name] ?? [];
  const semanticArgs: GenerateArgs = {};
  for (const field of publicFields) {
    if (!Object.prototype.hasOwnProperty.call(args, field)) continue;
    const value = args[field];
    const referenceField = referenceFields.find((candidate) => candidate.name === field);
    semanticArgs[field] = referenceField
      ? Array.isArray(value)
        ? value.map((item) => semanticSourceLocation(String(item)))
        : typeof value === 'string'
          ? semanticSourceLocation(value)
          : value
      : value;
  }
  return semanticArgs;
}

function assetIdentity(asset: MediaAsset): GenerationSourceIdentity {
  return {
    entity: 'media-asset',
    id: asset.id,
    src: semanticSourceLocation(asset.src),
    sourceRevision: sourceRevisionOf(asset),
  };
}

function timelineItemIdentity(item: TimelineItem): GenerationSourceIdentity | undefined {
  if (!item.src) return undefined;
  const kind = item.kind === 'audio' || item.kind === 'video' || item.kind === 'image'
    || item.kind === 'gif' || item.kind === 'svg' || item.kind === 'motion-graphic'
    ? item.kind
    : undefined;
  return {
    entity: 'timeline-item',
    id: item.id,
    src: semanticSourceLocation(item.src),
    sourceRevision: sourceRevisionOf({
      src: item.src,
      name: item.name,
      kind,
      durationInFrames: item.durationInFrames,
      width: item.width,
      height: item.height,
      code: item.code,
      props: item.props,
      sourceRevision: item.sourceRevision,
    }),
  };
}

function resolveExactAssetId(ref: string, state: TimelineState): GenerationSourceIdentity[] {
  const asset = (state.assets ?? []).find((candidate) => candidate.id === ref);
  return asset ? [assetIdentity(asset)] : [];
}

function resolveMusicAsset(ref: string, state: TimelineState): GenerationSourceIdentity[] {
  const clean = ref.replace(/^asset:\/\//, '').trim();
  const asset = (state.assets ?? []).find(
    (candidate) => candidate.id === clean
      || candidate.id.startsWith(clean)
      || candidate.name === clean
      || candidate.src === clean,
  );
  return asset ? [assetIdentity(asset)] : [];
}

function resolveVideoSource(ref: string, state: TimelineState): GenerationSourceIdentity[] {
  const clean = ref.replace(/^asset:\/\//, '');
  const item = state.items.find((candidate) => candidate.id === clean || candidate.name === clean);
  const assetPath = item?.src ?? clean;
  const assets = state.assets ?? [];
  const exact = assets.filter(
    (candidate) => candidate.id === clean || candidate.name === clean || candidate.src === assetPath,
  );
  const candidates = exact.length ? exact : assets.filter((candidate) => candidate.id.startsWith(clean));
  const asset = candidates.length === 1 ? candidates[0] : undefined;
  const sources: GenerationSourceIdentity[] = [];
  const itemSource = item ? timelineItemIdentity(item) : undefined;
  if (itemSource) sources.push(itemSource);
  if (asset) sources.push(assetIdentity(asset));
  return sources;
}

function referenceValues(args: GenerateArgs, field: GenerationReferenceField): string[] {
  const value = args[field.name];
  if (field.multiple) {
    if (!Array.isArray(value)) return [];
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

function currentGenerationReferences(
  name: string,
  args: GenerateArgs,
  state: TimelineState,
): CurrentGenerationReference[] {
  const references: CurrentGenerationReference[] = [];
  for (const field of GENERATION_REFERENCE_FIELDS[name] ?? []) {
    const values = referenceValues(args, field);
    values.forEach((ref, index) => {
      const sources = field.resolver === 'asset-id'
        ? resolveExactAssetId(ref, state)
        : field.resolver === 'music-asset'
          ? resolveMusicAsset(ref, state)
          : resolveVideoSource(ref, state);
      if (!sources.length) return;
      references.push({
        field: field.name,
        ...(field.multiple ? { index } : {}),
        sources,
      });
    });
  }
  return references;
}

/** Type-preserving recursive serializer used by generation idempotency keys. */
export function canonicalGenerationArgs(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (current: unknown): string => {
    if (current === undefined) return 'undefined';
    if (current === null) return 'null';
    if (typeof current === 'string') return `string:${JSON.stringify(current)}`;
    if (typeof current === 'boolean') return current ? 'boolean:true' : 'boolean:false';
    if (typeof current === 'number') {
      if (Number.isNaN(current)) return 'number:NaN';
      if (current === Number.POSITIVE_INFINITY) return 'number:+Infinity';
      if (current === Number.NEGATIVE_INFINITY) return 'number:-Infinity';
      if (Object.is(current, -0)) return 'number:-0';
      return `number:${current}`;
    }
    if (typeof current === 'bigint') return `bigint:${current}`;
    if (Array.isArray(current)) {
      if (ancestors.has(current)) throw new Error('generation args cannot contain circular arrays');
      ancestors.add(current);
      const serialized = `array:[${current.map(visit).join(',')}]`;
      ancestors.delete(current);
      return serialized;
    }
    if (typeof current === 'object') {
      if (ancestors.has(current)) throw new Error('generation args cannot contain circular objects');
      ancestors.add(current);
      const source = current as Record<string, unknown>;
      const serialized = `object:{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${visit(source[key])}`).join(',')}}`;
      ancestors.delete(current);
      return serialized;
    }
    return `${typeof current}:${String(current)}`;
  };
  return visit(value);
}

/**
 * Generation arrays are positional (for example provider prompts address
 * @Image1/@Video1), so their order is preserved. Object keys remain sorted by
 * canonicalGenerationArgs.
 */
export function generationIdempotencyKey(name: string, args: GenerateArgs, ctx: AgentContext): string {
  return canonicalGenerationArgs({
    tool: name,
    projectId: ctx.getProjectId?.() ?? null,
    args: publicSemanticGenerationArgs(name, args),
    references: currentGenerationReferences(name, args, ctx.getState()),
  });
}

function providerAccepted(result: unknown): result is Record<string, unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const shaped = result as Record<string, unknown>;
  if (shaped.error !== undefined || shaped.denied === true) return false;
  return shaped.ok === true || shaped.status === 'accepted' || shaped.status === 'queued' || shaped.status === 'success' || shaped.status === 'succeeded';
}

async function executeIdempotentGeneration(
  name: string,
  args: GenerateArgs,
  ctx: AgentContext,
): Promise<unknown> {
  const key = generationIdempotencyKey(name, args, ctx);
  const previous = submissionQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => turn);
  submissionQueues.set(key, queued);
  await previous.catch(() => undefined);
  try {
    const now = Date.now();
    const accepted = acceptedSubmissions.get(key);
    if (accepted && now - accepted.acceptedAt <= IDEMPOTENCY_WINDOW_MS) {
      return {
        error: `an identical ${name} request was already accepted`,
        code: 'duplicate_submission',
        duplicateOf: accepted.operationId ?? accepted.jobId,
      };
    }
    if (accepted) acceptedSubmissions.delete(key);
    let executionArgs = args;
    const durableTool = DURABLE_GENERATION_TOOLS[name];
    if (durableTool) {
      const projectId = ctx.getProjectId?.();
      if (!projectId) {
        return {
          error: `${name} requires a persisted project id for safe submission`,
          code: 'generation_project_required',
        };
      }
      const reservation = await reserveGenerationOperation({
        projectId,
        idempotencyKey: key,
        toolName: durableTool,
        acceptedWindowMs: IDEMPOTENCY_WINDOW_MS,
      });
      if (reservation.state === 'accepted') {
        acceptedSubmissions.set(key, {
          acceptedAt: reservation.acceptedAt,
          operationId: reservation.operationId,
          jobId: reservation.jobId,
          result: undefined,
        });
        return {
          error: `an identical ${name} request was already accepted`,
          code: 'duplicate_submission',
          duplicateOf: reservation.operationId,
        };
      }
      executionArgs = { ...args, __operationId: reservation.operationId };
    }
    const result = await executeGenerateCommand(name, executionArgs, ctx);
    if (providerAccepted(result)) {
      acceptedSubmissions.set(key, {
        acceptedAt: Date.now(),
        operationId: typeof result.operationId === 'string' ? result.operationId : undefined,
        jobId: typeof result.jobId === 'string' ? result.jobId : undefined,
        result,
      });
    }
    return result;
  } finally {
    release();
    void queued.finally(() => {
      if (submissionQueues.get(key) === queued) submissionQueues.delete(key);
    });
  }
}

export { GENERATE_TOOL_NAMES } from './generate-schemas';
export { GENERATE_TOOL_SCHEMAS };

export async function execGenerateTool(name: string, args: GenerateArgs, ctx: AgentContext): Promise<unknown> {
  if (IDEMPOTENT_GENERATION_TOOLS[name] && args.__rerunGeneration !== true) {
    return executeIdempotentGeneration(name, args, ctx);
  }
  return executeGenerateCommand(name, args, ctx);
}

export const GENERATE_WORKFLOW = `
## AI image generation
- Use submit_image only after the user explicitly asks to generate an image.
- Default model gpt-image-2; use nano-banana for reference-heavy work; image-01 (MiniMax) for stills without references (prompt ≤1500 chars, count ≤9, no referenceAssetIds; optional promptOptimizer).
- Always provide a short descriptive name. Default aspectRatio 16:9, imageSize 1K, quality high, and count 1 (imageSize/quality are gpt-image-2-oriented).
- If the project is not 16:9, ask for the desired aspect ratio. Never upgrade to 2K/4K unless the user explicitly requests it.
- Pass project image asset IDs through referenceAssetIds; never fetch reference bytes yourself.
- Generated images are saved to the media pool. If the user says "media pool/library only" or asks not to change the timeline, set addToTimeline=false; otherwise propose timeline placement.

## TTS voice generation
- Use submit_voice only for explicitly requested TTS after the user confirms a configured provider and a concrete provider-specific voiceId. MiniMax timbre mixing is the only voiceId exception.
- Providers: doubao, elevenlabs, minimax, inworld, fishaudio, speechify, openai, gemini, mistral, and cartesia. All are opt-in; use only choices listed as configured in the capabilities prompt, and never mix voice catalogs.
- Curated choices exist only for Doubao, ElevenLabs, and MiniMax. Bundled samples exist only where references/voices.md lists one. For every other provider, do not invent a preset or sample URL; require a concrete voiceId from the user/provider account.
- AI SDK-backed fields: OpenAI supports modelId/speed/outputFormat/instructions; Gemini supports modelId/outputFormat/instructions; Mistral supports modelId/outputFormat; Cartesia supports modelId/speed/languageCode/outputFormat. Inworld, Fish Audio, and Speechify accept only voiceId and optional modelId.
- MiniMax supports speed (0.5–2), pitch (-12–12), volume (0–10), and emotion natively. Doubao pitch is post-process; emotionScale/performancePrompt are Doubao-only. ElevenLabs retains its dedicated delivery controls.
- submit_voice creates one media-pool audio asset only. Do not claim it was placed on the timeline.

## Sound-effect generation
- Use submit_sound only after the user explicitly requests a new/original/custom sound, or when the existing sound-effects library has no suitable result.
- For ordinary whoosh, riser, impact, notification, click, ding, censor beep, record scratch, shutter, typing, or reaction sounds, use the existing library first.
- Default to 4 seconds and promptInfluence 0.3. submit_sound creates one media-pool audio asset only and does not place it on the timeline.

## Music generation
- Use submit_music only after the user explicitly requests newly generated music; it starts an asynchronous generation job (Mureka or MiniMax).
- Default provider mureka and mode instrumental. Mureka also supports song (lyrics), prompt-song, soundtrack (image/video sourceAssetId), and track/stem generation (songId or audio sourceAssetId), count 1–3, styles, voice/reference IDs, ranges, and streaming tasks. MiniMax t2m supports lyrics, lyricsOptimizer, isInstrumental, sampleRate/bitrate/audioFormat; cover supports referenceAssetId or coverFeatureId plus style prompt (10–300) with a music-cover model.
- Describe the style, mood, instrumentation, and intended edit context in prompt. Do not silently request extra variants.
- submit_music returns immediately with a jobId. Call track_progress target=generation with action=status or action=wait; only a successful tracked result creates the media-pool audio asset.

## Video generation
- Use submit_video only after an explicit video-generation request. Default to seedance2 when configured, 5 seconds, 16:9, and 720p; never silently add variants, duration, or quality.
- Seedance supports 2–15 seconds, resolution 480p/720p(default)/1080p/4k, typed image/video/audio references, optional audio/seed/camera/watermark/last-frame/expiry/priority controls. Kling supports 3–15 seconds, std/pro, images (≤7, or ≤4 with one refVideo), refVideoMode feature|base, customize/intelligence multi-shot; use @ImageN/@Video1 in prompts. Hailuo supports 6 or 10 seconds, 512p (Hailuo-02), 720p→768P, or 1080p (6s only), firstFrame/lastFrame, optional promptOptimizer/fastPretreatment, or S2V-01 subject-reference via firstFrame when that model is selected; no multi-ref multi-shot.
- References must be project asset IDs and must stay in refImages/refVideos/refAudios by media type. lastFrame requires firstFrame.
- For Kling customize, omit top-level prompt; use 2–6 consecutive multiPrompts whose integer durations sum to durationSeconds.
- submit_video returns immediately with a jobId. Call track_progress target=generation with action=status or action=wait; only a successful tracked result creates the media-pool video asset.

## Generation job progress
- Use track_progress only with target=generation for submit_music/submit_video job IDs. action=params reads submitted settings, status is non-blocking, wait is explicitly bounded by timeoutSeconds, and resume retries a failed result download without regenerating.
- Do not claim a generated asset exists until track_progress reports succeeded and addedAssets includes it. Retrying track_progress is idempotent and never duplicates an existing asset.

## Export
- Use submit_export with format=video for MP4/WebM, format=audio for MP3/WAV, format=subtitles for SRT/TXT, or format=xml for FCPXML (nleFormat fcp_xml|fcp_xml_resolve). codec defaults to h264 for video and mp3 for audio; subtitleFormat defaults to srt.
- To hand off rendered motion graphics with XML, call export_motion_graphic_prores with filenameMode=xml, then pass the successful renders[].renderKey values to submit_export.motionGraphicRenderKeys. Missing or failed keys remain explicit XML placeholders.
- Prefer startFrame/endFrameExclusive for partial exports. The range is half-open, export is synchronous, and it does not change the timeline.
- If submit_export returns unsupportedFonts, use search_fonts for alternatives or ask the user, then retry with confirmFontFallback=true only after they accept fallback.
`;
