import type { ModelMessage } from 'ai';
import { codexToolInput } from '../../src/agent/codex/tool-history';
import type { ServerRunToolRecord } from './run-recovery-contract';

/**
 * One reconstructed history entry for a confirmed tool call confirmed before a restart.
 *
 * This is deliberately not `codexToolHistoryEntry`: that helper re-compacts the
 * live result and injects tool-activation provider options. A resumed request
 * has to carry exactly what the interrupted turn would have shown the model —
 * the result projection stored at outcome time — and nothing that depends on a
 * tool having been executed in this process.
 */
export function codexTurnHistoryEntry(record: ServerRunToolRecord): ModelMessage {
  const text = [
    `[tool call: ${record.name}] ${codexToolInput(record.args ?? { argsDigest: record.argsDigest, opSeq: record.opSeq })}`,
    `[tool result: ${record.name}; success=${record.success}] ${codexToolInput(record.result)}`,
  ].join('\n');
  return { role: 'assistant', content: text };
}
