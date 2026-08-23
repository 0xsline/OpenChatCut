// IT dictionary assembly. Italian can fall back to English for entries that
// have not been translated yet, so contributors can land focused updates.
import components from './components';
import settings from './settings';
import topbar from './topbar';

export const IT: Record<string, string> = Object.assign(
  {},
  components, settings, topbar,
);
