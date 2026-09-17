// Clip references: `occ item ...` takes what a human sees (a name) or what the
// app shows (an id / id prefix), and resolves it against the project document.
// Ambiguity is an error listing the candidates — editing the wrong clip because
// a name repeated on two tracks is silent data damage.
import type { ProjectDoc, Timeline, TimelineItem } from '../src/editor/types.ts';
import { CliError } from './errors.ts';

export interface ClipRef {
  readonly item: TimelineItem;
  readonly timeline: Timeline;
}

function describe(candidates: readonly ClipRef[]): string {
  return candidates
    .slice(0, 10)
    .map(({ item, timeline }) => `  ${item.id}  ${item.name}  ${item.track}  @${item.startFrame}  (${timeline.name})`)
    .join('\n');
}

export function resolveClipRef(doc: ProjectDoc, reference: string): ClipRef {
  const all: ClipRef[] = doc.timelines.flatMap((timeline) => (
    timeline.items.map((item) => ({ item, timeline }))
  ));
  if (all.length === 0) throw new CliError('This project has no clips yet.');

  const exact = all.find(({ item }) => item.id === reference);
  if (exact) return exact;

  const byPrefix = all.filter(({ item }) => item.id.startsWith(reference));
  if (byPrefix.length === 1) return byPrefix[0] as ClipRef;
  if (byPrefix.length > 1) {
    throw new CliError(`Clip id prefix "${reference}" is ambiguous:\n${describe(byPrefix)}`);
  }

  const byName = all.filter(({ item }) => item.name === reference);
  if (byName.length === 1) return byName[0] as ClipRef;
  if (byName.length > 1) {
    throw new CliError(`Clip name "${reference}" is ambiguous:\n${describe(byName)}`);
  }

  throw new CliError(`No clip matches "${reference}".\nClips:\n${describe(all)}`);
}
