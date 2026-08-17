// Agent-initiated local-path import (issue #84 Feature B). Unlike directory
// watches, which wait passively for files to appear, this runs a one-shot
// scan/import of explicitly requested paths — bounded by the user-configured
// AGENT_IMPORT_ROOTS whitelist so an agent can never read arbitrary disks.
import { basename, dirname } from 'node:path';
import { stat, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { getKey } from '../server/keystore.ts';
import type {
  AgentPathImportRequest,
  AgentPathImportResult,
  DirectoryImportedFile,
} from '../shared/directory-import.ts';
import { scanImportDirectory } from './directory-watch.ts';
import {
  canonicalCurrentUploadDirectory,
  importDirectoryCandidate,
  isPathInside,
  type DirectoryCandidateRequest,
} from './directory-watch-import.ts';

export const AGENT_IMPORT_ROOTS_KEY = 'AGENT_IMPORT_ROOTS';

/** Whether a requested path sits inside one of the configured import
 *  roots. Extracted for the check; uses the same containment semantics as
 *  watched folders. */
export function pathAllowedByRoots(roots: readonly string[], path: string): boolean {
  return roots.some((root) => isPathInside(root, path));
}

function authorizedRoots(): readonly string[] {
  const raw = getKey(AGENT_IMPORT_ROOTS_KEY as never).trim();
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

interface CandidatePlan {
  readonly path: string;
  readonly name: string;
  readonly root: string;
}

async function planCandidates(paths: readonly string[]): Promise<{
  candidates: CandidatePlan[];
  errors: Array<{ path: string; error: string }>;
}> {
  const candidates: CandidatePlan[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const roots = authorizedRoots();
  for (const path of paths) {
    if (!roots.length) {
      errors.push({ path, error: 'AGENT_IMPORT_ROOTS is not configured; set the allowed media root directories (comma-separated) in Settings or .env.local first' });
      continue;
    }
    if (!pathAllowedByRoots(roots, path)) {
      errors.push({ path, error: `path is outside the configured import roots (${roots.join(', ')})` });
      continue;
    }
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      errors.push({ path, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (info.isDirectory()) {
      try {
        const scanned = await scanImportDirectory(path, {
          readdir: (dir) => readdir(dir, { withFileTypes: true }) as Promise<Dirent[]>,
        });
        for (const candidate of scanned) {
          candidates.push({ path: candidate.path, name: candidate.name, root: path });
        }
      } catch (error) {
        errors.push({ path, error: error instanceof Error ? error.message : String(error) });
      }
    } else if (info.isFile()) {
      candidates.push({ path, name: basename(path), root: dirname(path) });
    } else {
      errors.push({ path, error: 'not a file or directory' });
    }
  }
  return { candidates, errors };
}

/** One-shot import of agent-requested paths. Imported entries return without
 * importId; the browser side stamps the id when it converts to a pool asset. */
export async function importAgentPaths(
  request: AgentPathImportRequest,
): Promise<AgentPathImportResult> {
  const { candidates, errors } = await planCandidates(request.paths);
  const imported: Array<Omit<DirectoryImportedFile, 'importId'>> = [];
  const pinnedUploadDirectory = await canonicalCurrentUploadDirectory();
  for (const candidate of candidates) {
    const candidateRequest: DirectoryCandidateRequest = {
      sourcePath: candidate.path,
      root: candidate.root,
      name: candidate.name,
      pinnedUploadDirectory,
      knownHashes: new Set(request.knownHashes),
      cancelled: () => false,
      signal: new AbortController().signal,
    };
    try {
      const result = await importDirectoryCandidate(candidateRequest);
      if (result.status === 'imported') {
        imported.push(result.prepared.file);
      } else if (result.status === 'retry') {
        errors.push({ path: candidate.path, error: 'import failed and can be retried' });
      } else {
        // unchanged / duplicate / unsupported: not an error for the agent —
        // the file is already known or intentionally skipped.
      }
    } catch (error) {
      errors.push({ path: candidate.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { imported, errors };
}
