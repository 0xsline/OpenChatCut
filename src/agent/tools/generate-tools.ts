import type { MediaAsset, TimelineItem, TimelineState } from '../../editor/types';
import { sourceRevisionOf } from '../../editor/mediaSourceRevision';
import { findAssetByReference } from '../../generate/asset-reference';
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
type DurableGenerationTool = 'submit_music' | 'submit_sound' | 'submit_video';
const DURABLE_GENERATION_TOOLS: Partial<Record<string, DurableGenerationTool>> = {
  submit_music: 'submit_music',
  submit_sound: 'submit_sound',
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
  submit_sound: [
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
  const asset = findAssetByReference(ref, state.assets ?? []);
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
    const durableTool = name === 'submit_sound' && args.provider !== 'sonilo'
      ? undefined
      : DURABLE_GENERATION_TOOLS[name];
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
