// Project template library (manage_template): template = a set of MG + design style packaging.
// A template is a packaged ProjectDoc (MG snippet + designStyle + in its timeline
// media assets carried). Cross-project sharing (like the "My Design Style" collection, it is a global library and is not divided by project),
// Share native server KV with projectStore.
// Always use migrateProjectDoc for verification when reading (persistent data is not trustworthy).
import { migrateProjectDoc } from './projectStore';
import { kvGet as idbGet, kvSet as idbSet } from './sharedKv';
import type { ProjectDoc } from '../editor/types';

// Global single key: templates are shared across projects (without projectId), the same idea as owned design styles.
const TEMPLATES_KEY = 'templates:all';

export interface ProjectTemplate {
  id: string;
  name: string;
  createdAt: number;
  /** Packaged project documents:timeline(Contains MG fragment)+ designStyle + Asset pool */
  doc: ProjectDoc;
  /** Media assets carried by this template id(supply list_assets / omitAssetIds use) */
  assetIds: string[];
}

// Boundary verification: Persistent data is not trustworthy and should be verified before use. doc is regularized by migrateProjectDoc (untrusted document
// will be rejected/cleaned), assetIds only retains strings.
function toValidTemplate(v: unknown): { template: ProjectTemplate; migrated: boolean } | null {
  if (!v || typeof v !== 'object') return null;
  const raw = v as Partial<ProjectTemplate>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.createdAt !== 'number') return null;
  let migrated = false;
  const doc = migrateProjectDoc(raw.doc, { onProgress: () => { migrated = true; } });
  if (!doc) return null;
  const assetIds = Array.isArray(raw.assetIds) ? raw.assetIds.filter((x): x is string => typeof x === 'string') : [];
  return { template: { id: raw.id, name: raw.name, createdAt: raw.createdAt, doc, assetIds }, migrated };
}

async function readAll(): Promise<ProjectTemplate[]> {
  const raw = await idbGet<unknown>(TEMPLATES_KEY);
  if (!Array.isArray(raw)) return [];
  const parsed = raw.map(toValidTemplate);
  const valid = parsed.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const templates = valid.map((entry) => entry.template);
  // Upgrade the shared library only when every entry migrated successfully.
  // A corrupt sibling therefore never causes destructive partial persistence.
  if (valid.length === raw.length && valid.some((entry) => entry.migrated)) {
    try {
      await idbSet(TEMPLATES_KEY, templates);
    } catch {
      // The normalized in-memory templates are still usable; retry next read.
    }
  }
  return templates;
}

/** All saved templates(insertion order,Replace with the same name in place). On failure, an empty array is always returned.(Don’t trust persistent data)。 */
export async function listTemplates(): Promise<ProjectTemplate[]> {
  try {
    return await readAll();
  } catch {
    return [];
  }
}

export async function getTemplate(id: string): Promise<ProjectTemplate | null> {
  try {
    return (await readAll()).find((t) => t.id === id) ?? null;
  } catch {
    return null;
  }
}

const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `tpl_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

/** put a portion ProjectDoc Packaged into templates(Remove duplicates by name:Coverage with the same name,reuse original id and keep the list in place)。
 * assetIds = All document asset pools id(The template carries the entire asset pool)。 */
export async function saveTemplate(name: string, doc: ProjectDoc): Promise<ProjectTemplate> {
  const trimmed = name.trim() || 'Unnamed template';
  // ponytail: Carrying the entire asset pool instead of just selecting the referenced assets; tailoring to only referenced assets is additional logic, YAGNI.
  const assetIds = doc.assets.map((a) => a.id);
  const current = await readAll();
  const existing = current.find((t) => t.name === trimmed);
  // ponytail: createdAt is only metadata, the list is not sorted by it (insertion order is used), so using Date.now() does not destroy determinism.
  const entry: ProjectTemplate = { id: existing?.id ?? newId(), name: trimmed, createdAt: Date.now(), doc, assetIds };
  const next = existing ? current.map((t) => (t.id === entry.id ? entry : t)) : [...current, entry];
  try {
    await idbSet(TEMPLATES_KEY, next);
  } catch {
    /* ignore persist failures; caller still gets the entry back for in-session use */
  }
  return entry;
}

export async function deleteTemplate(id: string): Promise<void> {
  try {
    const current = await readAll();
    await idbSet(TEMPLATES_KEY, current.filter((t) => t.id !== id));
  } catch {
    /* ignore */
  }
}
