import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  redactTextForAgentRuntime,
  sanitizeJsonForArtifact,
} from '../../src/agent/runtime-artifact.ts';
import { TOOL_ARTIFACT_THRESHOLD } from '../../src/agent/runtime-ledger.ts';
import { ExternalEditorCallError } from './broker.ts';

interface EmbeddedImage {
  base64: string;
  frame?: number;
  mimeType?: string;
}

function embeddedImages(result: unknown): EmbeddedImage[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  if (!('__images' in result)) return [];
  const images = result.__images;
  if (!Array.isArray(images)) return [];
  return images.filter((image): image is EmbeddedImage => (
    image !== null
    && typeof image === 'object'
    && 'base64' in image
    && typeof image.base64 === 'string'
  ));
}

export function projectMcpReply(value: unknown): unknown {
  const sanitized = sanitizeJsonForArtifact(value);
  if (!sanitized) {
    throw new ExternalEditorCallError(
      'failed',
      'The external result could not be serialized safely.',
    );
  }
  if (sanitized.originalChars > TOOL_ARTIFACT_THRESHOLD) {
    throw new ExternalEditorCallError(
      'failed',
      'The external result was too large and no recoverable artifact reference was available.',
    );
  }
  return JSON.parse(sanitized.body);
}

export function mcpToolError(error: unknown): {
  outcome: 'rejected' | 'cancelled' | 'stale' | 'failed';
  message: string;
} {
  const message = redactTextForAgentRuntime(
    error instanceof Error ? error.message : String(error),
  ).slice(0, 1_200) || 'External tool call failed.';
  return {
    outcome: error instanceof ExternalEditorCallError ? error.outcome : 'failed',
    message,
  };
}

export function toStructuredContent(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { result };
  const record = result as Record<string, unknown>;
  const images = embeddedImages(record);
  if (!images.length) return record;
  const { __images: _images, ...rest } = record;
  return {
    ...rest,
    images: images.map((image) => ({
      frame: image.frame,
      mimeType: image.mimeType ?? 'image/jpeg',
    })),
  };
}

export function toMcpContent(result: unknown): CallToolResult['content'] {
  const structured = toStructuredContent(result);
  return [
    { type: 'text', text: JSON.stringify(structured) },
    ...embeddedImages(result).map((image) => ({
      type: 'image' as const,
      data: image.base64,
      mimeType: image.mimeType ?? 'image/jpeg',
    })),
  ];
}
