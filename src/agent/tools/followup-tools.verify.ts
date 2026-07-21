import assert from 'node:assert/strict';
import { buildFollowupWidget } from './followup-tools';
import { formatWidgetAnswer, parseWidgets } from '../../components/chat/widget-parse';

const widget = buildFollowupWidget([
  {
    id: 'brief',
    label: 'What should change?',
    type: 'text',
    description: 'Describe the intended result.',
    placeholder: 'Make it faster…',
    required: true,
  },
  {
    id: 'look',
    label: 'Choose a look',
    type: 'single',
    variant: 'visual',
    options: [{ id: 'noir', label: 'Noir', description: 'Hard contrast', preview: 'https://example.com/noir.jpg' }],
  },
  {
    id: 'voice',
    label: 'Choose a voice',
    type: 'single',
    variant: 'voice',
    options: [{ id: 'calm', label: 'Calm', audioUrl: 'https://example.com/calm.mp3', submitPrompt: 'Use the calm narrator' }],
  },
  {
    id: 'workflow',
    label: 'Choose workflows',
    type: 'multi',
    variant: 'scenario',
    options: [
      { id: 'talking-head', label: 'Talking head', description: 'Clean up a presenter clip' },
      { id: 'app-promo', label: 'App promo' },
    ],
  },
], 'One quick check', {
  title: 'Finish the brief',
  submitLabel: 'Continue',
  messagePrefix: 'Apply these choices:',
});

assert.match(widget, /<form-text/);
assert.match(widget, /<form-visual/);
assert.match(widget, /<form-voice/);
assert.match(widget, /<form-scenario[^>]*multiple="true"/);

const segments = parseWidgets(widget);
assert.equal(segments.length, 2);
const parsed = segments[1];
assert.equal(parsed.type, 'widget');
if (parsed.type !== 'widget') throw new Error('widget segment not parsed');
assert.equal(parsed.title, 'Finish the brief');
assert.equal(parsed.submitLabel, 'Continue');
assert.equal(parsed.messagePrefix, 'Apply these choices:');
assert.deepEqual(parsed.fields.map((field) => field.kind), ['text', 'visual', 'voice', 'scenario']);
assert.equal(parsed.fields[0]?.required, true);
assert.equal(parsed.fields[2]?.kind === 'voice' ? parsed.fields[2].options[0]?.media : '', 'https://example.com/calm.mp3');
assert.equal(parsed.fields[3]?.kind === 'scenario' ? parsed.fields[3].multiple : false, true);

const answer = formatWidgetAnswer(parsed.fields, {
  brief: 'Use tighter pacing',
  look: 'noir',
  voice: 'calm',
  workflow: ['talking-head', 'app-promo'],
}, parsed.messagePrefix);
assert.equal(answer, [
  'Apply these choices:',
  '- What should change?：Use tighter pacing',
  '- Choose a look：Noir',
  '- Choose a voice：Use the calm narrator',
  '- Choose workflows：Talking head、App promo',
].join('\n'));

const compatibility = parseWidgets('<widget><form-single id="length" label="Length" options="30|30 sec,60|60 sec" allow_other="true"/></widget>');
assert.equal(compatibility[0]?.type, 'widget');
if (compatibility[0]?.type !== 'widget') throw new Error('legacy widget not parsed');
assert.equal(compatibility[0].fields[0]?.kind, 'single');

console.log('followup-tools checks passed');
