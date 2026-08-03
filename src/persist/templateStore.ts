// Project template library (manage_template): template = a set of MG + design style packaging.
// A template is a packaged ProjectDoc (MG fragment + designStyle + in its timeline
// carried media assets). Cross-project sharing (like the "My Design Style" collection, it is a global library and is not divided by project),
// Share the local server KV with projectStore.
// Always use migrateProjectDoc for verification when reading (persistent data is not trustworthy).
import { migrateProjectDoc } from './projectStore';
import { kvGet as idbGet, kvSet as idbSet } from './sharedKv';
import type { ProjectDoc } from '../editor/types';
import { projectDocHasOriginalFilePath, sanitizePortableProjectDoc } from './portableProject';

// Global single key: templates are shared across projects (without projectId), the same idea as owned design styles.
const TEMPLATES_KEY = 'templates:all';

export interface ProjectTemplate {
  id: string;
  name: string;
  createdAt: number;
  /** Packaged project documents: timeline (including MG fragment) + designStyle + asset pool */
  doc: ProjectDoc;
  /** The media asset id carried by this template (for use by list_assets / omitAssetIds) */
  assetIds: string[];
}

// Boundary verification: Persistent data is not trustworthy, verify it first and then use it. doc is regularized by migrateProjectDoc (untrusted document
// will be rejected/cleaned), assetIds only retains strings.
function toValidTemplate(v: unknown): { template: ProjectTemplate; migrated: boolean } | null {
  if (!v || typeof v !== 'object') return null;
  const raw = v as Partial<ProjectTemplate>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.createdAt !== 'number') return null;
  let migrated = false;
  const migratedDoc = migrateProjectDoc(raw.doc, { onProgress: () => { migrated = true; } });
  if (!migratedDoc) return null;
  const hadOriginalFilePath = projectDocHasOriginalFilePath(migratedDoc);
  const doc = sanitizePortableProjectDoc(migratedDoc);
  const assetIds = Array.isArray(raw.assetIds) ? raw.assetIds.filter((x): x is string => typeof x === 'string') : [];
  return {
    template: { id: raw.id, name: raw.name, createdAt: raw.createdAt, doc, assetIds },
    migrated: migrated || hadOriginalFilePath,
  };
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

/** All saved templates (in insertion order, with the same name replaced in place). On failure, an empty array is returned (persistent data is not trusted). */
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

/** Package a ProjectDoc into a template (remove duplication by name: overwrite with the same name, reuse the original id and keep the list in place).
 * assetIds = all ids of the document asset pool (the template carries the entire asset pool).*/
export async function saveTemplate(name: string, doc: ProjectDoc): Promise<ProjectTemplate> {
  const trimmed = name.trim() || '未命名模板';
  // ponytail: Carrying the entire asset pool instead of just selecting the referenced assets; tailoring to only referenced assets is additional logic, YAGNI.
  const portableDoc = sanitizePortableProjectDoc(doc);
  const assetIds = portableDoc.assets.map((asset) => asset.id);
  const current = await readAll();
  const existing = current.find((template) => template.name === trimmed);
  // ponytail: createdAt is only metadata, the list is not sorted by it (insertion order is used), so using Date.now() does not destroy determinism.
  const entry: ProjectTemplate = {
    id: existing?.id ?? newId(),
    name: trimmed,
    createdAt: Date.now(),
    doc: portableDoc,
    assetIds,
  };
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
