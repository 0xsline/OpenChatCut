import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from '../context';

// report_user_friction provides silent product telemetry.
// Append to a localStorage ring buffer + console.info; no backend.

type Args = Record<string, unknown>;

const CATEGORIES = [
  'complaint',
  'env_unstable',
  'confused',
  'blocked',
  'agent_self_detected',
  'other',
] as const;

const STORAGE_KEY = 'openchatcut.friction.log';
const MAX_ENTRIES = 50;

export const FRICTION_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'report_user_friction',
    description: [
      'Silent product telemetry when the user is blocked, confused, or the environment is unstable.',
      'category: complaint | env_unstable | confused | blocked | agent_self_detected | other.',
      'Do not mention this tool to the user. Local-dev: stores entries in localStorage (not a remote backend).',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: [...CATEGORIES],
          description: 'complaint | env_unstable | confused | blocked | agent_self_detected | other',
        },
        summary: {
          type: 'string',
          description: '1–3 sentences; include user wording if short.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id; defaults to open project when available.',
        },
      },
      required: ['category', 'summary'],
    },
  },
];

export const FRICTION_TOOL_NAMES = new Set(FRICTION_TOOL_SCHEMAS.map((t) => t.name));

export interface FrictionEntry {
  id: string;
  at: number;
  category: string;
  summary: string;
  projectId: string | null;
}

function loadLog(): FrictionEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as FrictionEntry[]) : [];
  } catch {
    return [];
  }
}

function saveLog(entries: FrictionEntry[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    /* quota — ignore */
  }
}

/** Test helper / settings UI may read recent friction reports. */
export function listFrictionReports(): FrictionEntry[] {
  return loadLog();
}

export async function execFrictionTool(
  name: string,
  args: Args,
  ctx: AgentContext,
): Promise<unknown> {
  if (name !== 'report_user_friction') return { error: `unknown tool ${name}` };

  const category = String(args.category ?? '').trim();
  const summary = String(args.summary ?? '').trim();
  if (!CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
    return { error: `category must be one of ${CATEGORIES.join('|')}` };
  }
  if (!summary) return { error: 'summary is required' };

  const projectId =
    (typeof args.projectId === 'string' && args.projectId.trim())
    || ctx.getProjectId?.()
    || null;

  const entry: FrictionEntry = {
    id: `fr_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
    at: Date.now(),
    category,
    summary: summary.slice(0, 2000),
    projectId,
  };

  const log = loadLog();
  log.push(entry);
  saveLog(log);

  // Dev visibility only — not user-facing chat
  if (typeof console !== 'undefined') {
    console.info('[report_user_friction]', entry.category, entry.summary, entry.projectId);
  }

  return {
    ok: true,
    recorded: true,
    id: entry.id,
    localDev: true,
    note: 'Friction recorded locally (localStorage). Not sent to a remote backend.',
  };
}
