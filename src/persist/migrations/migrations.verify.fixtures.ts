import { readFileSync } from 'node:fs';

const fixture = (name: string): unknown => JSON.parse(
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
);

export const v1 = fixture('project-v1.json');
export const v2 = fixture('project-v2.json');
export const v3 = fixture('project-v3.json');
export const v3V019Compatible = fixture('project-v3-v019-compatible.json');
export const v4 = fixture('project-v4.json');
export const v5 = fixture('project-v5.json');
export const v6 = fixture('project-v6.json');
