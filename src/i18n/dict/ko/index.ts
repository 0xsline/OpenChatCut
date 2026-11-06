// KO dictionary assembly, split by the same fields as dict/en. Untranslated
// entries fall back to English, then to the Chinese original.
import audio from './audio';
import captions from './captions';
import chat from './chat';
import components from './components';
import editor from './editor';
import exportPanel from './exportPanel';
import fx from './fx';
import library from './library';
import media from './media';
import review from './review';
import settings from './settings';
import timeline from './timeline';
import topbar from './topbar';
import transcript from './transcript';

export const KO: Record<string, string> = Object.assign(
  {},
  audio, captions, chat, components, editor, exportPanel, fx,
  library, media, review, settings, timeline, topbar, transcript,
);
