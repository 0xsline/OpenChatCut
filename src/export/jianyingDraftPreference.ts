const STORAGE_KEY = 'cc.jianyingDraft.v1';

export type JianYingDraftStore = 'capcut' | 'jianying' | 'custom';

export interface JianYingDraftPreference {
  store: JianYingDraftStore;
  customDir: string;
  draftName: string;
}

/** The draft store half of an export request. CapCut and JianYing are named,
 * not given as a path: their stores differ by platform (%LOCALAPPDATA% on
 * Windows, ~/Movies on macOS) and the server resolves them on its own. */
export function jianyingDraftTarget(
  store: JianYingDraftStore,
  customDir: string,
): { store?: 'capcut' | 'jianying'; draftsDir: string } {
  return store === 'custom' ? { draftsDir: customDir.trim() } : { store, draftsDir: '' };
}

/** Where the Chinese JianYing (剪映专业版) app keeps drafts by default, as the
 * dialog shows it; drafts in 6.0+ are encrypted and capcut-cli cannot decrypt
 * them, hence the ≤5.9 note. */
export function jianyingStoreHint(windows: boolean): string {
  return windows
    ? '%LOCALAPPDATA%\\JianyingPro\\User Data\\Projects\\com.lveditor.draft'
    : '~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft';
}

export const DEFAULT_JIANYING_DRAFT_PREFERENCE: JianYingDraftPreference = {
  store: 'capcut',
  customDir: '',
  draftName: '',
};

export function loadJianYingDraftPreference(): JianYingDraftPreference {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? 'null') as Partial<JianYingDraftPreference> | null;
    return {
      store: parsed?.store === 'jianying' || parsed?.store === 'custom' ? parsed.store : 'capcut',
      customDir: typeof parsed?.customDir === 'string' ? parsed.customDir : '',
      draftName: typeof parsed?.draftName === 'string' ? parsed.draftName : '',
    };
  } catch {
    return { ...DEFAULT_JIANYING_DRAFT_PREFERENCE };
  }
}

export function saveJianYingDraftPreference(preference: JianYingDraftPreference): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Export still works when storage is unavailable or full.
  }
}