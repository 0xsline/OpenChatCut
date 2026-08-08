import { joinCaptionWords } from './types';

export interface CaptionWordRun<Word> {
  startIndex: number;
  words: Word[];
}

/** Keep script-contiguous words in one flex run so CJK tokens render without synthetic gaps. */
export function buildCaptionWordRuns<Word extends { text: string }>(
  words: readonly Word[],
  stacked: boolean,
): CaptionWordRun<Word>[] {
  const runs: CaptionWordRun<Word>[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const previous = words[index - 1];
    const run = runs[runs.length - 1];
    const continuous = !stacked
      && previous !== undefined
      && joinCaptionWords([previous, word]) === `${previous.text}${word.text}`;
    if (continuous && run) run.words.push(word);
    else runs.push({ startIndex: index, words: [word] });
  }
  return runs;
}
