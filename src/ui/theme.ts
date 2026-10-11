/** Design tokens. Paper never meets teal. */
export const colors = {
  // Chrome
  ground: "#0B0C0E",
  /** Sheets and cards. */
  sheet: "#111317",
  /** Input fields and inset rows. */
  field: "#191C21",
  line: "#262A31",
  ink: "#F5F4F0",
  muted: "#9BA0A8",

  // Accents
  /** Working accent: selected chips, slider fills, toggles. */
  teal: "#4EC3B6",
  /** Teal for text or hairlines on the ground. */
  tealText: "#7FF0DF",
  onTeal: "#06110F",
  /** Never a large surface. */
  purple: "#7D5BA6",
  purpleText: "#B49BDA",

  // Print
  paper: "#EAE7DD",
  /** Ink on paper. */
  graphite: "#20251E",

  // Signals
  /** Outline and text only, never a fill. */
  danger: "#FF917E",
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 20,
  xl: 28,
  xxl: 40,
  gutter: 18,
} as const;

export const radius = {
  small: 10,
  card: 20,
  pill: 999,
  print: 0,
} as const;
