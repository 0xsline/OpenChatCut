import { invokeAction } from '../../shortcuts/actionRegistry';
import type { SettingsVendorPage } from './settingsFields';

export type NoteAction = NonNullable<SettingsVendorPage['noteAction']>;

/** Open the settings page a note button names, or dispatch its global action. */
export function runNoteAction(config: NoteAction, openPage: (route: string) => void): void {
  if ('route' in config) openPage(config.route);
  else invokeAction(config.action, undefined, 'menu');
}
