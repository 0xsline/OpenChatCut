// Plug-in installation pipeline (browser side): JSON → pure verification → true compilation probe (GLSL via GlRuntime,
// MG is compiled by template-host sandbox) → LUT .cube is uploaded into a file → registered → stored in the library.
// Transaction sequence: first register successfully and then save; if any step fails, the registry will be rolled back (leaving no half-installed state).
// The sandbox runs as usual, and here is the first door.
import { validatePack } from './validate';
import { listPacks, savePack, registerPack, unregisterPack, type InstalledPack } from './store';
import type { PluginPack } from './types';
import { createGlRuntime } from '../gl/runtime';
import { compileTemplate } from '../template-host';

export type InstallResult =
  | { ok: true; pack: InstalledPack }
  | { ok: false; errors: string[] };

export type InstallFromUrlOpts = {
  /** Optional:Expectation body of SHA-256(hex,Can be lowercase or uppercase);If it does not match, it will be rejected. */
  sha256?: string;
  source?: InstalledPack['source'];
};

const err = (errors: string[]): InstallResult => ({ ok: false, errors });

/** GLSL true compilation probe:tiny canvas Run it once,compile/The link will be rejected if it fails. */
async function probeShaders(pack: PluginPack): Promise<string[]> {
  const shaderItems = pack.items.filter((i) => i.type === 'fx' || i.type === 'transition');
  if (!shaderItems.length) return [];
  const errors: string[] = [];
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  let runtime: ReturnType<typeof createGlRuntime>;
  try {
    runtime = createGlRuntime(canvas);
  } catch (e) {
    return [`WebGL Not available,Unable to verify shader:${e instanceof Error ? e.message : String(e)}`];
  }
  const src = document.createElement('canvas');
  src.width = 2;
  src.height = 2;
  src.getContext('2d')!.fillRect(0, 0, 2, 2);
  try {
    for (const item of shaderItems) {
      try {
        if (item.type === 'transition') runtime.render(item.frag, src, src, 0.5, {});
        else for (const frag of item.passes ?? [item.frag]) runtime.renderFxChain([{ frag, uniforms: {} }], src);
      } catch (e) {
        errors.push(`「${item.name}」shader Compilation failed:${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    runtime.dispose();
  }
  return errors;
}

/** MG Template true compilation probe(template-host sandbox static surface) */
async function probeTemplates(pack: PluginPack): Promise<string[]> {
  const errors: string[] = [];
  const mgItems = pack.items.filter((i) => i.type === 'mg-template');
  if (!mgItems.length) return [];
  for (const item of mgItems) {
    try {
      compileTemplate(item.code);
    } catch (e) {
      errors.push(`「${item.name}"Template compilation failed:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return errors;
}

/** LUT .cube Upload to /media/uploads File(Export bundle symlink / R2 Backup natural coverage) */
async function uploadCubes(pack: PluginPack): Promise<{ cubeUrls: Record<string, string>; errors: string[] }> {
  const cubeUrls: Record<string, string> = {};
  const errors: string[] = [];
  for (const item of pack.items) {
    if (item.type !== 'lut') continue;
    const assetId = `plugin-${pack.id}-${item.id}-cube`.replace(/[^a-zA-Z0-9_-]/g, '-');
    try {
      const res = await fetch(`/upload?name=${assetId}.cube&assetId=${assetId}`, { method: 'POST', body: item.cube });
      const body = (await res.json().catch(() => null)) as { path?: string; error?: string } | null;
      if (!res.ok || !body?.path) {
        errors.push(`「${item.name}」.cube Upload failed:${body?.error ?? `HTTP ${res.status}`}`);
        continue;
      }
      cubeUrls[item.id] = body.path;
    } catch (e) {
      errors.push(`「${item.name}」.cube Upload failed:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { cubeUrls, errors };
}

/** Calculate UTF-8 textual SHA-256 hex(lowercase) */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** from JSON Text installation(File/Paste share)。opts.sha256 Optional integrity check. */
export async function installFromText(text: string, opts?: InstallFromUrlOpts): Promise<InstallResult> {
  if (opts?.sha256) {
    const got = await sha256Hex(text);
    if (got !== opts.sha256.trim().toLowerCase()) {
      return err([`SHA-256 no match(Expectation ${opts.sha256.slice(0, 12)}…,What you get ${got.slice(0, 12)}…)`]);
    }
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return err(['Not legal JSON']);
  }
  const res = validatePack(json);
  if (!res.ok) return err(res.errors);
  const pack = res.pack;

  const [shaderErrors, templateErrors] = await Promise.all([probeShaders(pack), probeTemplates(pack)]);
  if (shaderErrors.length || templateErrors.length) return err([...shaderErrors, ...templateErrors]);

  const { cubeUrls, errors: cubeErrors } = await uploadCubes(pack);
  if (cubeErrors.length) return err(cubeErrors);

  const installed: InstalledPack = {
    ...pack,
    installedAt: Date.now(),
    enabled: true,
    ...(Object.keys(cubeUrls).length ? { cubeUrls } : {}),
    ...(opts?.source ? { source: opts.source } : {}),
  };

  // Transaction: Remove the registration of the old package with the same ID → Register the new package → Persistence; roll back the registry on failure
  const previous = (await listPacks()).find((p) => p.id === installed.id) ?? null;
  if (previous) {
    try { await unregisterPack(previous); } catch { /* Old package de-registration fails and continues to be overwritten */ }
  }
  try {
    await registerPack(installed);
  } catch (e) {
    if (previous) {
      try { await registerPack(previous); } catch { /* Try your best to recover */ }
    }
    return err([`Registration failed:${e instanceof Error ? e.message : String(e)}`]);
  }
  try {
    await savePack(installed);
  } catch (e) {
    try { await unregisterPack(installed); } catch { /* ignore */ }
    if (previous) {
      try { await registerPack(previous); } catch { /* ignore */ }
    }
    return err([`Failed to write to local:${e instanceof Error ? e.message : String(e)}`]);
  }
  return { ok: true, pack: installed };
}

/** from URL Installation(gist/raw/Remote indexing, etc.;Cross-domain quilt CORS When stopped, it prompts to use file installation instead.) */
export async function installFromUrl(url: string, opts?: InstallFromUrlOpts): Promise<InstallResult> {
  let text: string;
  try {
    const res = await fetch(url);
    if (!res.ok) return err([`Download failed:HTTP ${res.status}`]);
    text = await res.text();
  } catch (e) {
    return err([`Download failed(may be CORS stop):${e instanceof Error ? e.message : String(e)}. You can download the file and install it using "Select File"`]);
  }
  return installFromText(text, {
    ...opts,
    source: opts?.source ?? {
      kind: 'url',
      url,
      ...(opts?.sha256 ? { sha256: opts.sha256 } : {}),
    },
  });
}
