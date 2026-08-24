import type { IncomingMessage } from 'node:http';
import {
  DEFAULT_ACCEPTANCE_ITERATIONS,
  MAX_ACCEPTANCE_ITERATIONS,
  MIN_ACCEPTANCE_ITERATIONS,
  type AgentCacheMode,
} from '../../src/agent/settings/agentSettings';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGES = 64;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_REFERENCES = 16;
const MAX_REFERENCE_BYTES = 32_000;
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_SYSTEM_PROMPT_CHARS = 160_000;
const MAX_OUTPUT_TOKENS = 512_000;
const MAX_MODEL_ID_CHARS = 256;
const MAX_EXTERNAL_SESSION_ID_CHARS = 256;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

export interface ValidatedCreateInput {
  readonly projectId: string;
  readonly runId: string;
  readonly capability: string;
  readonly messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  readonly tools: readonly unknown[];
  readonly references: unknown[];
  readonly model: string;
  readonly externalSessionId: string;
  readonly context: unknown;
  readonly instructions?: string;
  readonly cacheMode: AgentCacheMode;
  readonly maxOutputTokens: number;
  readonly autonomousAcceptance: boolean;
  readonly maxAcceptanceIterations: number;
}

export function requestHeader(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return MAX_CONTEXT_BYTES + 1;
  }
}

function validatedMessages(value: unknown): ValidatedCreateInput['messages'] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) {
    throw new Error(`messages must contain 1-${MAX_MESSAGES} items`);
  }
  return value.map((raw) => {
    if (!isJsonObject(raw)) throw new Error('invalid message');
    const content = typeof raw.content === 'string' ? raw.content : '';
    if (!content || content.length > MAX_MESSAGE_CHARS) {
      throw new Error(`message content must be 1-${MAX_MESSAGE_CHARS} characters`);
    }
    return {
      role: raw.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content,
    };
  });
}

export function requestOrigin(req: IncomingMessage): string | null {
  const host = req.headers.host;
  if (!host || /[/\\@?#,\s]/.test(host)) return null;
  try {
    const url = new URL(`http://${host}`);
    return url.username || url.password || url.pathname !== '/' || url.search || url.hash
      ? null
      : url.origin;
  } catch {
    return null;
  }
}

export async function readJson(
  req: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const length = requestHeader(req, 'content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new Error('request body too large');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!isJsonObject(parsed)) throw new Error('body must be a JSON object');
  return parsed;
}

export function requireProjectId(value: unknown): string {
  const projectId = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(projectId)) {
    throw new Error('valid projectId is required');
  }
  return projectId;
}
function validatedRunIdentity(body: Record<string, unknown>): {
  runId: string;
  capability: string;
} {
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  if (!RUN_ID.test(runId)) throw new Error('valid runId is required');
  const capability = typeof body.capability === 'string' ? body.capability.trim() : '';
  if (!RUN_CAPABILITY.test(capability)) throw new Error('valid run capability is required');
  return { runId, capability };
}
function validatedCacheMode(value: unknown): AgentCacheMode {
  if (value !== 'short' && value !== 'long') {
    throw new Error('cacheMode must be short or long');
  }
  return value;
}

function validatedMaxOutputTokens(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_OUTPUT_TOKENS
  ) {
    throw new Error(`maxOutputTokens must be an integer between 1 and ${MAX_OUTPUT_TOKENS}`);
  }
  return value;
}
function validatedAcceptance(body: Record<string, unknown>): {
  autonomousAcceptance: boolean;
  maxAcceptanceIterations: number;
} {
  if (body.autonomousAcceptance !== undefined && typeof body.autonomousAcceptance !== 'boolean') {
    throw new Error('autonomousAcceptance must be a boolean');
  }
  const value = body.maxAcceptanceIterations ?? DEFAULT_ACCEPTANCE_ITERATIONS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < MIN_ACCEPTANCE_ITERATIONS || value > MAX_ACCEPTANCE_ITERATIONS) {
    throw new Error(`maxAcceptanceIterations must be an integer between ${MIN_ACCEPTANCE_ITERATIONS} and ${MAX_ACCEPTANCE_ITERATIONS}`);
  }
  return { autonomousAcceptance: body.autonomousAcceptance === true, maxAcceptanceIterations: value };
}
function validatedOptionalIdentifier(
  value: unknown,
  field: 'model' | 'externalSessionId',
  maxChars: number,
): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) return '';
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
  if (normalized.length > maxChars || hasControlCharacter) {
    throw new Error(`${field} must be 1-${maxChars} non-control characters`);
  }
  return normalized;
}

export function validateCreateInput(body: Record<string, unknown>): ValidatedCreateInput {
  const projectId = requireProjectId(body.projectId);
  const { runId, capability } = validatedRunIdentity(body);
  const messages = validatedMessages(body.messages);
  const cacheMode = validatedCacheMode(body.cacheMode);
  const maxOutputTokens = validatedMaxOutputTokens(body.maxOutputTokens);
  const acceptance = validatedAcceptance(body);
  const model = validatedOptionalIdentifier(body.model, 'model', MAX_MODEL_ID_CHARS);
  const externalSessionId = validatedOptionalIdentifier(
    body.externalSessionId,
    'externalSessionId',
    MAX_EXTERNAL_SESSION_ID_CHARS,
  );
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const references = Array.isArray(body.references) ? body.references : [];
  if (references.length > MAX_REFERENCES || jsonBytes(references) > MAX_REFERENCE_BYTES) {
    throw new Error('references exceed request limits');
  }
  const context = body.context;
  if (context !== undefined && jsonBytes(context) > MAX_CONTEXT_BYTES) {
    throw new Error('context exceeds request limits');
  }
  const instructions = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';
  if (instructions.length > MAX_SYSTEM_PROMPT_CHARS) {
    throw new Error('system prompt exceeds request limits');
  }
  return {
    projectId,
    runId,
    capability,
    messages,
    tools,
    references,
    context,
    model,
    externalSessionId,
    cacheMode,
    maxOutputTokens,
    ...acceptance,
    ...(instructions ? { instructions } : {}),
  };
}
