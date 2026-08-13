import assert from 'node:assert/strict';
import { makeDraft, type DraftEngine } from '../../editor/store';
import type { TimelineState } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';

export interface UploadSlot {
  assetId: string;
  existingAsset: boolean;
  filename: string;
  fileKey: string;
  uploadUrl: string;
  size: number;
}

export interface ImportSession {
  sessionId: string;
  state: string;
  slots: UploadSlot[];
  note: string;
}

export interface ReceiptValue {
  sessionId: string;
  assetId: string;
  filename: string;
  projectId: string;
  fileKey: string;
  readUrl: string;
  size: number;
  type: 'audio' | 'gif' | 'image' | 'svg' | 'video';
  contentType: string;
  contentHash: string;
}

export interface ReceiptRecord {
  value: ReceiptValue;
  claimId?: string;
  claimExpiresAt?: number;
  committed?: boolean;
  committedClaimId?: string;
  receiptExpiresAt?: number;
}

export interface UploadVerifierState {
  receiptNow: number;
  mintedTickets: number;
  mintedBodies: Array<Record<string, unknown>>;
  receipts: Map<string, ReceiptRecord>;
  receiptClaims: number;
  failNextNormalization: boolean;
  omitNextRenewedClaimExpiry: boolean;
  commitRequestsToDrop: number;
  commitClaimIds: string[];
}

export interface UploadVerifierFixture {
  state: UploadVerifierState;
  draft: DraftEngine;
  context: AgentContext;
  restore(): void;
}

export function installUploadVerifierFixture(): UploadVerifierFixture {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const state: UploadVerifierState = {
    receiptNow: originalDateNow(),
    mintedTickets: 0,
    mintedBodies: [],
    receipts: new Map(),
    receiptClaims: 0,
    failNextNormalization: false,
    omitNextRenewedClaimExpiry: false,
    commitRequestsToDrop: 0,
    commitClaimIds: [],
  };

  Date.now = () => state.receiptNow;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'http://editor.test' },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      openChatCutDesktop: {
        editorCredentials: async () => ({
          editorToken: 'editor-test-credential',
          mcpToken: 'mcp-test-token',
        }),
      },
    },
  });

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('X-OpenChatCut-Editor-Credential'), null,
      'the retired editor credential header must never be attached');
    if (url === '/api/external-agent/import-token') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      state.mintedBodies.push(body);
      assert.equal(body.projectId, 'project-test');
      assert.equal(body.method, 'POST');
      const query = new URLSearchParams({
        name: String(body.filename),
        sessionId: String(body.sessionId),
        assetId: String(body.assetId),
        assetType: String(body.assetType),
        projectId: String(body.projectId),
        handoff: `ticket-${state.mintedTickets += 1}`,
      });
      return Response.json({
        uploadUrl: `/upload?${query.toString()}`,
        expiresAt: Date.now() + 300_000,
        expiresInSeconds: 300,
        allowedMethods: ['POST'],
      }, { status: 201 });
    }
    if (url === '/api/external-agent/upload-receipt') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const receipt = typeof body.receipt === 'string' ? body.receipt : '';
      const record = state.receipts.get(receipt);
      if (!record || body.projectId !== record.value.projectId) {
        return Response.json({ error: 'invalid receipt' }, { status: 409 });
      }
      if (body.action === 'claim') {
        state.receiptClaims += 1;
        const claimActive = record.claimId && (record.claimExpiresAt ?? 0) > Date.now();
        const receiptActive = (record.receiptExpiresAt ?? Number.POSITIVE_INFINITY) > Date.now();
        if (record.committed || (!receiptActive && !claimActive)
          || (claimActive && record.claimId !== body.claimId)) {
          return Response.json({ error: 'receipt unavailable' }, { status: 409 });
        }
        if (typeof body.claimId !== 'string') {
          return Response.json({ error: 'claim id required' }, { status: 409 });
        }
        const renewing = record.claimId === body.claimId;
        record.claimId = body.claimId;
        record.claimExpiresAt = Date.now() + 60_000;
        const omitExpiry = renewing && state.omitNextRenewedClaimExpiry;
        if (omitExpiry) state.omitNextRenewedClaimExpiry = false;
        return Response.json({
          receipt,
          ...record.value,
          claimId: record.claimId,
          ...(omitExpiry ? {} : { claimExpiresAt: record.claimExpiresAt }),
        });
      }
      if (body.action === 'commit' && typeof body.claimId === 'string') {
        state.commitClaimIds.push(body.claimId);
        if (state.commitRequestsToDrop > 0) {
          state.commitRequestsToDrop -= 1;
          throw new Error('simulated commit dropped before server');
        }
        const activeClaim = body.claimId === record.claimId
          && (record.claimExpiresAt ?? 0) > Date.now();
        const matchingTombstone = record.committed && body.claimId === record.committedClaimId
          && (record.receiptExpiresAt ?? Number.POSITIVE_INFINITY) > Date.now();
        if (activeClaim || matchingTombstone) {
          record.committed = true;
          record.committedClaimId = body.claimId;
          record.claimId = undefined;
          return Response.json({ ok: true, state: 'committed' });
        }
      }
      if (body.action === 'abort' && body.claimId === record.claimId && !record.committed) {
        record.claimId = undefined;
        record.claimExpiresAt = undefined;
        return Response.json({ ok: true, state: 'available' });
      }
      return Response.json({ error: 'invalid claim' }, { status: 409 });
    }
    if (url === '/api/normalize-media') {
      if (state.failNextNormalization) {
        state.failNextNormalization = false;
        return Response.json({ error: 'normalization unavailable' }, { status: 503 });
      }
      const body = JSON.parse(String(init?.body)) as { src: string };
      return Response.json({
        path: body.src,
        normalized: false,
        durationSeconds: 2,
        bytes: 4096,
        width: 1920,
        height: 1080,
      });
    }
    throw new Error(`unexpected fetch target: ${url}`);
  };

  const timeline: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    items: [],
  };
  const draft = makeDraft(docFromTimeline(timeline));
  const context: AgentContext = {
    commands: draft.commands,
    getState: draft.getState,
    getDoc: draft.getDoc,
    getProjectId: () => 'project-test',
    getCreativeMode: () => null,
    templates: [],
    audio: [],
  };

  return {
    state,
    draft,
    context,
    restore() {
      Date.now = originalDateNow;
      globalThis.fetch = originalFetch;
      if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
      else Reflect.deleteProperty(globalThis, 'location');
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    },
  };
}
