import assert from 'node:assert/strict';
import { transcriptParagraphs, transcriptTimestamp } from './transcriptParagraphs';

const word = (text: string, start: number, end: number) => ({ text, start, end });

// Continuous speech stays in one paragraph.
assert.deepEqual(
  transcriptParagraphs([word('你', 0, 0.2), word('好', 0.2, 0.4), word('啊', 0.4, 0.6)]),
  [{ start: 0, text: '你好啊' }],
  'no gap keeps one paragraph',
);

// A gap > 0.8s opens a new paragraph carrying its own start time.
assert.deepEqual(
  transcriptParagraphs([word('第一句', 0, 0.8), word('第二句', 2.5, 3.1)]),
  [
    { start: 0, text: '第一句' },
    { start: 2.5, text: '第二句' },
  ],
  'gap > 0.8s splits paragraphs',
);

// A gap ≤ 0.8s merges (boundary inclusive).
assert.deepEqual(
  transcriptParagraphs([word('a', 0, 0.4), word('b', 1.2, 1.6)]),
  [{ start: 0, text: 'ab' }],
  'gap exactly 0.8s merges',
);

// Empty input yields no paragraphs.
assert.deepEqual(transcriptParagraphs([]), [], 'empty transcript');

// Chinese text concatenates without spaces; mixed text preserves word text.
assert.equal(
  transcriptParagraphs([word('我', 0, 0.3), word('们', 0.3, 0.6)])[0]?.text,
  '我们',
  'concatenation is verbatim',
);

// Timestamps: seconds → m:ss.
assert.equal(transcriptTimestamp(0), '0:00');
assert.equal(transcriptTimestamp(5), '0:05');
assert.equal(transcriptTimestamp(65), '1:05');
assert.equal(transcriptTimestamp(605), '10:05');

console.log('transcriptParagraphs.verify: paragraphing and timestamps passed');
