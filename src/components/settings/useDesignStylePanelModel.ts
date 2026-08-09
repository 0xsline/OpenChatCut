import { useEffect, useState } from 'react';
import {
  COLOR_ROLES,
  FONT_ROLES,
  colorOf,
  fontOf,
  type DesignStyle,
} from '../../editor/types';
import {
  deleteOwnedStyle,
  loadOwnedStyles,
  saveOwnedStyle,
  updateOwnedStyle,
  type OwnedStyle,
} from '../../persist/ownedStyleStore';
import { theme } from '../../theme';

const EMPTY: DesignStyle = { colors: [], fonts: [] };

function union(first: string[], rest: readonly string[]): string[] {
  const seen = new Set(first);
  return [...first, ...rest.filter((role) => !seen.has(role))];
}

function pickColor(style: DesignStyle, roles: string[]): string | undefined {
  for (const role of roles) {
    const value = colorOf(style, role);
    if (value) return value;
  }
  return undefined;
}

function upsert<T extends { role: string }>(
  list: T[],
  role: string,
  value: string,
  make: (value: string) => T,
): T[] {
  const index = list.findIndex((item) => item.role === role);
  if (!value.trim()) return index === -1 ? list : list.filter((item) => item.role !== role);
  if (index === -1) return [...list, make(value)];
  return list.map((item, itemIndex) => (itemIndex === index ? make(value) : item));
}

function useOwnedStyleLibrary() {
  const [owned, setOwned] = useState<OwnedStyle[]>([]);
  const [selectedOwnedId, setSelectedOwnedId] = useState<string | null>(null);
  const [sceneFilter, setSceneFilter] = useState('');
  useEffect(() => {
    let cancelled = false;
    loadOwnedStyles().then((list) => { if (!cancelled) setOwned(list); });
    return () => { cancelled = true; };
  }, []);
  const refreshOwned = async () => {
    const list = await loadOwnedStyles();
    setOwned(list);
    return list;
  };
  const deleteOwned = async (id: string) => {
    await deleteOwnedStyle(id);
    if (selectedOwnedId === id) setSelectedOwnedId(null);
    await refreshOwned();
  };
  const sceneOptions = [...new Set(owned.flatMap((item) => item.scenarios ?? []))].sort();
  const visibleOwned = sceneFilter
    ? owned.filter((item) => item.scenarios?.includes(sceneFilter))
    : owned;
  return {
    owned, selectedOwnedId, setSelectedOwnedId, sceneFilter, setSceneFilter,
    sceneOptions, visibleOwned, refreshOwned, deleteOwned,
  };
}

function useOwnedStyleMetadata(
  selectedOwnedId: string | null,
  refreshOwned: () => Promise<OwnedStyle[]>,
) {
  const [name, setName] = useState('');
  const [scenarios, setScenarios] = useState('');
  const [thumbnail, setThumbnail] = useState('');
  const load = (style: OwnedStyle) => {
    setName(style.name);
    setScenarios((style.scenarios ?? []).join(', '));
    setThumbnail(style.thumbnailUrl ?? '');
  };
  const save = async () => {
    if (!selectedOwnedId || !name.trim()) return;
    const updated = await updateOwnedStyle(selectedOwnedId, {
      name,
      scenarios: scenarios.split(',').map((value) => value.trim()).filter(Boolean),
      thumbnailUrl: thumbnail,
    });
    if (!updated) return;
    load(updated);
    await refreshOwned();
  };
  const clearThumbnail = async () => {
    if (!selectedOwnedId) return;
    const updated = await updateOwnedStyle(selectedOwnedId, { thumbnailUrl: null });
    if (!updated) return;
    setThumbnail('');
    await refreshOwned();
  };
  return {
    name, setName, scenarios, setScenarios, thumbnail, setThumbnail,
    load, save, clearThumbnail,
  };
}

export function useDesignStylePanelModel(style: DesignStyle | undefined) {
  const [draft, setDraft] = useState<DesignStyle>(style ?? EMPTY);
  const [savingName, setSavingName] = useState<string | null>(null);
  const library = useOwnedStyleLibrary();
  const metadata = useOwnedStyleMetadata(library.selectedOwnedId, library.refreshOwned);
  const selectOwned = (ownedStyle: OwnedStyle) => {
    library.setSelectedOwnedId(ownedStyle.id);
    metadata.load(ownedStyle);
    setDraft(ownedStyle.style);
  };
  const saveOwned = async () => {
    const name = (savingName ?? '').trim();
    if (!name || (!draft.colors.length && !draft.fonts.length && !draft.styleGuide)) return;
    await saveOwnedStyle(name, draft);
    setSavingName(null);
    await library.refreshOwned();
  };
  const setColor = (role: string, value: string) => setDraft((current) => ({
    ...current, colors: upsert(current.colors, role, value, (next) => ({ role, value: next })),
  }));
  const setFont = (role: string, family: string) => setDraft((current) => ({
    ...current, fonts: upsert(current.fonts, role, family, (next) => ({ family: next, role })),
  }));
  const colorRoles = union(draft.colors.map((color) => color.role).filter((role) => !COLOR_ROLES.includes(role)), COLOR_ROLES);
  const fontRoles = union(draft.fonts.map((font) => font.role).filter((role) => !FONT_ROLES.includes(role)), FONT_ROLES);
  const preview = {
    bg: colorOf(draft, 'background') ?? draft.colors[0]?.value ?? theme.panel,
    fg: colorOf(draft, 'text') ?? theme.text,
    primary: pickColor(draft, ['primary', 'accent']) ?? draft.colors[0]?.value ?? theme.gold,
    accent: pickColor(draft, ['accent', 'primary']) ?? draft.colors.find((color) => color.role.includes('accent'))?.value ?? theme.accent,
    heading: fontOf(draft, 'heading') ?? draft.fonts[0]?.family ?? 'inherit',
    body: fontOf(draft, 'body') ?? draft.fonts[1]?.family ?? 'inherit',
  };
  return {
    draft, setDraft, savingName, setSavingName, library, metadata,
    selectOwned, saveOwned, setColor, setFont, colorRoles, fontRoles, preview,
  };
}
