import type { ProjectDoc } from '../../editor/types';

export interface ProjectMigrationProgress {
  fromVersion: number;
  toVersion: number;
  completedSteps: number;
  totalSteps: number;
}

export interface ProjectMigrationOptions {
  onProgress?: (progress: ProjectMigrationProgress) => void;
}

export interface ProjectMigrationResult {
  doc: ProjectDoc;
  sourceVersion: number;
  appliedSteps: readonly string[];
}

export interface ProjectMigrationStep {
  id: string;
  fromVersion: number;
  toVersion: number;
  migrate: (value: unknown) => unknown;
}
