import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import { projectedHistory } from './serverRunProtocol';

// projectedHistory keeps text plus image/image-file attachments so visual
// input is passed through to the server-side executor instead of dropped.

const textMsg: ModelMessage = { role: 'user', content: 'make a cut here' };
const imageMsg: ModelMessage = {
  role: 'user',
  content: [
    { type: 'text' as const, text: 'what is in this frame?' },
    { type: 'image' as const, image: 'data:image/png;base64,AAAA' },
  ],
};
const fileImgMsg: ModelMessage = {
  role: 'user',
  content: [
    { type: 'file' as const, data: { type: 'data' as const, data: 'BBBB' }, mediaType: 'image/jpeg' },
  ],
};
const fileNonImgMsg: ModelMessage = {
  role: 'system',
  content: 'system text must never leak into run history',
};

const out = projectedHistory([fileNonImgMsg, textMsg, imageMsg, fileImgMsg]);

// Non-user/assistant messages (system/tool) are dropped.
assert.ok(!out.find((m) => m.role === 'system' || m.role === 'tool'), 'system/tool dropped from run history');

// Pure text survives as a trimmed string.
assert.ok(out.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('make a cut here')), 'text message survives');

// The data: image attachment is projected to a file part (base64 kept).
const imageProjected = out.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => (p as { type?: string }).type === 'file'));
assert.ok(imageProjected, 'data: image attachment projected to a file part');
const imageParts = (imageProjected!.content as Array<{ type?: string; data?: { data?: string }; mediaType?: string }>)
  .filter((p) => p.type === 'file');
const imageData = imageParts[0]?.data?.data;
assert.equal(imageData, 'AAAA', 'image base64 carried through from data: URL');
assert.equal(imageParts[0]?.mediaType, 'image/png', 'media type inferred from data URL');

// A plain image/file attachment (mediaType image/*) is also kept.
const fileProjected = out.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => (p as { type?: string }).type === 'file' && (p as { data?: { data?: string } }).data?.data === 'BBBB'));
assert.ok(fileProjected, 'image file attachment also projected');

// Non-visual non-text parts are dropped; text stays bounded by char budget.
const hugeText: ModelMessage = { role: 'user', content: 'x'.repeat(50000) };
const hugeOut = projectedHistory([hugeText]);
assert.ok(hugeOut[0]!.content.length <= 32000, 'text is bounded by MAX_SERVER_RUN_HISTORY_MESSAGE_CHARS');

// Image budget: many/oversized images are bounded (base64 sliced) but text remains.
const manyImages: ModelMessage = {
  role: 'user',
  content: [
    { type: 'text' as const, text: 'before' },
    ...Array.from({ length: 8 }, () => ({ type: 'image' as const, image: 'data:image/png;base64,' + 'A'.repeat(200000) })),
  ],
};
const manyOut = projectedHistory([manyImages]);
const manyFiles = manyOut.flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => (p as { type?: string }).type === 'file') : []);
const carried = manyFiles.reduce((s, p) => s + ((p as { data?: { data?: string } }).data?.data?.length ?? 0), 0);
assert.ok(carried <= 512 * 1024, `projected image bytes stay under budget (${carried})`);
// Whole-image admission: an image that does not fit the remaining budget is
// dropped entirely — no mid-image base64 truncation reaches the model.
const truncated = manyFiles.some((p) => (p as { data?: { data?: string } }).data?.data?.endsWith('A') === false);
assert.equal(truncated, false, 'no image part is cut off mid-base64');
const first = manyFiles[0] as { data?: { data?: string } } | undefined;
const last = manyFiles.at(-1) as { data?: { data?: string } } | undefined;
if (first && last) {
  assert.equal(first.data?.data?.length, 200000, 'first image fits and is kept whole');
  assert.ok((last.data?.data?.length ?? 0) <= 200000 - 1 || (last.data?.data?.length ?? 0) === 200000,
    'an over-budget image is skipped rather than sliced');
}
// Message window applies before the image budget: older messages cannot eat
// the budget that should serve the retained tail. 65 messages → the first
// (a 400KiB image) is sliced off by the 63-message window; only the tail
// image remains, so it must get the full budget.
const budgetHog: ModelMessage = {
  role: 'user',
  content: [{ type: 'image' as const, image: 'data:image/png;base64,' + 'A'.repeat(400000) }],
};
const tailImage: ModelMessage = {
  role: 'user',
  content: [{ type: 'image' as const, image: 'data:image/png;base64,' + 'B'.repeat(400000) }],
};
const filler: ModelMessage[] = Array.from({ length: 63 }, () => ({ role: 'user' as const, content: 'filler' }));
const windowed = projectedHistory([budgetHog, ...filler, tailImage]);
const windowFiles = windowed.flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => (p as { type?: string }).type === 'file') : []);
const windowData = windowFiles.map((p) => (p as { data?: { data?: string } }).data?.data ?? '');
assert.deepEqual(windowData, ['B'.repeat(400000)], 'budget is spent on the retained tail message only');

console.log('serverRunProtocol projectedHistory verification passed');
