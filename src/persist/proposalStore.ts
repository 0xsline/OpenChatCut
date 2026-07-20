// Pending Agent edit proposal (propose→apply). Per-project key in the shared
// server-backed KV. Survives refresh/browser changes. Persisted data is untrusted.

import type { AnyAction } from '../editor/store';
import type { TimelineState } from '../editor/types';
import type { Operation, Proposal, ProposalOption } from '../agent/proposal';
import { migrateProjectDoc } from './projectStore';
import {
  kvDel as idbDel,
  kvGet as idbGet,
  kvSet as idbSet,
  resetSharedKvMemory,
} from './sharedKv';

const proposalKey = (projectId: string) => `proposal:${projectId}`;

/** Test helper: wipe the in-memory fallback (no-op when IDB is real). */
export function resetProposalStoreMemory(): void {
  resetSharedKvMemory();
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

/** Validate + normalize a raw IDB value into a Proposal, or null. */
export function parseProposal(raw: unknown): Proposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<Proposal>;
  if (typeof p.title !== 'string' || typeof p.summary !== 'string' || typeof p.totalImpact !== 'string') {
    return null;
  }
  if (!Array.isArray(p.options) || p.options.length === 0 || !p.options.every(isOption)) return null;
  const baseDoc = migrateProjectDoc(p.baseDoc);
  if (!baseDoc) return null;
  if (!isTimelineState(p.resultState)) return null;
  return {
    title: p.title,
    summary: p.summary,
    totalImpact: p.totalImpact,
    options: p.options,
    baseDoc,
    resultState: p.resultState,
  };
}

export async function loadProposal(projectId: string): Promise<Proposal | null> {
  try {
    const raw = await idbGet<unknown>(proposalKey(projectId));
    return parseProposal(raw);
  } catch {
    return null;
  }
}

export async function saveProposal(projectId: string, proposal: Proposal): Promise<void> {
  try {
    await idbSet(proposalKey(projectId), proposal);
  } catch {
    /* ignore quota / private mode — session still works in memory */
  }
}

export async function clearProposal(projectId: string): Promise<void> {
  try {
    await idbDel(proposalKey(projectId));
  } catch {
    /* ignore */
  }
}
