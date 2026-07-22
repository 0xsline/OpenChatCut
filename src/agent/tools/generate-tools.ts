import type { AgentContext } from '../context';
import { GENERATE_TOOL_SCHEMAS } from './generate-schemas';
import { executeGenerateCommand } from './generate-tool-handlers';
import type { GenerateArgs } from './generate-tool-input';

export { GENERATE_TOOL_SCHEMAS } from './generate-schemas';

export const GENERATE_TOOL_NAMES = new Set(GENERATE_TOOL_SCHEMAS.map((tool) => tool.name));

export async function execGenerateTool(name: string, args: GenerateArgs, ctx: AgentContext): Promise<unknown> {
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
- Use track_progress only with target=generation for submit_music/submit_video job IDs. action=params reads submitted settings, status is non-blocking, and wait is explicitly bounded by timeoutSeconds.
- Do not claim a generated asset exists until track_progress reports succeeded and addedAssets includes it. Retrying track_progress is idempotent and never duplicates an existing asset.

## Export
- Use submit_export with format=video for MP4/WebM, format=audio for MP3/WAV, format=subtitles for SRT/TXT, or format=xml for FCPXML (nleFormat fcp_xml|fcp_xml_resolve). codec defaults to h264 for video and mp3 for audio; subtitleFormat defaults to srt.
- To hand off rendered motion graphics with XML, call export_motion_graphic_prores with filenameMode=xml, then pass the successful renders[].renderKey values to submit_export.motionGraphicRenderKeys. Missing or failed keys remain explicit XML placeholders.
- Prefer startFrame/endFrameExclusive for partial exports. The range is half-open, export is synchronous, and it does not change the timeline.
- If submit_export returns unsupportedFonts, use search_fonts for alternatives or ask the user, then retry with confirmFontFallback=true only after they accept fallback.
`;
