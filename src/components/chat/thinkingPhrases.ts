// The playful film-crew "thinking…" phrases shown while the agent runs
// We cycle one
// per running turn instead of a plain "Thinking about...".
export const THINKING_PHRASES: string[] = [
  'La Jiao Zhong', 'Push rail car', 'Check gate', 'Make a plan', 'The sound started at the same time', 'Move around Move around',
  'Action!', 'stuck point stuck point', 'rack lamp rack lamp', 'Find the feeling', 'Overthrow and start over', 'Go for location scouting',
  'shake one', 'push push push', 'keep up keep up', 'Throw one away', 'Walking with hand in hand', 'rocker arm lift',
  'Zoom out', 'Give a panoramic view', 'Get closer', 'jump cut jump cut', 'hard cut', 'dissolve transition',
  'match clips', 'Cross over', 'Montage it', 'LCut away', 'Adhesive film',
];

/** deterministic pick so a given turn keeps one phrase (index varies by seed). */
export function thinkingPhrase(seed: number): string {
  return THINKING_PHRASES[Math.abs(seed) % THINKING_PHRASES.length];
}
