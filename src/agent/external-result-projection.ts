import { EXTERNAL_AGENT_IMAGE_PAYLOAD_LIMIT_BYTES } from '../../shared/external-agent-limits';
import { ExternalEditSessionOutcomeError } from './external-edit-session';
import { sanitizeJsonForArtifact } from './runtime-artifact';
import { TOOL_ARTIFACT_THRESHOLD } from './runtime-ledger';

function embeddedImages(value: unknown): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const images = (value as Record<string, unknown>).__images;
  return Array.isArray(images) ? images : [];
}

function assertImagePayloadBudget(images: unknown[]): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(images);
  } catch {
    throw new ExternalEditSessionOutcomeError(
      'failed',
      'The external image payload could not be serialized safely.',
    );
  }
  if (new TextEncoder().encode(encoded).byteLength > EXTERNAL_AGENT_IMAGE_PAYLOAD_LIMIT_BYTES) {
    throw new ExternalEditSessionOutcomeError(
      'failed',
      'The external image payload exceeds the bounded bridge result limit.',
    );
  }
}

export function projectExternalReply(value: unknown): unknown {
  const images = embeddedImages(value);
  if (images.length) assertImagePayloadBudget(images);
  const source = images.length
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== '__images'))
    : value;
  const sanitized = sanitizeJsonForArtifact(source);
  if (!sanitized) {
    throw new ExternalEditSessionOutcomeError(
      'failed',
      'The external result could not be serialized safely.',
    );
  }
  if (sanitized.originalChars > TOOL_ARTIFACT_THRESHOLD) {
    throw new ExternalEditSessionOutcomeError(
      'failed',
      'The external result was too large and no recoverable artifact reference was available.',
    );
  }
  const projected = JSON.parse(sanitized.body) as unknown;
  return images.length && projected && typeof projected === 'object' && !Array.isArray(projected)
    ? { ...projected as Record<string, unknown>, __images: images }
    : projected;
}
