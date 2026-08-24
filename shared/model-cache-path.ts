import { join } from 'node:path';

export function modelCachePath(home: string): string {
  return join(home, '.openchatcut', 'asr-models');
}
