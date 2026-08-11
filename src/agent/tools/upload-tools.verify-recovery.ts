import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { MediaAsset } from '../../editor/types';
import { loadUploadFinalizeJournal } from '../../persist/uploadFinalizeStore';
import type { AgentContext } from '../context';
import { execUploadTool } from './upload-tools';
import type { ReceiptRecord, UploadVerifierFixture } from './upload-tools.verify-fixture';

export async function verifyUploadFinalizeRecovery(fixture: UploadVerifierFixture): Promise<void> {
  const { context, draft, state } = fixture;
  const reconciliationReceipt: ReceiptRecord = {
    value: {
      sessionId: 'sess_reconciliation',
      assetId: 'reconciliation-asset',
      filename: 'reconciliation.gif',
      projectId: 'project-test',
      fileKey: 'uploads/reconciliation-asset.gif',
      readUrl: '/media/uploads/reconciliation-asset.gif',
      size: 768,
      type: 'gif',
      contentType: 'image/gif',
      contentHash: 'bc'.repeat(32),
    },
    receiptExpiresAt: state.receiptNow + 10 * 60_000,
  };
  state.receipts.set('receipt-reconciliation', reconciliationReceipt);
  let reconciliationMutations = 0;
  const countingCommands = (base: AgentContext['commands']): AgentContext['commands'] => new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'addAsset') {
        return (asset: MediaAsset) => {
          reconciliationMutations += 1;
          target.addAsset(asset);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const reconciliationContext: AgentContext = {
    ...context,
    commands: countingCommands(context.commands),
  };
  state.omitNextRenewedClaimExpiry = true;
  const invalidRenewal = await execUploadTool('finalize_uploaded_asset', {
    receipt: 'receipt-reconciliation',
    assetType: 'gif',
    durationInSeconds: 2,
    width: 320,
  }, reconciliationContext) as { error?: string };
  assert.match(invalidRenewal.error ?? '', /claim expired or was superseded/);
  assert.equal(reconciliationMutations, 0, 'a renewal without claimExpiresAt cannot precede mutation');
  assert.equal(reconciliationReceipt.claimId, undefined, 'invalid renewal must abort its claim');

  const preReconciliationDoc = structuredClone(draft.getDoc());
  const commitClaimsStart = state.commitClaimIds.length;
  state.commitRequestsToDrop = 2;
  const pendingCommit = await execUploadTool('finalize_uploaded_asset', {
    receipt: 'receipt-reconciliation',
    assetType: 'gif',
    durationInSeconds: 2,
    width: 320,
  }, reconciliationContext) as {
    error?: string; receiptCommit?: string; width?: number; durationInFrames?: number;
  };
  assert.equal(pendingCommit.error, undefined, 'dropped commit requests are not terminal after mutation');
  assert.equal(pendingCommit.receiptCommit, 'reconciliation_pending');
  assert.equal(pendingCommit.width, 320);
  assert.equal(pendingCommit.durationInFrames, 60);
  assert.equal(reconciliationMutations, 1, 'ProjectDoc mutation must happen exactly once');
  const durableJournal = await loadUploadFinalizeJournal('project-test', 'receipt-reconciliation');
  assert.equal(durableJournal?.status, 'mutation_applied');
  assert.equal(durableJournal?.result.durationInFrames, 60);

  const reloadedDraft = makeDraft(preReconciliationDoc);
  const reloadedContext: AgentContext = {
    ...context,
    commands: countingCommands(reloadedDraft.commands),
    getState: reloadedDraft.getState,
    getDoc: reloadedDraft.getDoc,
  };
  state.receiptNow += 60_001;
  const reconciledCommit = await execUploadTool('finalize_uploaded_asset', {
    receipt: 'receipt-reconciliation',
    assetType: 'gif',
    durationInSeconds: 9,
    width: 999,
  }, reloadedContext) as {
    receiptCommit?: string; width?: number; durationInFrames?: number;
  };
  assert.equal(reconciledCommit.receiptCommit, 'committed');
  assert.equal(reconciledCommit.width, 320, 'retry dimensions cannot replace the journaled result');
  assert.equal(reconciledCommit.durationInFrames, 60, 'retry duration cannot replace the journaled result');
  assert.equal(reconciliationMutations, 2, 'reload recovery reapplies a missing add exactly once');
  assert.equal(reconciliationReceipt.committed, true);
  assert.equal(
    reloadedDraft.getDoc().assets.find((asset) => asset.id === 'reconciliation-asset')?.transcribeStatus,
    undefined,
    'finalize journal recovery must not start ASR',
  );
  assert.equal(await loadUploadFinalizeJournal('project-test', 'receipt-reconciliation'), null,
    'journal is deleted only after the terminal commit tombstone is confirmed');
  const reconciliationClaimIds = state.commitClaimIds.slice(commitClaimsStart);
  assert.ok(reconciliationClaimIds.length >= 4, 'dropped requests must retry after same-claim renewal');
  assert.equal(new Set(reconciliationClaimIds).size, 1, 'reconciliation must retain the same claim identity');

  const commandFailureReceipt: ReceiptRecord = { value: {
    sessionId: 'sess_command_failure',
    assetId: 'command-failure-asset',
    filename: 'retry.png',
    projectId: 'project-test',
    fileKey: 'uploads/command-failure-asset.png',
    readUrl: '/media/uploads/command-failure-asset.png',
    size: 512,
    type: 'image',
    contentType: 'image/png',
    contentHash: 'de'.repeat(32),
  } };
  state.receipts.set('receipt-command-failure', commandFailureReceipt);
  const commandFailureContext: AgentContext = {
    ...context,
    commands: new Proxy(context.commands, {
      get(target, property, receiver) {
        if (property === 'addAsset') {
          return () => {
            throw new Error('simulated editor command failure');
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }),
  };
  const commandFailure = await execUploadTool('finalize_uploaded_asset', {
    receipt: 'receipt-command-failure',
    assetType: 'image',
  }, commandFailureContext) as { error?: string };
  assert.match(commandFailure.error ?? '', /simulated editor command failure/);
  assert.equal(commandFailureReceipt.claimId, undefined, 'editor command failure must abort the claim');
  assert.equal(commandFailureReceipt.committed, undefined);
  const commandRetry = await execUploadTool('finalize_uploaded_asset', {
    receipt: 'receipt-command-failure',
    assetType: 'image',
  }, context) as { assetId?: string };
  assert.equal(commandRetry.assetId, 'command-failure-asset');
  assert.equal(commandFailureReceipt.committed, true);
}
