import type { ToolResultPart } from 'ai';
import { compactToolResultForModel } from './tool-result-compaction';

type ToolResultOutput = ToolResultPart['output'];
interface FrameImage {
  readonly frame: number;
  readonly base64: string;
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isBase64Payload(value: string): boolean {
  return value.length >= 4
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}


function frameImage(value: unknown): value is FrameImage {
  return objectRecord(value)
    && typeof value.frame === 'number'
    && Number.isFinite(value.frame)
    && typeof value.base64 === 'string'
    && isBase64Payload(value.base64);
}

/** Project browser tool output into the provider-visible AI SDK result contract. */
export function toolResultModelOutput(
  output: unknown,
  preserveExact = false,
): ToolResultOutput {
  const shaped = objectRecord(output) ? output : undefined;
  const note = typeof shaped?.note === 'string' ? shaped.note : undefined;
  if (shaped?.denied === true) {
    return {
      type: 'execution-denied',
      reason: note ?? 'User denied tool execution.',
    };
  }
  const images = Array.isArray(shaped?.__images)
    ? shaped.__images.filter(frameImage)
    : [];
  if (images.length > 0) {
    const projected = compactToolResultForModel(output);
    return {
      type: 'content',
      value: [
        ...images.map((image) => ({
          type: 'file' as const,
          data: { type: 'data' as const, data: image.base64 },
          mediaType: 'image/jpeg',
          filename: `timeline-frame-${image.frame}.jpg`,
        })),
        {
          type: 'text' as const,
          text: JSON.stringify(
            projected ?? note ?? `${images.length} frames rendered`,
          ),
        },
      ],
    };
  }
  const value = JSON.stringify(
    (preserveExact ? output : compactToolResultForModel(output)) ?? null,
  );
  return { type: 'text', value };
}
