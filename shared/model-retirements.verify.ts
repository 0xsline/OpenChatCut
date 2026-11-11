import assert from 'node:assert/strict';
import {
  RETIRED_MODELS,
  filterSelectableModels,
  isRetiredAt,
  isRetiredModel,
  retirementFor,
} from './model-retirements';

const beforeDecember = new Date('2026-11-12T00:00:00Z');

// The registry is hand-written data, so guard its shape: ids are unique and
// every date is the ISO `YYYY-MM-DD` form the helpers parse.
assert.ok(RETIRED_MODELS.length > 0, 'the registry keeps the confirmed retirements');
assert.equal(
  new Set(RETIRED_MODELS.map((model) => model.id)).size,
  RETIRED_MODELS.length,
  'duplicate retirement ids would make the lookup order-dependent',
);
for (const model of RETIRED_MODELS) {
  assert.match(model.retiredAt, /^\d{4}-\d{2}-\d{2}$/, `${model.id} keeps an ISO shutdown date`);
  assert.ok(!Number.isNaN(Date.parse(`${model.retiredAt}T00:00:00Z`)), `${model.id} parses`);
}

// A date already in the past is retired: this is what pickers filter out.
assert.equal(isRetiredAt('gemini-3-pro-preview', beforeDecember), true);
assert.equal(isRetiredModel('gemini-3-pro-preview', beforeDecember), true);
assert.equal(isRetiredAt('gemini-3.1-flash-image-preview', beforeDecember), true);
assert.equal(isRetiredAt('veo-3.1-generate-preview', beforeDecember), true);
assert.equal(retirementFor('gemini-3-pro-preview')?.replacement, 'gemini-3.1-pro-preview');

// The shutdown day itself counts as retired; the day before does not.
assert.equal(isRetiredAt('gemini-2.5-flash', new Date('2026-12-01T00:00:00Z')), true);
assert.equal(isRetiredAt('gemini-2.5-flash', new Date('2026-11-30T23:59:59Z')), false);

// A future date is NOT retired — the model still works today — but it is
// flagged, so the picker can warn "retiring Dec 1" without hiding it.
assert.equal(isRetiredAt('gemini-2.5-flash', beforeDecember), false);
assert.equal(isRetiredAt('gemini-2.5-pro', beforeDecember), false);
assert.deepEqual(retirementFor('gemini-2.5-pro'), {
  id: 'gemini-2.5-pro',
  retiredAt: '2026-12-01',
  replacement: 'gemini-3.8-flash',
  note: 'From the shutdown date the API routes requests to gemini-3.8-flash with its breaking changes.',
});
assert.equal(retirementFor('gemini-3.1-flash-tts-preview')?.retiredAt, '2026-11-17');

// Unknown ids are untouched: a custom/local model id can never be mistaken for
// a retirement, and ids are matched exactly, not by prefix.
assert.equal(retirementFor('gpt-5'), undefined);
assert.equal(retirementFor('gemini-2.5-flash-custom'), undefined);
assert.equal(retirementFor(''), undefined);
assert.equal(isRetiredAt('gpt-5', beforeDecember), false);
assert.equal(isRetiredModel('gemini-2.5-flash-thinking', beforeDecember), false);

// Picker-level filter: only dead models disappear; live and merely-scheduled
// ones stay selectable.
assert.deepEqual(
  filterSelectableModels(
    ['gemini-3-pro-preview', 'gemini-2.5-flash', 'gpt-5', 'gemini-3.1-flash-lite-preview'],
    { at: beforeDecember },
  ),
  ['gemini-2.5-flash', 'gpt-5'],
  'filter drops retired ids only',
);

// An already-saved value is never silently dropped: the filter keeps it so the
// UI can warn instead of blanking a user's configuration.
assert.deepEqual(
  filterSelectableModels(
    ['gemini-3-pro-preview', 'gemini-2.5-flash'],
    { at: beforeDecember, keep: 'gemini-3-pro-preview' },
  ),
  ['gemini-3-pro-preview', 'gemini-2.5-flash'],
  'the saved value survives even when retired',
);
assert.deepEqual(
  filterSelectableModels(['gemini-3-pro-preview'], { at: beforeDecember, keep: '  ' }),
  [],
  'a blank saved value keeps nothing',
);

// Default `at` is "now": both helpers agree and a past-dated entry stays past.
assert.equal(isRetiredModel('gemini-3-pro-preview'), isRetiredAt('gemini-3-pro-preview'));
assert.equal(isRetiredAt('gemini-3-pro-preview'), true);

console.log(`model-retirements.verify: ${RETIRED_MODELS.length} retirements, picker filter passed`);
