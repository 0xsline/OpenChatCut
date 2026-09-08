// Retry re-runs a turn; it does not ask again after it.
//
// Re-sending the same text as a new turn left the failed attempt in what the model sees:
// the error, a half-finished tool call, and now two identical user messages. The second
// try then reasons about the first one ("that tool times out, try something else") instead
// of doing the work. So a retry rewinds both histories to just before the turn and sends
// it again from that state.
//
// The two histories are kept in step by user turns: every send appends exactly one user
// message to the display history and one to the model history, so the n-th user turn from
// the end of one is the n-th from the end of the other. That is confirmed by text before it
// is used; when it does not hold (a compacted history, a legacy chat, a model-only user
// message such as a proposal rejection) the plan is null and the caller keeps the plain
// re-send, which is always safe.
import type { DisplayMessage } from './agent-session';
import type { LLMMessage } from './runtime';

export interface RetryRewindPlan {
  /** Keep display messages [0, messages). */
  readonly messages: number;
  /** Keep model messages [0, llm). */
  readonly llm: number;
}

function modelText(message: LLMMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

/** The model copy of a user turn is the text itself, or the text followed by attached context. */
function sameTurn(modelContent: string, displayText: string): boolean {
  const model = modelContent.trim();
  const display = displayText.trim();
  return model === display || model.startsWith(`${display}\n`);
}

export function planRetryRewind(
  messages: readonly DisplayMessage[],
  llm: readonly LLMMessage[],
  index: number,
): RetryRewindPlan | null {
  const target = messages[index];
  if (!target || target.role !== 'user' || !target.text.trim()) return null;
  let ordinal = 0;
  for (let i = messages.length - 1; i >= index; i -= 1) {
    if (messages[i]!.role === 'user') ordinal += 1;
  }
  let seen = 0;
  for (let i = llm.length - 1; i >= 0; i -= 1) {
    const message = llm[i]!;
    if (message.role !== 'user') continue;
    seen += 1;
    if (seen < ordinal) continue;
    return sameTurn(modelText(message), target.text) ? { messages: index, llm: i } : null;
  }
  return null;
}
