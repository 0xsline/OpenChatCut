// ZH data dictionary assembly: Chinese display name of English key data (template name, etc.).
import templates from './templates';
import sounds from './sounds';

export const ZH_DATA: Record<string, string> = Object.assign({}, templates, sounds);
