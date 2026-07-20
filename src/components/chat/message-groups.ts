import type { DisplayMessage } from '../../agent/useAgent';

// Collapse a run of consecutive SAME-name tool messages into one group so the chat
// doesn't spam 20 identical `edit_gap` rows — repeats render as one compact activity line.
// Distinct/one-off tool calls stay as their own rows — only repeats fold.

export type RenderItem =
  | { kind: 'single'; msg: DisplayMessage; index: number }
  | { kind: 'toolgroup'; name: string; items: { msg: DisplayMessage; index: number }[]; index: number };

/** Fold this many+ consecutive same-tool calls into a collapsible group. */
export const GROUP_MIN = 3;

export function groupMessages(messages: DisplayMessage[]): RenderItem[] {
  const out: RenderItem[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    const name = m.role === 'tool' ? m.tool?.name : undefined;
    if (name) {
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool' && messages[j].tool?.name === name) j++;
      const run = j - i;
      if (run >= GROUP_MIN) {
        const items = [];
        for (let k = i; k < j; k++) items.push({ msg: messages[k], index: k });
        out.push({ kind: 'toolgroup', name, items, index: i });
        i = j;
        continue;
      }
    }
    out.push({ kind: 'single', msg: m, index: i });
    i++;
  }
  return out;
}
