import { getLocale } from '../i18n/locale';

export interface ToolExecutionOutcome {
  readonly success: boolean;
  readonly result: unknown;
}
export interface PersistedToolFailure {
  readonly name: string;
  readonly reason: string;
}

function recordResult(result: unknown): Record<string, unknown> | null {
  return result !== null && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null;
}

/** Tool handlers may report a rejected operation as data instead of throwing. */
export function isFailedToolResult(result: unknown): boolean {
  const record = recordResult(result);
  if (!record) return false;
  if (record.ok === false || record.success === false || record.aborted === true) return true;
  return typeof record.error === 'string'
    && record.error.trim().length > 0
    && record.ok !== true
    && record.success !== true;
}

export function toolFailureReason(result: unknown): string {
  if (result instanceof Error) return result.message.trim() || result.name;
  const record = recordResult(result);
  if (record) {
    for (const field of ['error', 'message', 'note'] as const) {
      const value = record[field];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  if (typeof result === 'string' && result.trim()) return result.trim();
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** A successful retry of the same tool resolves its latest failure. */
export class ToolFailureTracker {
  readonly #unresolved = new Map<string, string>();

  record(name: string, outcome: ToolExecutionOutcome): void {
    const result = recordResult(outcome.result);
    if (outcome.success && result?.denied === true) return;
    if (outcome.success) this.#unresolved.delete(name);
    else this.#unresolved.set(name, toolFailureReason(outcome.result));
  }

  get hasUnresolved(): boolean {
    return this.#unresolved.size > 0;
  }

  clear(): void {
    this.#unresolved.clear();
  }

  snapshot(): PersistedToolFailure[] {
    return [...this.#unresolved].map(([name, reason]) => ({ name, reason }));
  }

  restore(value: unknown): void {
    this.clear();
    if (!Array.isArray(value)) return;
    for (const entry of value.slice(0, 64)) {
      if (!entry || typeof entry !== 'object') continue;
      const { name, reason } = entry as { name?: unknown; reason?: unknown };
      if (typeof name !== 'string' || !name.trim() || name.length > 256) continue;
      if (typeof reason !== 'string' || !reason.trim()) continue;
      this.#unresolved.set(name, reason.slice(0, 4_096));
    }
  }

  report(): string {
    const details = [...this.#unresolved]
      .map(([name, reason]) => `${name}: ${reason}`)
      .join('; ');
    const locale = getLocale();
    if (locale === 'zh') {
      return `有工具调用失败，未能完成请求（${details}）。本次没有成功执行的记录。`;
    }
    if (locale === 'ru') {
      return `Запрос не выполнен из-за сбоя инструмента (${details}). Успешное выполнение этой операции не зафиксировано.`;
    }
    return `I couldn't complete the requested operation because a tool failed (${details}). No success was recorded for the failed operation.`;
  }
}
