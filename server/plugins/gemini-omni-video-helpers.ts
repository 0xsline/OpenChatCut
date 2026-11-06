/** Pure Gemini Omni Flash helpers — no network / media-dir imports (safe for verify). */

export type OmniInputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mime_type: string };

export interface OmniVideoRequestBody {
  model: string;
  input: OmniInputPart[] | string;
  response_format: {
    type: 'video';
    aspect_ratio?: '16:9' | '9:16';
    resolution?: string;
    delivery?: 'inline' | 'uri';
  };
  generation_config?: { video_config?: { task?: string } };
  background?: boolean;
  store?: boolean;
  stream?: boolean;
}

export interface OmniVideoPayload {
  data?: string;
  uri?: string;
  mime_type?: string;
}

/** Fold an optional duration hint into the prompt — Omni has no durationSeconds field. */
export function omniPromptWithDuration(prompt: string, durationSeconds: number, durationSpecified: boolean): string {
  const trimmed = prompt.trim();
  if (!durationSpecified) return trimmed;
  if (/\b\d+\s*(s|sec|secs|second|seconds)\b/i.test(trimmed)) return trimmed;
  return `${trimmed}\n\nTarget length: about ${durationSeconds} seconds.`;
}

export function omniAspectRatio(ratio: string): '16:9' | '9:16' {
  return ratio === '9:16' ? '9:16' : '16:9';
}

export function omniResolution(resolution: string | undefined): string {
  if (resolution === '360p' || resolution === '1080p' || resolution === '4k') return resolution;
  return '720p';
}

export function omniTask(input: {
  firstFramePath?: string;
  lastFramePath?: string;
  refImagePaths: readonly string[];
}): string | undefined {
  if (input.firstFramePath && input.lastFramePath) return undefined; // interpolation inferred from two images
  if (input.refImagePaths.length) return 'reference_to_video';
  if (input.firstFramePath) return 'image_to_video';
  return undefined;
}

/** Pull video bytes/URI from the Interactions convenience field or steps[].content. */
export function extractOmniVideo(result: Record<string, unknown>): OmniVideoPayload {
  const convenience = result.output_video as OmniVideoPayload | undefined;
  if (convenience && (convenience.data || convenience.uri)) return convenience;

  const steps = result.steps;
  if (!Array.isArray(steps)) return {};
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const content = (step as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const record = part as { type?: unknown; data?: unknown; uri?: unknown; mime_type?: unknown };
      if (record.type !== 'video') continue;
      return {
        data: typeof record.data === 'string' ? record.data : undefined,
        uri: typeof record.uri === 'string' ? record.uri : undefined,
        mime_type: typeof record.mime_type === 'string' ? record.mime_type : undefined,
      };
    }
  }
  return {};
}

export function buildOmniVideoRequestBodySync(
  model: string,
  input: {
    prompt: string;
    durationSeconds: number;
    durationSpecified: boolean;
    ratio: string;
    resolution?: string;
    firstFramePath?: string;
    lastFramePath?: string;
    refImagePaths: readonly string[];
  },
  imageParts: OmniInputPart[],
): OmniVideoRequestBody {
  const prompt = omniPromptWithDuration(input.prompt, input.durationSeconds, input.durationSpecified);
  const parts: OmniInputPart[] = [{ type: 'text', text: prompt }, ...imageParts];
  const task = omniTask(input);
  const body: OmniVideoRequestBody = {
    model,
    input: parts.length === 1 ? prompt : parts,
    response_format: {
      type: 'video',
      aspect_ratio: omniAspectRatio(input.ratio),
      resolution: omniResolution(input.resolution),
      delivery: 'uri',
    },
    background: false,
    store: false,
    stream: false,
  };
  if (task) body.generation_config = { video_config: { task } };
  return body;
}
