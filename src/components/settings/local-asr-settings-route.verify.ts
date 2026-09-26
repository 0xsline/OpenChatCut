// #126: Settings → 转写 / 口播剪辑 → 本地模型（whisper） said the model list was
// "below", but the list and its 下载 / 删除 buttons live on 本地模型 → 本地转写,
// and runtime errors sent users to the page without them. Pin the way there.
import assert from 'node:assert/strict';
import { bindAction } from '../../shortcuts/actionRegistry';
import { runNoteAction } from './noteAction';
import { LOCAL_ASR_SETTINGS_ROUTE, localAsrPage } from './settingsMediaProviders';
import { SETTINGS_CATEGORIES } from './settingsSchema';

const pages = SETTINGS_CATEGORIES.flatMap((category) => category.groups.flatMap((group) => group.vendors));
assert.equal(pages.find((page) => page.key === 'transcription/local'), localAsrPage,
  'the transcription group shows the local Whisper page');

// Its button opens the page that renders the model list.
const opened: string[] = [];
assert.ok(localAsrPage.noteAction, 'the local Whisper page must offer a way to the model list');
runNoteAction(localAsrPage.noteAction, (route) => opened.push(route));
assert.deepEqual(opened, [LOCAL_ASR_SETTINGS_ROUTE]);
const target = pages.find((page) => page.key === LOCAL_ASR_SETTINGS_ROUTE);
assert.equal(target?.kind, 'local-models', 'the button must open the page that lists the models');
assert.equal(target.fields, localAsrPage.fields, 'both pages edit the same model settings');

// A mistyped route would silently land on the first settings page.
for (const page of pages) {
  const action = page.noteAction;
  if (!action || !('route' in action)) continue;
  assert.ok(pages.some((candidate) => candidate.key === action.route),
    `${page.key}: its note button opens ${action.route}, which is not a settings page`);
}

assert.doesNotMatch(localAsrPage.note ?? '', /见下方列表/, 'the note must not promise a list the page lacks');
assert.match(localAsrPage.note ?? '', /本地模型 → 本地转写/, 'the note names the page with the buttons');

// Buttons that dispatch a global action keep doing so.
let dispatched = 0;
const unbind = bindAction('local-asr-settings-route-verify', () => { dispatched += 1; });
try {
  runNoteAction({ label: 'verify', action: 'local-asr-settings-route-verify' },
    () => assert.fail('an action button must not navigate'));
} finally {
  unbind();
}
assert.equal(dispatched, 1);

console.log('local-asr-settings-route.verify: the local Whisper page links to its model list');
