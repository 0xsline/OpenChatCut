import type {
  ProjectDocumentMutationResponse, ProjectStoreMutationResponse, ProjectStoreRequest,
} from '../../shared/project-store-transport';
import { requestProjectStore } from './projectStoreTransport';
import type { StoreSnapshot } from './sharedKvRecovery';

export interface EntryResponse {
  found: boolean;
  value?: unknown;
}
type DocumentWrite = Extract<ProjectStoreRequest, { operation: 'project-document-write' }>;
type RuntimeWrite = Extract<ProjectStoreRequest, { operation: 'agent-runtime-write' | 'agent-run-lease' }>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function validSnapshot(value: unknown): value is StoreSnapshot {
  return isRecord(value) && value.version === 1 && isRecord(value.entries);
}

export async function requestSnapshot(): Promise<StoreSnapshot> {
  const value = await requestProjectStore({ operation: 'snapshot' });
  if (!validSnapshot(value)) throw new Error('invalid project store response');
  return value;
}

export async function requestMerge(
  entries: Record<string, unknown>, documentKeys: readonly string[] = [],
): Promise<StoreSnapshot> {
  const value = await requestProjectStore({ operation: 'merge', entries });
  if (!validSnapshot(value)) throw new Error('invalid project store response');
  // HTTP merge returns only the index. Confirm submitted pending bodies through
  // entry reads before acknowledging them; ordinary bootstrap adds no reads.
  const confirmed = { ...value.entries };
  for (const key of documentKeys) {
    const entry = await requestEntry(key);
    if (entry.found) confirmed[key] = entry.value;
    else delete confirmed[key];
  }
  return { ...value, entries: confirmed };
}

export async function requestEntry(key: string): Promise<EntryResponse> {
  const value = await requestProjectStore({ operation: 'entry', key });
  if (!('found' in value) || typeof value.found !== 'boolean') {
    throw new Error('invalid project index response');
  }
  return value;
}

export function validMutationResponse(value: unknown): value is ProjectStoreMutationResponse {
  return isRecord(value)
    && typeof value.accepted === 'boolean'
    && typeof value.found === 'boolean'
    && (!value.found || Object.hasOwn(value, 'value'));
}

function validProjectDocumentMutation(value: unknown): value is ProjectDocumentMutationResponse {
  if (!isRecord(value) || !validMutationResponse(value)) return false;
  const currentRevision = value.currentRevision;
  const ownershipEpoch = value.ownershipEpoch;
  return (currentRevision === undefined || typeof currentRevision === 'string')
    && (ownershipEpoch === undefined
      || (typeof ownershipEpoch === 'number' && Number.isSafeInteger(ownershipEpoch) && ownershipEpoch >= 1));
}

export async function requestProjectDocumentMutation(request: DocumentWrite): Promise<ProjectDocumentMutationResponse> {
  const value = await requestProjectStore(request);
  if (!validProjectDocumentMutation(value)) throw new Error('invalid project document mutation response');
  return value;
}

export async function requestMutation(request: RuntimeWrite): Promise<ProjectStoreMutationResponse> {
  const value = await requestProjectStore(request);
  if (!validMutationResponse(value)) throw new Error('invalid project store mutation response');
  return value;
}
