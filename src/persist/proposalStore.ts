// Pending Agent edit proposal (propose→apply). Per-project key in the shared
// server-backed KV. Survives refresh/browser changes. Persisted data is untrusted.

import type { AnyAction } from '../editor/store';
import type { ProjectDoc, TimelineState } from '../editor/types';
import type { Operation, Proposal, ProposalOption } from '../agent/proposal';
import { migrateProjectDoc } from './projectStore';
import {
  kvDel as idbDel,
  kvGet as idbGet,
  kvSet as idbSet,
  resetSharedKvMemory,
} from './sharedKv';
import {
  agentSessionGenerationMatches,
  agentSessionWriteGeneration,
  currentAgentSessionGeneration,
  resetAgentSessionGenerationMemory,
} from './agentSessionGeneration';

const proposalKey = (projectId: string, generation = 'legacy') => generation === 'legacy'
  ? `proposal:${projectId}`
  : `agent-session-proposal:${projectId}:${generation}`;
const writeQueues = new Map<string, Promise<void>>();

export type ProposalSettlementOutcome = 'applied' | 'rejected' | 'stale' | 'reproposed';
export interface ProposalApplication {
  readonly resultDoc: ProjectDoc;
  readonly operationCount: number;
  readonly startedAt: number;
}
export interface ProposalSettlement {
  readonly outcome: ProposalSettlementOutcome;
  readonly settledAt: number;
}
interface StoredProposalBase {
  readonly version: 1;
  readonly proposal: Proposal;
  readonly sessionGeneration?: string;
}
export interface StoredPreparedProposalRecord extends StoredProposalBase {
  readonly phase: 'prepared';
}
export interface StoredApplyingProposalRecord extends StoredProposalBase {
  readonly phase: 'applying';
  readonly application: ProposalApplication;
}
export interface StoredSettledProposalRecord extends StoredProposalBase {
  readonly phase: 'settled';
  readonly application?: ProposalApplication;
  readonly settlement: ProposalSettlement;
}
export type StoredProposalRecord =
  | StoredPreparedProposalRecord
  | StoredApplyingProposalRecord
  | StoredSettledProposalRecord;

export class UnsupportedProposalStoreVersionError extends Error {
  readonly version: unknown;

  constructor(version: unknown) {
    super(`Unsupported proposal store version: ${String(version)}`);
    this.version = version;
  }
}

/** Test helper: wipe the in-memory fallback (no-op when IDB is real). */
export function resetProposalStoreMemory(): void {
  writeQueues.clear();
  resetSharedKvMemory();
  resetAgentSessionGenerationMemory();
}

function isTimelineState(v: unknown): v is TimelineState {
  return !!v && typeof v === 'object'
    && Array.isArray((v as { items?: unknown }).items)
    && typeof (v as { fps?: unknown }).fps === 'number';
}

function isAction(v: unknown): v is AnyAction {
  return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';
}

function isOperation(v: unknown): v is Operation {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<Operation>;
  return typeof o.tool === 'string'
    && !!o.args && typeof o.args === 'object'
    && Array.isArray(o.actions) && o.actions.every(isAction)
    && typeof o.action === 'string'
    && typeof o.target === 'string'
    && typeof o.impact === 'string';
}

function isOption(v: unknown): v is ProposalOption {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<ProposalOption>;
  return typeof o.id === 'string'
    && typeof o.label === 'string'
    && typeof o.recommended === 'boolean'
    && typeof o.summary === 'string'
    && typeof o.totalImpact === 'string'
    && Array.isArray(o.operations) && o.operations.length > 0
    && o.operations.every(isOperation);
}

/** Validate + normalize a raw value into a Proposal, or null. */
export function parseProposal(raw: unknown): Proposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<Proposal>;
  if (typeof p.title !== 'string' || typeof p.summary !== 'string' || typeof p.totalImpact !== 'string') {
    return null;
  }
  if (p.agentRunId !== undefined && typeof p.agentRunId !== 'string') return null;
  if (p.id !== undefined && typeof p.id !== 'string') return null;
  if (!Array.isArray(p.options) || p.options.length === 0 || !p.options.every(isOption)) return null;
  const baseDoc = migrateProjectDoc(p.baseDoc);
  if (!baseDoc || !isTimelineState(p.resultState)) return null;
  return {
    title: p.title,
    summary: p.summary,
    totalImpact: p.totalImpact,
    ...(p.id ? { id: p.id } : {}),
    ...(p.agentRunId ? { agentRunId: p.agentRunId } : {}),
    options: p.options,
    baseDoc,
    resultState: p.resultState,
  };
}

