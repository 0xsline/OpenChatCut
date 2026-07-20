// Runnable: `npx tsx src/agent/friction-tools.check.ts`
import assert from 'node:assert';
import type { AgentContext } from '../context';
import {
  FRICTION_TOOL_NAMES,
  FRICTION_TOOL_SCHEMAS,
  execFrictionTool,
  listFrictionReports,
} from './friction-tools';

assert.ok(FRICTION_TOOL_NAMES.has('report_user_friction'));
assert.strictEqual(FRICTION_TOOL_SCHEMAS[0]!.name, 'report_user_friction');

// Memory storage polyfill for Node
const mem = new Map<string, string>();
const g = globalThis as typeof globalThis & { localStorage?: Storage };
if (!g.localStorage) {
  g.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}
mem.clear();

const ctx = {
  getProjectId: () => 'proj_test',
} as unknown as AgentContext;

const bad = await execFrictionTool('report_user_friction', { category: 'nope', summary: 'x' }, ctx) as { error?: string };
assert.ok(bad.error);

const empty = await execFrictionTool('report_user_friction', { category: 'blocked', summary: '  ' }, ctx) as { error?: string };
assert.ok(empty.error);

const ok = await execFrictionTool('report_user_friction', {
  category: 'blocked',
  summary: '用户说导出一直失败',
}, ctx) as { ok: boolean; id: string; localDev: boolean };
assert.strictEqual(ok.ok, true);
assert.ok(ok.id);
assert.strictEqual(ok.localDev, true);

const list = listFrictionReports();
assert.ok(list.some((e) => e.summary.includes('导出') && e.projectId === 'proj_test' && e.category === 'blocked'));

console.log('friction-tools.check: ok');
