// One shared model list for the new-session modal and the HUD switcher.
// Aliases resolve in the claude CLI; Fable 5 needs the full model ID.
export const MODELS = [
  { value: 'claude-fable-5', label: 'Fable 5 (most capable)' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];
