// Vision bypass: describe images with a separately configured vision model so
// a text-only main model (e.g. DeepSeek family) can still understand user
// attachments, rendered timeline frames, and export QA evidence.
//
// Two entry points:
// - describeImagesForTextModel(): message-layer bypass. Unifies tool media,
//   describes every image in place, replaces each image part with text.
// - maybeDescribeFramesResult(): tool-layer bypass. Frames tools return a
//   text visualSummary instead of __images when the main model is text-only.
//
// Every failure degrades to the existing strip-to-text behavior — a broken
// vision call never blocks the agent.
import { generateText } from 'ai';
import type { ModelMessage, UserContent } from 'ai';
import { getLanguageModel } from './client';
import { getActiveAgentModelChoice, type AgentModelChoice } from './model-selection';
import { prepareChatCompletionsMediaMessages } from './messages';
import { resolveVisionModel, type VisionModelRef } from './visionConfig';

type UserContentParts = Exclude<UserContent, string>;
type UserPart = UserContentParts[number];

export type VisionPurpose = 'user-attachment' | 'timeline-frames' | 'asset-frames' | 'qa-evidence';

const VISION_SYSTEM = `You are a visual-analysis pass for a video editor whose main model cannot see images.
Describe images in concise structured Chinese (中文) bullet points, focusing on facts a video editor needs.
Never invent details; if something is unreadable or uncertain, say so explicitly.`;

const VISION_TIMEOUT_MS = 30_000;
const VISION_MAX_OUTPUT_TOKENS = 1024;
const DESCRIBE_CONCURRENCY = 4;

const IMAGE_OMITTED_FALLBACK =
  'Visual attachment omitted: the vision model could not describe it.';

interface ImagePayload {
  base64: string;
  mediaType: string;
}

function purposePrompt(purpose: VisionPurpose): string {
  switch (purpose) {
    case 'user-attachment':
      return 'Analyze the attached image for a text-only editing agent. Report: subject and content; any readable text verbatim; layout and composition; colors; anything relevant to video editing. Answer in Chinese.';
    case 'timeline-frames':
      return 'These are rendered frames from a video timeline (contact sheet: cells left-to-right, top-to-bottom, in frame order). Describe each cell briefly with its cell number, noting visual differences, text, composition, and any defects (black frames, glitches, color issues). Answer in Chinese.';
    case 'asset-frames':
      return 'These are sampled frames of one media asset. Describe content per cell with cell numbers, plus technical notes (resolution artifacts, color, readability). Answer in Chinese.';
    case 'qa-evidence':
      return 'This is an export QA evidence sheet: each row shows the frame immediately before and after one edit boundary. For each row, note whether the cut looks correct (no duplicate, black, or offset frames). Answer in Chinese.';
  }
}

function isImagePart(part: UserPart): ImagePayload | null {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'image') {
    const source = part.image;
    if (typeof source === 'string' && source.length > 0) {
      const mediaType = source.startsWith('data:') ? source.slice(5, source.indexOf(';')) : 'image/jpeg';
      const base64 = source.startsWith('data:') ? source.slice(source.indexOf(',') + 1) : source;
      return { base64, mediaType };
    }
    return null;
  }
  if (part.type === 'file' && typeof part.mediaType === 'string' && part.mediaType.toLowerCase().startsWith('image/')) {
    const data = part.data;
    if (data && typeof data === 'object' && 'type' in data && data.type === 'data') {
      const payload = (data as { data?: unknown }).data;
      if (typeof payload === 'string') return { base64: payload, mediaType: part.mediaType };
    }
    return null;
  }
  return null;
}

/** One bounded vision-model description call. Throws on failure (caller degrades). */
export async function describeImageWithVision(
  vision: VisionModelRef,
  image: ImagePayload,
  purpose: VisionPurpose,
  signal?: AbortSignal,
): Promise<string> {
  const model = await getLanguageModel(vision.provider, vision.model, vision.openAiApiMode);
  const { text } = await generateText({
    model,
    system: VISION_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: purposePrompt(purpose) },
        { type: 'image', image: `data:${image.mediaType};base64,${image.base64}` },
      ],
    }],
    maxOutputTokens: VISION_MAX_OUTPUT_TOKENS,
    abortSignal: signal,
    timeout: { totalMs: VISION_TIMEOUT_MS },
  });
  return text.trim();
}

/** Replace a single image with its description text (or a fallback). */
async function describedPart(
  image: ImagePayload,
  vision: VisionModelRef,
  signal?: AbortSignal,
): Promise<UserPart> {
  try {
    const description = await describeImageWithVision(vision, image, 'user-attachment', signal);
    return { type: 'text', text: `[图片内容] ${description}` };
  } catch {
    return { type: 'text', text: IMAGE_OMITTED_FALLBACK };
  }
}

/**
 * Message-layer bypass: unify tool media into user attachments, then describe
 * every image part in place and replace it with text. Falls back to the
 * existing strip behavior for any image the vision call cannot handle.
 */
export async function describeImagesForTextModel(
  messages: readonly ModelMessage[],
  vision: VisionModelRef,
  signal?: AbortSignal,
): Promise<ModelMessage[]> {
  const unified = prepareChatCompletionsMediaMessages(messages).messages;
  const result: ModelMessage[] = [];
  for (const message of unified) {
    if (message.role !== 'user' || typeof message.content === 'string') {
      result.push(message);
      continue;
    }
    const images: Array<{ image: ImagePayload }> = [];
    const content: UserPart[] = [];
    for (const part of message.content) {
      const image = isImagePart(part);
      if (image) {
        images.push({ image });
      } else {
        content.push(part);
      }
    }
    if (!images.length) {
      result.push(message);
      continue;
    }
    const replacements: Array<Promise<UserPart>> = [];
    for (let index = 0; index < images.length; index += DESCRIBE_CONCURRENCY) {
      const batch = images.slice(index, index + DESCRIBE_CONCURRENCY);
      replacements.push(...batch.map(({ image }) => describedPart(image, vision, signal)));
    }
    const described = await Promise.all(replacements);
    let at = 0;
    const rebuilt: UserPart[] = [];
    for (const part of message.content) {
      if (isImagePart(part)) {
        rebuilt.push(described[at]!);
        at += 1;
      } else {
        rebuilt.push(part);
      }
    }
    result.push({ ...message, content: rebuilt } as unknown as ModelMessage);
  }
  return result;
}

/**
 * Tool-layer bypass: when the active main model is text-only and a vision
 * model is configured, replace __images payloads with a text visualSummary.
 * Returns the original result untouched when no bypass applies or the vision
 * call fails (the message layer then strips or describes the images).
 */
export async function maybeDescribeFramesResult(
  result: unknown,
  purpose: 'timeline-frames' | 'asset-frames' | 'qa-evidence',
  signal?: AbortSignal,
  resolveChoice: () => AgentModelChoice | undefined = getActiveAgentModelChoice,
): Promise<unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const images = record.__images;
  if (!Array.isArray(images) || !images.length) return result;
  const first = images[0] as { base64?: unknown } | null;
  if (typeof first?.base64 !== 'string') return result;
  const vision = resolveVisionModel(resolveChoice());
  if (!vision) return result;
  const description = await describeImageWithVision(
    vision,
    { base64: first.base64, mediaType: 'image/jpeg' },
    purpose,
    signal,
  ).catch(() => null);
  if (!description) return result;
  const { __images, ...rest } = record;
  return { ...rest, visualSummary: description };
}
