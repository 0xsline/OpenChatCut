// EN dictionary (field fragmentation, key=Chinese original text). Data files are exempt from the upper limit of row count.
// Source: src/editor/types.ts UI labels of top-level constants (the constant body remains in Chinese, and the usage package is t(label)).
// The dynamic label v1 of undo historical/project data stored in reduce/store does not enter i18n (see the scanning rules).
export default {
  // ZOOM_SHAPE_LABELS
  'impact': 'Punch',
  'push pull back': 'Push & Pull Back',
  'push slowly': 'Slow Push',
  'Instantaneous': 'Instant',
  'Zoom out': 'Zoom Out',
  'Ease in and push in': 'Ease-In Push',
  'elastic push closer': 'Bouncy Push',
  'Fast cut and push closer': 'Snap Push',
  'heartbeat pulse': 'Pulse',
  'throw in push close': 'Whip-In Push',
  // TRANSITION_LABELS
  'Promote transition': 'Anticipation Zoom',
  'White line transition': 'Clean Line Wipe',
  'dissolve transition': 'Cross Dissolve',
  'Flash to black transition': 'Dip to Black',
  'flash white transition': 'Flash',
  'Shock shake transition': 'Impact Shake',
  'Overlay transition': 'Luma Blend',
  'Photodissolve transition': 'Organic Dissolve',
  'Page turning transition': 'Page Curl',
  'focus transition': 'Rack Focus',
  'Soften wipe transition': 'Soft Wipe',
  'Scene transition': 'Whip Pan',
  'circular wipe transition': 'Circle Wipe',
} as Record<string, string>;
