/** Official MiniMax T2A `language_boost` enum. Shared by tool schema and server validation. */
export const MINIMAX_LANGUAGE_BOOSTS = [
  'Chinese', 'Chinese,Yue', 'English', 'Arabic', 'Russian', 'Spanish', 'French', 'Portuguese',
  'German', 'Turkish', 'Dutch', 'Ukrainian', 'Vietnamese', 'Indonesian', 'Japanese', 'Italian',
  'Korean', 'Thai', 'Polish', 'Romanian', 'Greek', 'Czech', 'Finnish', 'Hindi', 'Bulgarian',
  'Danish', 'Hebrew', 'Malay', 'Persian', 'Slovak', 'Swedish', 'Croatian', 'Filipino', 'Hungarian',
  'Norwegian', 'Slovenian', 'Catalan', 'Nynorsk', 'Tamil', 'Afrikaans', 'auto',
] as const;

export type MinimaxLanguageBoost = typeof MINIMAX_LANGUAGE_BOOSTS[number];
