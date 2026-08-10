// Chinese-aware text segmentation for the FTS5 search index (phase C-2).
//
// jieba-wasm provides dictionary-based segmentation with no native bindings
// (WASM). Indexed/query text is split into space-separated tokens so the
// plain unicode61 FTS5 tokenizer can match 2-char Chinese words ("字幕",
// "转场") — which trigram cannot. Domain terms (project/asset names) can be
// injected via addDomainWords and survive in the shared dictionary.
import { cut, add_word } from 'jieba-wasm';

let initialized = false;
const domainWords = new Set<string>();

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  for (const word of domainWords) {
    try {
      add_word(word, 10);
    } catch {
      // Dictionary mutations are best-effort; unknown words still match via
      // their component tokens.
    }
  }
}

/** Register domain terms (project names, asset names, user names). */
export function addDomainWords(words: readonly string[]): void {
  for (const word of words) {
    if (word && word.trim().length > 0) domainWords.add(word.trim());
  }
  if (initialized) {
    for (const word of domainWords) {
      try {
        add_word(word, 10);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Segment a text into index tokens. Latin words and numbers are preserved as
 * single tokens; Chinese runs are dictionary-segmented. Returns tokens joined
 * with spaces, ready for FTS5 unicode61 indexing or MATCH queries.
 */
export function segmentForIndex(text: string): string {
  if (!text) return '';
  ensureInitialized();
  const tokens: string[] = [];
  // Keep latin/number runs intact while jieba handles CJK and mixed runs.
  const latin = /[A-Za-z0-9]+/y;
  const rest = /[^A-Za-z0-9]+/y;
  let index = 0;
  while (index < text.length) {
    latin.lastIndex = index;
    const latinMatch = latin.exec(text);
    if (latinMatch && latinMatch.index === index) {
      tokens.push(latinMatch[0]);
      index += latinMatch[0].length;
      continue;
    }
    rest.lastIndex = index;
    const restMatch = rest.exec(text);
    if (restMatch && restMatch.index === index) {
      for (const word of cut(restMatch[0], true)) {
        if (word.trim()) tokens.push(word.trim());
      }
      index += restMatch[0].length;
      continue;
    }
    index += 1;
  }
  return tokens.join(' ');
}
