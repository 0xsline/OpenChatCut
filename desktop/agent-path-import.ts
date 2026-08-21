// Agent-initiated local-path import (issue #84 Feature B). Unlike directory
// watches, which wait passively for files to appear, this runs a one-shot
// scan/import of explicitly requested paths — bounded by the user-configured
// AGENT_IMPORT_ROOTS whitelist so an agent can never read arbitrary disks.
import { basename, dirname } from 'node:path';
import { realpath, stat, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { getKey } from '../server/keystore.ts';
import type {
  AgentPathImportRequest,
  AgentPathImportError,
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

async function canonicalRoots(roots: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
  return resolved.filter((root): root is string => root !== null);
}

function outsideRootsError(path: string, roots: readonly string[]): AgentPathImportError {
  return {
    path,
    code: 'PATH_OUTSIDE_IMPORT_ROOTS',
    error: `该路径不在已添加的本地素材目录中。已添加的目录：${roots.join(', ')}`,
  };
}

interface CandidatePlan {
  readonly path: string;
  readonly name: string;
  readonly root: string;
}

async function planCandidates(paths: readonly string[]): Promise<{
  candidates: CandidatePlan[];
  errors: AgentPathImportError[];
}> {
  const candidates: CandidatePlan[] = [];
  const errors: AgentPathImportError[] = [];
  const configuredRoots = authorizedRoots();
  const roots = await canonicalRoots(configuredRoots);
  if (!configuredRoots.length) return {
    candidates,
    errors: paths.map((path) => ({ path, code: 'IMPORT_ROOTS_NOT_CONFIGURED',
      error: 'AGENT_IMPORT_ROOTS 尚未配置。请在 .env.local 中填写允许 Agent 访问的绝对路径。' })),
  };
  for (const path of paths) {
    if (!pathAllowedByRoots(configuredRoots, path)) {
      errors.push(outsideRootsError(path, configuredRoots));
      continue;
    }
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(path);
    } catch (error) {
      errors.push({ path, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!pathAllowedByRoots(roots, canonicalPath)) {
      errors.push(outsideRootsError(path, configuredRoots));
      continue;
    }
    const info = await stat(canonicalPath);
    if (info.isDirectory()) {
      try {
        const scanned = await scanImportDirectory(canonicalPath, {
          readdir: (dir) => readdir(dir, { withFileTypes: true }) as Promise<Dirent[]>,
        });
        for (const candidate of scanned) {
          candidates.push({ path: candidate.path, name: candidate.name, root: canonicalPath });
        }
      } catch (error) {
        errors.push({ path, error: error instanceof Error ? error.message : String(error) });
      }
    } else if (info.isFile()) {
      candidates.push({ path: canonicalPath, name: basename(path), root: dirname(canonicalPath) });
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
  const unsupportedFiles: string[] = [];
  let duplicateCount = 0;
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
      } else if (result.status === 'unsupported') {
        unsupportedFiles.push(candidate.name);
      } else {
        duplicateCount += 1;
      }
    } catch (error) {
      errors.push({ path: candidate.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { imported, errors, unsupportedFiles, duplicateCount };
}
