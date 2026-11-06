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
    duration?: string;
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

/** `response_format.duration` ("3s"–"15s"). Omitted when the caller left it to the API default (10s). */
export function omniDuration(durationSeconds: number, durationSpecified: boolean): string | undefined {
  return durationSpecified ? `${Math.round(durationSeconds)}s` : undefined;
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

/** Files API id of a URI-delivery result: "files/abc" or ".../v1beta/files/abc:download?alt=media". */
export function omniFileId(uri: string): string | undefined {
  return /(?:^|\/v1(?:alpha|beta)?\/)files\/([A-Za-z0-9_-]+)/.exec(uri)?.[1];
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
  const prompt = input.prompt.trim();
  const parts: OmniInputPart[] = [{ type: 'text', text: prompt }, ...imageParts];
  const task = omniTask(input);
  const duration = omniDuration(input.durationSeconds, input.durationSpecified);
  const body: OmniVideoRequestBody = {
    model,
    input: parts.length === 1 ? prompt : parts,
    response_format: {
      type: 'video',
      aspect_ratio: omniAspectRatio(input.ratio),
      resolution: omniResolution(input.resolution),
      ...(duration ? { duration } : {}),
      delivery: 'uri',
    },
    background: false,
    store: false,
    stream: false,
  };
  if (task) body.generation_config = { video_config: { task } };
  return body;
}
