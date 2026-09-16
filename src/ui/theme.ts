/**
 * Colour, spacing and radius tokens. The chrome is near-black so the photograph and its paper
 * frame carry the colour; teal is the working accent, purple sparse emphasis, and paper never meets teal.
 */
export const colors = {
  // --- Chrome -------------------------------------------------------------
  /** The app's ground. Every screen sits on this. */
  ground: "#0B0C0E",
  /** Step 1 — sheets, cards, the Tabs track. */
  sheet: "#111317",
  /** Step 2 — input fields and inset rows. */
  field: "#191C21",
  /** Hairlines and dividers. */
  line: "#262A31",
  /** Primary text, and the fill of white pills. */
  ink: "#F5F4F0",
  /** Secondary text, labels, inactive tab text. */
  muted: "#9BA0A8",

  // --- Accents ------------------------------------------------------------
  /** Working accent: selected chips, slider fills, toggles. */
  teal: "#4EC3B6",
  /** Teal as text or hairline on the ground — the readable step. */
  tealText: "#7FF0DF",
  /** Text and glyphs placed on a teal fill. */
  onTeal: "#06110F",
  /** Sparse emphasis: counts, the published marker. Never a large surface. */
  purple: "#7D5BA6",
  /** Purple as text on the ground. */
  purpleText: "#B49BDA",

  // --- Print --------------------------------------------------------------
  /** Photographic paper. Frames a photograph wherever one is shown at its own size. */
  paper: "#EAE7DD",
  /** The ink printed on that paper: imprints, serial numbers, frame captions. */
  graphite: "#20251E",

  // --- Signals ------------------------------------------------------------
  /** Destructive actions. Outline and text only, never a fill. */
  danger: "#FF917E",
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 20,
  xl: 28,
  xxl: 40,
  /** Screen side padding. */
  gutter: 18,
} as const;

export const radius = {
  small: 10,
  card: 20,
  /** Pills, chips and the Tabs track. */
  pill: 999,
  /** Paper prints. No corner radius. */
  print: 0,
} as const;
