const STORAGE_KEY = 'cc.jianyingDraft.v1';

export type JianYingDraftStore = 'capcut' | 'jianying' | 'custom';

export interface JianYingDraftPreference {
  store: JianYingDraftStore;
  customDir: string;
  draftName: string;
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