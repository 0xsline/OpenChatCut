// Runnable check: `npx tsx src/components/chat/workflow-starters.verify.tsx`.
// Workflow picker + composer contracts after skill activation stopped
// filling the composer: selecting a workflow only activates the creative
// mode (input stays untouched). Verifies the picker markup, the pending
// attachment gate, and the composer geometry constants.
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const localeModuleId = '\0workflow-picker-test-locale';
const vite = await createServer({
  appType: 'custom',
  plugins: [{
    name: 'workflow-picker-test-locale',
    enforce: 'pre',
    resolveId(id) {
      return id.endsWith('/i18n/locale') || id.endsWith('/i18n/locale.ts') ? localeModuleId : null;
    },
    load(id) {
      if (id !== localeModuleId) return null;
      return `
        export const getLocale = () => 'zh';
        export const localizedCatalogText = (_english, chinese) => chinese;
        export const t = (text) => text;
        export const useT = () => t;
      `;
    },
  }],
  server: { middlewareMode: true },
});

let pickerMarkup = '';
let pendingComposerMarkup = '';
try {
  const { WorkflowPickerContent } = await vite.ssrLoadModule('/src/components/chat/WorkflowPickerContent.tsx');
  const {
    ChatComposer,
    WORKFLOW_POPOVER_WIDTH,
  } = await vite.ssrLoadModule('/src/components/chat/ChatComposer.tsx');
  const {
    hasPendingComposerAttachment,
    shouldSubmitComposerOnKeyDown,
  } = await vite.ssrLoadModule('/src/components/chat/composerSubmitGate.ts');
  pickerMarkup = renderToStaticMarkup(createElement(WorkflowPickerContent, {
    creativeMode: '11111111-1240-4000-8000-000000000004',
    onCreativeModeChange: () => undefined,
    onRequestFocus: () => undefined,
    onClose: () => undefined,
  }));
  assert.equal(WORKFLOW_POPOVER_WIDTH, 400, 'workflow picker should request the wide composer popover geometry');
  assert.equal(hasPendingComposerAttachment(false, 1), true, 'one pending attachment must close the submit gate');
  assert.equal(shouldSubmitComposerOnKeyDown('Enter', false, false), false, 'Enter must not submit while the gate is closed');
  pendingComposerMarkup = renderToStaticMarkup(createElement(ChatComposer, {
    value: '请处理这个附件',
    onChange: () => undefined,
    onSubmit: () => undefined,
    onStop: () => undefined,
    onEnhance: () => undefined,
    enhancing: false,
    running: false,
    mode: 'agent',
    onModeChange: () => undefined,
    autoApply: false,
    contextUsage: null,
    onAutoApplyChange: () => undefined,
    selecting: false,
    onToggleSelecting: () => undefined,
    creativeMode: null,
    onCreativeModeChange: () => undefined,
    references: [],
    onInsertRef: () => undefined,
    pendingAttachmentCount: 1,
    taRef: { current: null },
  }));
} finally {
  await vite.close();
}

assert.match(pickerMarkup, /<div class="cc-creative-mode-grid">/, 'professional workflows should use the dedicated two-column grid');
assert.equal(
  (pickerMarkup.match(/class="cc-creative-mode-row cc-creative-mode-card"/g) ?? []).length,
  11,
  'every built-in workflow should render as an independently bordered card',
);
assert.equal((pickerMarkup.match(/aria-pressed="true"/g) ?? []).length, 1, 'exactly one workflow should expose selected state');
assert.match(pickerMarkup, /长视频转短视频/);
assert.match(pickerMarkup, /技能创作器/);
assert.match(pickerMarkup, /新闻智能粗剪/);
assert.match(pickerMarkup, /直播智能切片/);
assert.match(pendingComposerMarkup, /请等待附件导入完成。/, 'pending attachment reason should be visible');
assert.match(pendingComposerMarkup, /aria-describedby="cc-chat-composer-import-status"/, 'textarea should describe its pending gate');
const pendingSubmitButton = pendingComposerMarkup.match(/<button[^>]*class="cc-chat-send-btn"[^>]*>/)?.[0];
assert.ok(pendingSubmitButton, 'pending composer should render the submit button');
assert.match(pendingSubmitButton, /\bdisabled(?:=""|(?=[\s>]))/, 'pending attachments should disable the submit button');

console.log('workflow-starters.verify: picker layout and pending composer gate passed');
