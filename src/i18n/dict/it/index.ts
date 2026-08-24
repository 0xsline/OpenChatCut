// IT dictionary assembly. Italian can fall back to English for entries that
// have not been translated yet, so contributors can land focused updates.
import components from './components';
import captions from './captions';
import media from './media';
import settings from './settings';
import topbar from './topbar';
import transcript from './transcript';

export const IT: Record<string, string> = Object.assign(
  {},
  captions, components, media, settings, topbar, transcript,
);