function parseApplication(raw: unknown): ProposalApplication | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<ProposalApplication>;
  const resultDoc = migrateProjectDoc(value.resultDoc);
  const operationCount = value.operationCount;
  const startedAt = value.startedAt;
  if (!resultDoc
    || typeof operationCount !== 'number'
    || !Number.isInteger(operationCount)
    || operationCount < 0
    || typeof startedAt !== 'number'
    || !Number.isFinite(startedAt)) return null;
  return { resultDoc, operationCount, startedAt };
}

function parseSettlement(raw: unknown): ProposalSettlement | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<ProposalSettlement>;
  const outcome = value.outcome;
  const settledAt = value.settledAt;
  if ((outcome !== 'applied' && outcome !== 'rejected' && outcome !== 'stale' && outcome !== 'reproposed')
    || typeof settledAt !== 'number'
    || !Number.isFinite(settledAt)) return null;
  return { outcome, settledAt };
}

interface RawStoredProposalRecord {
  readonly version?: unknown;
  readonly phase?: unknown;
  readonly proposal?: unknown;
  readonly application?: unknown;
  readonly settlement?: unknown;
  readonly sessionGeneration?: unknown;
}

export function parseStoredProposalRecord(raw: unknown): StoredProposalRecord | null {
  const legacy = parseProposal(raw);
  if (legacy) return { version: 1, phase: 'prepared', proposal: legacy };
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as RawStoredProposalRecord;
  if (value.version !== 1) {
    if ('version' in value) throw new UnsupportedProposalStoreVersionError(value.version);
    return null;
  }
  const proposal = parseProposal(value.proposal);
  if (!proposal) return null;
  const application = value.application === undefined ? undefined : parseApplication(value.application);
  const settlement = value.settlement === undefined ? undefined : parseSettlement(value.settlement);
  if (value.application !== undefined && !application) return null;
  if (value.settlement !== undefined && !settlement) return null;
  const generation = typeof value.sessionGeneration === 'string'
    ? { sessionGeneration: value.sessionGeneration }
    : {};
  if (value.phase === 'prepared') {
    if (application || settlement) return null;
    return { version: 1, phase: 'prepared', proposal, ...generation };
  }
  if (value.phase === 'applying') {
    if (!application || settlement) return null;
    return { version: 1, phase: 'applying', proposal, application, ...generation };
  }
  if (value.phase === 'settled') {
    if (!settlement) return null;
    return {
      version: 1,
      phase: 'settled',
      proposal,
      ...(application ? { application } : {}),
      settlement,
      ...generation,
    };
  }
  return null;
}

function serialize<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(projectId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const marker = run.then(() => undefined, () => undefined);
  writeQueues.set(projectId, marker);
  return run.finally(() => {
    if (writeQueues.get(projectId) === marker) writeQueues.delete(projectId);
  });
}

function sameRecord(left: StoredProposalRecord, right: StoredProposalRecord): boolean {
  const { sessionGeneration: _leftGeneration, ...leftContent } = left;
  const { sessionGeneration: _rightGeneration, ...rightContent } = right;
  return JSON.stringify(leftContent) === JSON.stringify(rightContent);
}

async function persistRecord(projectId: string, record: StoredProposalRecord): Promise<void> {
  const sessionGeneration = await agentSessionWriteGeneration(projectId);
  const next = { ...record, sessionGeneration } satisfies StoredProposalRecord;
  const key = proposalKey(projectId, sessionGeneration);
  await idbSet(key, next);
  const stored = parseStoredProposalRecord(await idbGet<unknown>(key));
  if (!stored || stored.sessionGeneration !== sessionGeneration || !sameRecord(stored, next)) {
    throw new Error('Proposal durability verification failed.');
  }
}
async function existingRecord(projectId: string): Promise<StoredProposalRecord | null> {
  const generation = await currentAgentSessionGeneration(projectId);
  const raw = await idbGet<unknown>(proposalKey(projectId, generation));
  if (raw === undefined) return null;
  const record = parseStoredProposalRecord(raw);
  if (!record) throw new Error('Stored proposal is invalid and was preserved for recovery.');
  return agentSessionGenerationMatches(record.sessionGeneration, generation) ? record : null;
}


