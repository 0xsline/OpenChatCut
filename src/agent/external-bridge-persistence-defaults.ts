import { saveExternalProposal } from '../persist/externalProposalStore';
import { saveProject } from '../persist/projectStore';
import { saveAutomaticVersion } from '../persist/versionStore';
import type { ExternalBridgePersistence } from './external-proposal-apply';

export const DEFAULT_EXTERNAL_BRIDGE_PERSISTENCE: ExternalBridgePersistence = {
  saveProject,
  saveAutomaticVersion,
  saveExternalProposal,
};

export const EXTERNAL_PROJECT_INDEX_WARNING =
  'The edit was applied, but the project list timestamp could not be updated.';
