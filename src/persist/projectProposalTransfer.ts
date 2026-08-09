import { isProjectStoreRecord } from '../../shared/project-store-validation';
import {
  loadProposalRecord,
  parseStoredProposalRecord,
  saveProposalRecord,
  type StoredProposalRecord,
} from './proposalStore';
const EMPTY_REPLACEMENTS: ReadonlyMap<string, string> = new Map();



function transformPortableValue(
  value: unknown,
  replacements: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === 'string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) {
    return value.map((entry) => transformPortableValue(entry, replacements));
  }
  if (!isProjectStoreRecord(value)) return value;
  const entries = Object.entries(value)
    .filter(([key]) => key !== 'originalFilePath')
    .map(([key, entry]) => [key, transformPortableValue(entry, replacements)] as const);
  return Object.fromEntries(entries);
}
function collectProposalUploadValues(value: unknown, srcs: Set<string>): void {
  if (typeof value === 'string') {
    if (value.startsWith('/media/uploads/')) srcs.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectProposalUploadValues(entry, srcs);
    return;
  }
  if (!isProjectStoreRecord(value)) return;
  for (const entry of Object.values(value)) collectProposalUploadValues(entry, srcs);
}

export function includeProposalUploadSrcs(
  baseSrcs: readonly string[],
  proposal: StoredProposalRecord | undefined,
): string[] {
  const srcs = new Set(baseSrcs);
  if (proposal) collectProposalUploadValues(proposal, srcs);
  return [...srcs];
}


export function portableProposalRecord(
  raw: unknown,
  replacements: ReadonlyMap<string, string> = EMPTY_REPLACEMENTS,
): StoredProposalRecord | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseStoredProposalRecord(raw);
  if (!parsed) throw new Error('工程包提案记录校验不通过');
  const { sessionGeneration: _sessionGeneration, ...proposal } = parsed;
  const portable = parseStoredProposalRecord(transformPortableValue(proposal, replacements));
  if (!portable) throw new Error('工程包提案记录转换失败');
  return portable;
}


export async function loadPortableProposal(
  projectId: string,
): Promise<StoredProposalRecord | undefined> {
  const record = await loadProposalRecord(projectId);
  return record ? portableProposalRecord(record) : undefined;
}

export async function publishTransferredProposal(
  projectId: string,
  record: StoredProposalRecord | undefined,
): Promise<void> {
  if (record) await saveProposalRecord(projectId, record);
}