export function loadProposalRecord(projectId: string): Promise<StoredProposalRecord | null> {
  return serialize(projectId, () => existingRecord(projectId));
}
export function saveProposalRecord(
  projectId: string,
  record: StoredProposalRecord,
): Promise<void> {
  const parsed = parseStoredProposalRecord(record);
  if (!parsed) return Promise.reject(new Error('Proposal record is invalid.'));
  return serialize(projectId, async () => {
    if (await existingRecord(projectId)) throw new Error('A durable proposal already exists.');
    await persistRecord(projectId, parsed);
  });
}


export async function loadProposal(projectId: string): Promise<Proposal | null> {
  const record = await loadProposalRecord(projectId);
  return record?.phase === 'prepared' ? record.proposal : null;
}

export function saveProposal(projectId: string, proposal: Proposal): Promise<void> {
  const parsed = parseProposal(proposal);
  if (!parsed) return Promise.reject(new Error('Proposal payload is invalid.'));
  const prepared: StoredProposalRecord = { version: 1, phase: 'prepared', proposal: parsed };
  return serialize(projectId, async () => {
    const current = await existingRecord(projectId);
    if (current && (current.phase !== 'prepared' || !sameRecord(current, prepared))) {
      throw new Error('A different durable proposal already exists.');
    }
    await persistRecord(projectId, prepared);
  });
}

export function restorePreparedProposal(projectId: string, proposal: Proposal): Promise<void> {
  const parsed = parseProposal(proposal);
  if (!parsed) return Promise.reject(new Error('Proposal payload is invalid.'));
  return serialize(projectId, async () => {
    const current = await existingRecord(projectId);
    if (!current || current.phase !== 'applying' || current.proposal.id !== parsed.id) {
      throw new Error('Applying proposal recovery does not match the durable proposal.');
    }
    await persistRecord(projectId, { version: 1, phase: 'prepared', proposal: parsed });
  });
}

export function markProposalApplying(
  projectId: string,
  proposal: Proposal,
  resultDoc: ProjectDoc,
  operationCount: number,
): Promise<void> {
  const parsed = parseProposal(proposal);
  const parsedResult = migrateProjectDoc(resultDoc);
  if (!parsed || !parsedResult || !Number.isInteger(operationCount) || operationCount < 0) {
    return Promise.reject(new Error('Proposal application payload is invalid.'));
  }
  return serialize(projectId, async () => {
    const current = await existingRecord(projectId);
    if (!current || current.proposal.id !== parsed.id) {
      throw new Error('Proposal application does not match the durable proposal.');
    }
    await persistRecord(projectId, {
      version: 1,
      phase: 'applying',
      proposal: parsed,
      application: { resultDoc: parsedResult, operationCount, startedAt: Date.now() },
    });
  });
}

export function settleProposal(
  projectId: string,
  proposal: Proposal,
  outcome: ProposalSettlementOutcome,
): Promise<void> {
  return serialize(projectId, async () => {
    const current = await existingRecord(projectId);
    if (!current || current.proposal.id !== proposal.id) {
      throw new Error('Proposal settlement does not match the durable proposal.');
    }
    await persistRecord(projectId, {
      ...current,
      phase: 'settled',
      settlement: { outcome, settledAt: Date.now() },
    });
  });
}

export function clearProposal(projectId: string, expectedProposalId?: string): Promise<void> {
  return serialize(projectId, async () => {
    const current = await existingRecord(projectId);
    if (expectedProposalId && current?.proposal.id !== expectedProposalId) {
      throw new Error('Proposal removal does not match the durable proposal.');
    }
    const generation = await currentAgentSessionGeneration(projectId);
    const key = proposalKey(projectId, generation);
    await idbDel(key);
    if (await idbGet<unknown>(key) !== undefined) {
      throw new Error('Proposal removal durability verification failed.');
    }
  });
}
