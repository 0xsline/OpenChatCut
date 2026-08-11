/** design style = the project's brand identity (manage_design_style).
 * The applied style IS the brand — there is no separate "project brand" — and it
 * drives the colors + fonts the agent uses when generating MG / captions.
 *
 * ROLES ARE FREE-FORM (verified against the live `/design-styles/catalog`): real
 * styles use descriptive role names like "accent copper", "text secondary",
 * "Chinese heading", "blob warm", "chart accent 1". The lists below are only the
 * canonical roles the editor UI labels + the keys the legacy object form maps. */
export type ColorRole = string;
export type FontRole = string;
/** canonical color roles the editor surfaces as labelled rows (`Ey`). */
export const COLOR_ROLES: readonly string[] = ['primary', 'secondary', 'accent', 'background', 'text'];
/** canonical font roles the editor surfaces as labelled rows (`Ay`). */
export const FONT_ROLES: readonly string[] = ['heading', 'body'];

export interface DesignColor { role: string; value: string; }
export interface DesignFont { family: string; role: string; }
export interface DesignStyle {
  colors: DesignColor[];
  fonts: DesignFont[];
  /** Project editing guidance for color, typography, captions, pacing, motion,
   * transitions, and explicit avoid rules. */
  styleGuide?: string;
}

/** value of a color role in a style (undefined if the role is unset). */
export const colorOf = (s: DesignStyle | undefined, role: string): string | undefined =>
  s?.colors.find((c) => c.role === role)?.value;
/** font family for a role in a style (undefined if unset). */
export const fontOf = (s: DesignStyle | undefined, role: string): string | undefined =>
  s?.fonts.find((f) => f.role === role)?.family;
