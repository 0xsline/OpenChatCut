import type { SequenceGraphError } from '../editor/sequenceGraph.js';

export type ExportFailureStage =
  | 'preflight'
  | 'queue'
  | 'render'
  | 'encode'
  | 'destination'
  | 'upload'
  | 'cancel'
  | 'timeout'
  | 'cleanup';

export type ExportCleanupStatus = 'not-required' | 'succeeded' | 'failed';

function isExportFailureStage(value: unknown): value is ExportFailureStage {
  return value === 'preflight' || value === 'queue' || value === 'render' || value === 'encode'
    || value === 'destination' || value === 'upload' || value === 'cancel'
    || value === 'timeout' || value === 'cleanup';
}

export interface ExportMediaIssue {
  code: 'missing_source' | 'missing_reference' | 'missing_sequence' | 'unreadable' | 'unsupported_source';
  source: string | null;
  owner: 'item' | 'audio' | 'effect' | 'transition' | 'caption' | 'sequence';
  timelineId?: string;
  itemId?: string;
  assetId?: string;
  field?: string;
  message: string;
}

function isExportMediaIssue(value: unknown): value is ExportMediaIssue {
  if (!value || typeof value !== 'object'
    || !('code' in value) || !('source' in value) || !('owner' in value)
    || !('message' in value)) return false;
  const validCode = value.code === 'missing_source' || value.code === 'missing_reference'
    || value.code === 'missing_sequence' || value.code === 'unreadable'
    || value.code === 'unsupported_source';
  const validOwner = value.owner === 'item' || value.owner === 'audio' || value.owner === 'effect'
    || value.owner === 'transition' || value.owner === 'caption' || value.owner === 'sequence';
  const validContext = (!('timelineId' in value) || value.timelineId === undefined || typeof value.timelineId === 'string')
    && (!('itemId' in value) || value.itemId === undefined || typeof value.itemId === 'string')
    && (!('assetId' in value) || value.assetId === undefined || typeof value.assetId === 'string')
    && (!('field' in value) || value.field === undefined || typeof value.field === 'string');
  return validCode && validOwner && validContext
    && (value.source === null || typeof value.source === 'string')
    && typeof value.message === 'string';
}

export interface ExportFailure {
  stage: ExportFailureStage;
  code: string;
  retryable: boolean;
  cleanupStatus: ExportCleanupStatus;
  targetPath: string | null;
  message: string;
  mediaIssues?: ExportMediaIssue[];
  /** Sequence-graph diagnostics are preserved for preflight UI and API clients. */
  path?: string[];
  limit?: number;
  timelineId?: string;
  itemId?: string;
  referencedTimelineId?: string;
  parentFps?: number;
  childFps?: number;
}

export class ExportFailureError extends Error {
  readonly failure: ExportFailure;

  constructor(failure: ExportFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = 'ExportFailureError';
    this.failure = failure;
  }
}

export function isExportFailure(value: unknown): value is ExportFailure {
  if (!value || typeof value !== 'object'
    || !('stage' in value) || !('code' in value) || !('retryable' in value)
    || !('cleanupStatus' in value) || !('targetPath' in value) || !('message' in value)) return false;
  return isExportFailureStage(value.stage)
    && typeof value.code === 'string'
    && typeof value.retryable === 'boolean'
    && (value.cleanupStatus === 'not-required' || value.cleanupStatus === 'succeeded' || value.cleanupStatus === 'failed')
    && (value.targetPath === null || typeof value.targetPath === 'string')
    && typeof value.message === 'string'
    && (!('path' in value) || value.path === undefined
      || Array.isArray(value.path) && value.path.every((part) => typeof part === 'string'))
    && (!('limit' in value) || value.limit === undefined || typeof value.limit === 'number')
    && (!('timelineId' in value) || value.timelineId === undefined || typeof value.timelineId === 'string')
    && (!('itemId' in value) || value.itemId === undefined || typeof value.itemId === 'string')
    && (!('referencedTimelineId' in value) || value.referencedTimelineId === undefined
      || typeof value.referencedTimelineId === 'string')
    && (!('parentFps' in value) || value.parentFps === undefined || typeof value.parentFps === 'number')
    && (!('childFps' in value) || value.childFps === undefined || typeof value.childFps === 'number')
    && (!('mediaIssues' in value) || value.mediaIssues === undefined
      || Array.isArray(value.mediaIssues) && value.mediaIssues.every(isExportMediaIssue));
}

export function exportFailureFrom(value: unknown): ExportFailure | null {
  if (value instanceof ExportFailureError) return value.failure;
  if (isExportFailure(value)) return value;
  if (value && typeof value === 'object' && 'failure' in value && isExportFailure(value.failure)) {
    return value.failure;
  }
  return null;
}

export function createExportFailure(
  input: Omit<ExportFailure, 'cleanupStatus' | 'targetPath'> & Partial<Pick<ExportFailure, 'cleanupStatus' | 'targetPath'>>,
): ExportFailure {
  return {
    ...input,
    cleanupStatus: input.cleanupStatus ?? 'not-required',
    targetPath: input.targetPath ?? null,
  };
}

export function createSequenceGraphExportFailure(error: SequenceGraphError): ExportFailure {
  return createExportFailure({
    stage: 'preflight',
    code: error.code,
    retryable: false,
    message: error.message,
    path: [...error.path],
    limit: error.limit,
    timelineId: error.timelineId,
    itemId: error.itemId,
    referencedTimelineId: error.referencedTimelineId,
    parentFps: error.parentFps,
    childFps: error.childFps,
  });
}

export function withExportFailureTarget(failure: ExportFailure, targetPath: string | null): ExportFailure {
  return failure.targetPath === targetPath ? failure : { ...failure, targetPath };
}
