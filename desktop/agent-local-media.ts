import { opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import {
  AGENT_LOCAL_MEDIA_MAX_ENTRIES,
  isAgentLocalMediaRequest,
  type AgentLocalMediaEntry,
  type AgentLocalMediaResult,
} from '../shared/agent-local-media.ts';
import { resolveAgentMediaPath } from './agent-path-import.ts';
import { directoryMediaKind } from './directory-watch-import.ts';

export async function browseLocalMedia(request: unknown): Promise<AgentLocalMediaResult> {
  if (!isAgentLocalMediaRequest(request)) throw new Error('invalid local media browse request');
  const root = await resolveAgentMediaPath(request.path ?? homedir());
  const query = (request.query ?? '').toLocaleLowerCase();
  const entries: AgentLocalMediaEntry[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const queue = [{ path: root, depth: 0 }];
  let scanned = 0;
  let truncated = false;
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    try {
      // Re-check explicit roots before opening each directory.
      const directory = await resolveAgentMediaPath(current.path);
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (++scanned > AGENT_LOCAL_MEDIA_MAX_ENTRIES) { truncated = true; break; }
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory() && request.recursive) {
          if (current.depth < 12) queue.push({ path, depth: current.depth + 1 });
          else truncated = true;
        }
        const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? directoryMediaKind(entry.name) : undefined;
        if (!kind || (request.kind && kind !== request.kind)
          || !relative(root, path).toLocaleLowerCase().includes(query)) continue;
        try {
          const info = await stat(await resolveAgentMediaPath(path));
          entries.push({ path, name: entry.name, kind,
            ...(kind === 'directory' ? {} : { size: info.size, modifiedAt: info.mtimeMs }),
          });
        } catch (error) {
          errors.push({ path, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      if (index === 0) throw error;
      errors.push({ path: current.path, error: error instanceof Error ? error.message : String(error) });
    }
    if (scanned > AGENT_LOCAL_MEDIA_MAX_ENTRIES) break;
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const offset = request.offset ?? 0;
  const end = offset + (request.limit ?? 100);
  return { path: root, entries: entries.slice(offset, end),
    nextOffset: end < entries.length ? end : null, truncated, errors: errors.slice(0, 50),
  };
}
