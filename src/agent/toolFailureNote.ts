// The quiet note a server run leaves behind when a tool failed and the model answered anyway.
//
// The executor used to turn this into a failed run with an English template under the
// model's reply. Now it pushes a `tool-failures` event and completes; the chat shows one
// muted line and the inspector lists the calls, so a reply that glosses over a failure
// can still be caught without contradicting the reply itself.
import { t } from '../i18n/locale';
import type { PersistedToolFailure } from './toolFailure';

const REASON_LIMIT = 160;

export function parseToolFailures(value: unknown): PersistedToolFailure[] {
  if (!Array.isArray(value)) return [];
  const failures: PersistedToolFailure[] = [];
  for (const entry of value.slice(0, 64)) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, reason } = entry as { name?: unknown; reason?: unknown };
    if (typeof name !== 'string' || !name.trim() || typeof reason !== 'string' || !reason.trim()) continue;
    failures.push({ name: name.trim(), reason: reason.trim() });
  }
  return failures;
}

function clip(text: string): string {
  return text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT - 1)}…` : text;
}

/** One line in the interface language; empty when there is nothing to report. */
export function toolFailureNoteText(failures: readonly PersistedToolFailure[]): string {
  if (failures.length === 0) return '';
  const details = failures.map((failure) => `${failure.name}: ${clip(failure.reason)}`).join('；');
  return t('本轮有 {n} 个工具调用失败，模型已据此作答：{details}', { n: failures.length, details });
}
