// The bug-report forms ask for an exact version from a dropdown. When a
// release bump forgets them, reporters on the newest build can only pick an
// older version and triage loses the signal (the forms stayed on v0.2.9
// through v0.2.14). Tie the newest option to package.json so a version bump
// fails the suite until both forms list it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const FORMS = [
  '.github/ISSUE_TEMPLATE/bug_report_en.yml',
  '.github/ISSUE_TEMPLATE/bug_report_zh.yml',
];

/** Options of the `id: version` dropdown, in form order (the forms are flat YAML lists). */
function versionOptions(path) {
  const lines = readFileSync(new URL(path, root), 'utf8').split('\n');
  const field = lines.findIndex((line) => line.trim() === 'id: version');
  assert.ok(field >= 0, `${path} has a version field`);
  const list = lines.findIndex((line, index) => index > field && line.trim() === 'options:');
  assert.ok(list > field, `${path} lists version options`);
  const options = [];
  for (const line of lines.slice(list + 1)) {
    const match = /^\s+- (.+)$/.exec(line);
    if (!match) break;
    options.push(match[1].trim());
  }
  return options;
}

const current = `v${version}`;
for (const path of FORMS) {
  const options = versionOptions(path);
  const [latest] = options;
  assert.ok(
    latest === current || latest?.startsWith(`${current} `) || latest?.startsWith(`${current}（`),
    `${path}: the first (latest Release) option must be ${current}, found ${latest}`,
  );
  assert.equal(
    options.filter((option) => option === current || option.startsWith(`${current} `)
      || option.startsWith(`${current}（`)).length,
    1,
    `${path}: ${current} is listed exactly once`,
  );
}

console.log(`issue-template-version.verify: both bug forms offer ${current} as the latest release`);
