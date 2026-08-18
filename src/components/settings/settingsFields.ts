import type { IconName } from '../icons';
import type { VendorId } from './vendorIcons';

export type FieldKind = 'secret' | 'text' | 'select' | 'toggle' | 'directory';

export interface SelectOption { readonly value: string; readonly label: string; }

export interface SettingsField {
  readonly name: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly placeholder?: string;
  readonly note?: string;
  readonly options?: readonly SelectOption[];
  readonly defaultLabel?: string;
  readonly defaultValue?: string;
  readonly discoverableModel?: boolean;
}

export interface SettingsVendorPage {
  readonly key: string;
  readonly vendor: VendorId;
  readonly title: string;
  readonly note?: string;
  readonly icon?: IconName;
  readonly connection?: 'codex';
  readonly kind?: 'provider' | 'settings' | 'local-models';
  readonly fields: readonly SettingsField[];
  /** Renders as a button under the note, dispatching a global action. The note
   *  under Anthropic tells Claude Code subscribers where to go (the external
   *  MCP panel) without giving them any way to get there; naming a destination
   *  the reader cannot reach is what made the only entry path undiscoverable. */
  readonly noteAction?: { readonly label: string; readonly action: string };
}

export interface SettingsGroup {
  readonly key: string;
  readonly title: string;
  readonly hint: string;
  readonly route?: SettingsField;
  readonly vendors: readonly SettingsVendorPage[];
}

export interface SettingsCategory {
  readonly key: string;
  readonly title: string;
  readonly icon: IconName;
  readonly groups: readonly SettingsGroup[];
}

export interface KeyState { configured: boolean; source: 'env' | 'runtime' | 'none'; }
export interface KeyStatusResponse {
  keys: Record<string, KeyState>;
  caps: Record<string, boolean>;
  models: Record<string, string>;
  /** Set by the save response when the change only lands on the next launch
   *  (project storage folder: the runtime profile resolves at startup). */
  restartRequired?: boolean;
}
export const secret = (name: string, label: string): SettingsField => ({ name, label, kind: 'secret' });
export const text = (
  name: string,
  label: string,
  placeholder?: string,
  note?: string,
  defaultValue?: string,
): SettingsField => ({ name, label, kind: 'text', placeholder, note, defaultValue });
export const modelText = (
  name: string,
  label: string,
  defaultLabel: string,
  note?: string,
  discoverableModel?: boolean,
): SettingsField => ({ name, label, kind: 'text', defaultLabel, note, discoverableModel });
export const directory = (name: string, label: string, defaultLabel: string, note?: string): SettingsField =>
  ({ name, label, kind: 'directory', defaultLabel, note });
export const modelSelect = (
  name: string,
  label: string,
  defaultLabel: string,
  values: readonly string[],
): SettingsField => ({
  name,
  label,
  kind: 'select',
  defaultLabel,
  options: values.map((value) => ({ value, label: value })),
});

export const routeSelect = (
  name: string,
  options: readonly SelectOption[],
  defaultOptionLabel = '每次询问（默认）',
): SettingsField => ({
  name,
  label: '默认厂商',
  kind: 'select',
  note: '选中未配置的厂商时，Agent 会回退为先询问。',
  options: [{ value: '', label: defaultOptionLabel }, ...options],
});
