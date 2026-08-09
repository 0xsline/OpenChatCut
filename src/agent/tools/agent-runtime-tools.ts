import type { AgentContext } from '../context';
import { loadAgentArtifact } from '../../persist/agentRuntimeStore';

const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,20}$/;
const POINTER = /^(?:|\/(?:[^~]|~[01])*)$/;
const MAX_RESPONSE_CHARS = 12_000;
const DEFAULT_LIMIT = 4_000;

type Args = Record<string, unknown>;

function integerArg(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`Expected an integer from ${min} to ${max}.`);
  }
  return value as number;
}
function decodePointerToken(token: string): string {
  if (/~(?![01])/u.test(token)) throw new Error('Invalid JSON Pointer escape.');
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}
function selectPointer(value: unknown, pointer: string): unknown {
  if (!pointer) return value;
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    const token = decodePointerToken(raw);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token) || Number(token) >= current.length) {
        throw new Error(`JSON Pointer array index is invalid: ${token}`);
      }
      current = current[Number(token)];
    } else if (current && typeof current === 'object'
        && Object.prototype.hasOwnProperty.call(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      throw new Error(`JSON Pointer target does not exist: ${pointer}`);
    }
  }
  return current;
}
function safeSlice(
  text: string,
  offset: number,
  limit: number,
): { content: string; actualOffset: number; nextOffset: number } {
  let start = offset;
  if (start > 0 && start < text.length
      && /[\uDC00-\uDFFF]/.test(text[start]!) && /[\uD800-\uDBFF]/.test(text[start - 1]!)) start += 1;
  let end = Math.min(text.length, start + limit);
  if (end > start && end < text.length
      && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) {
    end = end - start === 1 ? end + 1 : end - 1;
  }
  return { content: text.slice(start, end), actualOffset: start, nextOffset: end };
}
function boundedPage(
  text: string,
  offset: number,
  requestedLimit: number,
  base: Record<string, unknown>,
): ReturnType<typeof safeSlice> {
  let low = 1;
  let high = Math.min(requestedLimit, Math.max(1, text.length - offset));
  let best = safeSlice(text, offset, 1);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = safeSlice(text, offset, middle);
    const response = {
      ...base, offset: candidate.actualOffset, content: candidate.content,
      nextOffset: candidate.nextOffset, hasMore: candidate.nextOffset < text.length,
    };
    if (JSON.stringify(response).length <= MAX_RESPONSE_CHARS) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

export async function execAgentRuntimeTool(
  name: string,
  args: Args,
  ctx: AgentContext,
): Promise<unknown> {
  if (name !== 'read_agent_artifact') throw new Error(`Unknown Agent runtime tool: ${name}`);
  const artifactId = typeof args.artifactId === 'string' ? args.artifactId : '';
  if (!ARTIFACT_ID.test(artifactId)) throw new Error('Invalid artifactId.');
  const pointer = args.pointer === undefined ? '' : args.pointer;
  if (typeof pointer !== 'string' || pointer.length > 1024 || !POINTER.test(pointer)) {
    throw new Error('Invalid JSON Pointer.');
  }
  const offset = integerArg(args.offset, 0, 0, 8_388_608);
  const requestedLimit = integerArg(args.limit, DEFAULT_LIMIT, 1, MAX_RESPONSE_CHARS);
  const projectId = ctx.getProjectId?.();
  if (!projectId) throw new Error('read_agent_artifact requires a persisted current project.');
  const artifact = await loadAgentArtifact(projectId, artifactId);
  if (!artifact) throw new Error(`Agent artifact not found: ${artifactId}`);
  let selected = artifact.body;
  if (pointer) {
    const pointed = JSON.stringify(selectPointer(JSON.parse(artifact.body), pointer));
    if (pointed === undefined) throw new Error(`JSON Pointer target does not exist: ${pointer}`);
    selected = pointed;
  }
  if (offset > selected.length) throw new Error('Artifact offset exceeds totalChars.');
  const base = {
    artifactId, pointer, offset, totalChars: selected.length,
    bodySha256: artifact.bodySha256, redacted: artifact.redacted,
    binaryOmitted: artifact.binaryOmitted,
  };
  const page = boundedPage(selected, offset, requestedLimit, base);
  return {
    ...base,
    offset: page.actualOffset,
    content: page.content,
    nextOffset: page.nextOffset,
    hasMore: page.nextOffset < selected.length,
  };
}
