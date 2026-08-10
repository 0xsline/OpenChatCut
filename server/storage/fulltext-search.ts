// Full-text search over chat/captions/transcripts (phase C-2).
//
// FTS5 (unicode61) rows are written eagerly when chat:/project: keys land in
// the SQLite store (content-hash gated), so the index stays fresh without a
// background job. Searches tokenize the query with the same jieba pipeline
// and rank with bm25().
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sqliteStoreEnabled, storePath } from './sqlite-store.ts';
import { segmentForIndex } from './search-tokenizer.ts';

const FTS_TABLE = 'search_fts';
const STATE_TABLE = 'search_state';

export interface SearchHit {
  kind: 'chat' | 'caption' | 'transcript';
  projectId: string;
  ref: string;
  snippet: string;
  score: number;
}

let connection: DatabaseSync | null = null;

function openSearchConnection(): DatabaseSync | null {
  if (connection) return connection;
  if (!sqliteStoreEnabled()) return null;
  try {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    db.exec(`CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
      k TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL
    )`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
      kind, project_id, content, ref, tokenize = 'unicode61'
    )`);
    connection = db;
    return db;
  } catch {
    // Search is an enhancement; never break the store when unavailable.
    return null;
  }
}

/** Close the connection (verify isolation / profile switches). */
export function resetSearchForTests(): void {
  connection?.close();
  connection = null;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function textOfChat(value: unknown): Array<{ ref: string; text: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const chat = value as { messages?: unknown };
  if (!Array.isArray(chat.messages)) return [];
  const rows: Array<{ ref: string; text: string }> = [];
  chat.messages.forEach((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const row = message as { role?: unknown; text?: unknown; thinking?: unknown; tool?: { name?: unknown } };
    const parts: string[] = [];
    if (typeof row.text === 'string') parts.push(row.text);
    if (typeof row.thinking === 'string') parts.push(row.thinking);
    if (row.tool && typeof row.tool === 'object' && typeof row.tool.name === 'string') {
      parts.push(`[${row.tool.name}]`);
    }
    const text = parts.join(' ').trim();
    if (text) rows.push({ ref: `${index}`, text });
  });
  return rows;
}

function textOfProject(value: unknown): { captions: string; transcript: string } {
  // Caption cues carry startFrame; transcript words do not. Walk the whole
  // project document and bucket text fields accordingly.
  const captions: string[] = [];
  const transcript: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.text === 'string' && typeof record.startFrame === 'number') {
      captions.push(record.text);
      return; // a cue leaf
    }
    if (typeof record.text === 'string') {
      transcript.push(record.text);
      // still walk children: a cue may also nest a transcript source
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') walk(child);
    }
  };
  walk(value);
  return {
    captions: captions.join(' '),
    transcript: transcript.filter((word) => word.trim().length > 0).join(' '),
  };
}

/** Index (or refresh) one store key's searchable content. Hash-gated. */
export function indexStoreKey(key: string, value: unknown): void {
  const db = openSearchConnection();
  if (!db) return;
  if (!key.startsWith('chat:') && !key.startsWith('project:')) return;
  const digest = sha256(JSON.stringify(value ?? null));
  const state = db.prepare(`SELECT sha256 FROM ${STATE_TABLE} WHERE k = ?`).get(key) as
    | { sha256: string }
    | undefined;
  if (state && state.sha256 === digest) return;

  const projectId = key.startsWith('chat:')
    ? key.slice('chat:'.length)
    : key.slice('project:'.length);

  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM ${FTS_TABLE} WHERE project_id = ? AND ref LIKE ?`).run(projectId, `${key}%`);
    const insert = db.prepare(
      `INSERT INTO ${FTS_TABLE} (kind, project_id, content, ref) VALUES (?, ?, ?, ?)`,
    );
    if (key.startsWith('chat:')) {
      for (const row of textOfChat(value)) {
        const content = segmentForIndex(row.text);
        if (content) insert.run('chat', projectId, content, `${key}:${row.ref}`);
      }
    } else {
      const { captions, transcript } = textOfProject(value);
      const captionContent = segmentForIndex(captions);
      if (captionContent) insert.run('caption', projectId, captionContent, `${key}:captions`);
      const transcriptContent = segmentForIndex(transcript);
      if (transcriptContent) insert.run('transcript', projectId, transcriptContent, `${key}:transcript`);
    }
    db.prepare(
      `INSERT INTO ${STATE_TABLE} (k, sha256) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET sha256 = excluded.sha256`,
    ).run(key, digest);
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
  }
}

/** Drop every search row of a store key (delete/purge paths). */
export function removeStoreKey(key: string): void {
  const db = openSearchConnection();
  if (!db) return;
  try {
    db.prepare(`DELETE FROM ${FTS_TABLE} WHERE ref LIKE ?`).run(`${key}%`);
    db.prepare(`DELETE FROM ${STATE_TABLE} WHERE k = ?`).run(key);
  } catch {
    // best-effort
  }
}

export interface SearchOptions {
  projectId?: string;
  limit?: number;
}

/** Tokenize the query with the same pipeline and run bm25-ranked MATCH. */
export function searchContent(query: string, options: SearchOptions = {}): SearchHit[] {
  const db = openSearchConnection();
  if (!db) return [];
  const tokens = segmentForIndex(query.trim());
  if (!tokens) return [];
  const bounded = Math.min(50, Math.max(1, Math.round(Number(options.limit) || 20)));
  let sql = `SELECT kind, project_id, ref, bm25(${FTS_TABLE}) AS score
    FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ?`;
  const params: Array<string | number> = [tokens];
  if (options.projectId) {
    sql += ' AND project_id = ?';
    params.push(options.projectId);
  }
  sql += ' ORDER BY score LIMIT ?';
  params.push(bounded);
  try {
    const rows = db.prepare(sql).all(...params) as Array<{
      kind: 'chat' | 'caption' | 'transcript';
      project_id: string;
      ref: string;
      score: number;
    }>;
    return rows.map((row) => ({
      kind: row.kind,
      projectId: row.project_id,
      ref: row.ref,
      snippet: '',
      score: -row.score,
    }));
  } catch {
    return [];
  }
}

/** Rebuild the whole index from the kv table (post-migration backfill). */
export function rebuildSearchIndex(): { indexed: number } {
  const db = openSearchConnection();
  if (!db) return { indexed: 0 };
  let rows: Array<{ k: string; v: string }>;
  try {
    rows = db.prepare('SELECT k, v FROM kv WHERE k LIKE ? OR k LIKE ?').all(
      'chat:%',
      'project:%',
    ) as Array<{ k: string; v: string }>;
  } catch {
    return { indexed: 0 }; // kv table not created yet (no store writes so far)
  }
  for (const row of rows) {
    try {
      indexStoreKey(row.k, JSON.parse(row.v));
    } catch {
      // skip unreadable rows
    }
  }
  return { indexed: rows.length };
}
