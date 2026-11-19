import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultRunRecoveryStorePath, RUN_RECOVERY_SCHEMA_VERSION, RunRecoverySchemaError } from './run-recovery-store-records';
import type { RunRecoveryKey, RunRecoveryAttempt, RunRow, ToolRow } from './run-recovery-store-records';

const ATTEMPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS run_recovery_attempts (
  project_id TEXT NOT NULL,
  session_generation TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  continuation_id TEXT,
  message TEXT,
  message_digest TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  error TEXT,
  PRIMARY KEY (project_id, session_generation, run_id, attempt_number),
  UNIQUE (project_id, session_generation, run_id, continuation_id),
  FOREIGN KEY (project_id, session_generation, run_id)
    REFERENCES run_recovery_runs (project_id, session_generation, run_id) ON DELETE CASCADE
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run_recovery_runs (
  project_id TEXT NOT NULL,
  session_generation TEXT NOT NULL,
  run_id TEXT NOT NULL,
  backend TEXT NOT NULL,
  model TEXT NOT NULL,
  ask_only INTEGER NOT NULL,
  phase TEXT NOT NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  last_continuation_id TEXT,
  reconcile_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  admitted_at INTEGER NOT NULL,
  admission_expires_at INTEGER NOT NULL,
  request_index INTEGER NOT NULL DEFAULT 0,
  request_state TEXT NOT NULL DEFAULT 'pending',
  request_op_boundary INTEGER NOT NULL DEFAULT 0,
  request_options TEXT,
  completion TEXT,
  prompt TEXT,
  messages TEXT,
  tool_names TEXT,
  completed_through_op_seq INTEGER NOT NULL DEFAULT 0,
  next_op_seq INTEGER NOT NULL DEFAULT 1,
  body_bytes INTEGER NOT NULL DEFAULT 0,
  owner_instance TEXT,
  owner_epoch INTEGER NOT NULL DEFAULT 0,
  owner_expires_at INTEGER,
  finalized_at INTEGER,
  execution_input TEXT,
  instructions TEXT,
  execution_state TEXT,
  PRIMARY KEY (project_id, session_generation, run_id)
);
CREATE TABLE IF NOT EXISTS run_recovery_tools (
  project_id TEXT NOT NULL,
  session_generation TEXT NOT NULL,
  run_id TEXT NOT NULL,
  op_seq INTEGER NOT NULL,
  request_index INTEGER NOT NULL DEFAULT 0,
  args TEXT,
  tool_call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  claim_id TEXT,
  success INTEGER,
  result TEXT,
  model_result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_generation, run_id, op_seq),
  UNIQUE (project_id, session_generation, run_id, tool_call_id),
  FOREIGN KEY (project_id, session_generation, run_id)
    REFERENCES run_recovery_runs (project_id, session_generation, run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS run_recovery_tools_by_call
  ON run_recovery_tools (project_id, session_generation, run_id, tool_call_id);
`;

export class RunRecoveryDatabase {
  protected readonly db: DatabaseSync;

  constructor(path: string = defaultRunRecoveryStorePath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    this.db = db;
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec('PRAGMA busy_timeout = 5000;');
      if (path !== ':memory:') {
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec('PRAGMA synchronous = FULL;');
      }
      this.transaction(() => {
        // Re-read after acquiring the migration lock: another process may have
        // completed this migration while this connection waited to begin.
        let version = (db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0;
        if (version === 0) {
          db.exec(SCHEMA);
          db.exec(ATTEMPT_SCHEMA);
          db.exec(`PRAGMA user_version = ${RUN_RECOVERY_SCHEMA_VERSION}`);
          return;
        }
        if (version === 1) {
          db.exec(`ALTER TABLE run_recovery_runs ADD COLUMN reconcile_reason TEXT;
            ALTER TABLE run_recovery_runs ADD COLUMN execution_input TEXT;
            ALTER TABLE run_recovery_runs ADD COLUMN instructions TEXT;
            ALTER TABLE run_recovery_runs ADD COLUMN execution_state TEXT;
            ALTER TABLE run_recovery_tools ADD COLUMN request_index INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE run_recovery_tools ADD COLUMN args TEXT;
            ALTER TABLE run_recovery_tools ADD COLUMN model_result TEXT;
            PRAGMA user_version = 2;`);
          version = 2;
        }
        if (version === 2) {
          db.exec(`ALTER TABLE run_recovery_runs ADD COLUMN request_state TEXT NOT NULL DEFAULT 'inflight';
            ALTER TABLE run_recovery_runs ADD COLUMN request_op_boundary INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE run_recovery_runs ADD COLUMN request_options TEXT;
            ALTER TABLE run_recovery_runs ADD COLUMN completion TEXT;
            UPDATE run_recovery_runs SET request_state = 'pending' WHERE prompt IS NULL;
            PRAGMA user_version = 3;`);
          version = 3;
        }
        if (version === 3) {
          db.exec(`ALTER TABLE run_recovery_runs ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE run_recovery_runs ADD COLUMN last_error TEXT;
            ALTER TABLE run_recovery_runs ADD COLUMN last_continuation_id TEXT;`);
          db.exec(ATTEMPT_SCHEMA);
          db.exec(`INSERT INTO run_recovery_attempts
            (project_id, session_generation, run_id, attempt_number, status, started_at, ended_at)
            SELECT project_id, session_generation, run_id, 1,
              CASE WHEN finalized_at IS NULL THEN 'executing' ELSE 'completed' END,
              admitted_at, finalized_at FROM run_recovery_runs;
            PRAGMA user_version = 4;`);
          version = 4;
        }
        if (version !== RUN_RECOVERY_SCHEMA_VERSION) throw new RunRecoverySchemaError(version);
      });
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  protected transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A failed rollback means the transaction never opened; the original
        // error is the actionable one.
      }
      throw error;
    }
  }

  protected run(key: RunRecoveryKey): RunRow | undefined {
    return this.db.prepare(`
      SELECT * FROM run_recovery_runs
      WHERE project_id = ? AND session_generation = ? AND run_id = ?
    `).get(key.projectId, key.sessionGeneration, key.runId) as RunRow | undefined;
  }

  protected tools(key: RunRecoveryKey): ToolRow[] {
    return this.db.prepare(`
      SELECT op_seq, request_index, args, tool_call_id, name, args_digest, state, claim_id, success, result, model_result, error
      FROM run_recovery_tools
      WHERE project_id = ? AND session_generation = ? AND run_id = ?
      ORDER BY op_seq ASC
    `).all(key.projectId, key.sessionGeneration, key.runId) as unknown as ToolRow[];
  }

  protected attempts(key: RunRecoveryKey): RunRecoveryAttempt[] {
    return (this.db.prepare(`SELECT attempt_number AS attemptNumber, continuation_id AS continuationId,
      message, message_digest AS messageDigest, status, started_at AS startedAt,
      ended_at AS endedAt, error FROM run_recovery_attempts
      WHERE project_id = ? AND session_generation = ? AND run_id = ? ORDER BY attempt_number`)
      .all(key.projectId, key.sessionGeneration, key.runId) as unknown as RunRecoveryAttempt[]);
  }

  protected assertOwner(row: RunRow, epoch: number): void {
    if (row.finalized_at !== null) throw new Error('Agent recovery run is finalized.');
    if (row.owner_epoch !== epoch || row.owner_instance === null) throw new Error('Agent recovery ownership is stale.');
  }

}
