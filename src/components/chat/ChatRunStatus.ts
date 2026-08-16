/** Elapsed run seconds for the chat status timer; kept outside the component
 *  module so Fast Refresh stays clean (component files export components). */
export function elapsedRunSeconds(startedAt: number, now = Date.now()): number {
  return Math.max(0, (now - startedAt) / 1000);
}
