/**
 * The six-step type scale. Each step is a ready-to-spread `TextStyle` with no colour. React Native
 * takes letter-spacing in points, so each value is the em figure times the font size.
 */
import type { TextStyle } from "react-native";
import { fonts } from "./fonts";

/** Screen headings. */
const display: TextStyle = {
  fontFamily: fonts.display,
  fontSize: 32,
  lineHeight: 34,
  letterSpacing: -0.64, // -0.02em × 32
};

/** Sheet and photo-detail titles. */
const title: TextStyle = {
  fontFamily: fonts.display,
  fontSize: 24,
  lineHeight: 27,
  letterSpacing: -0.48, // -0.02em × 24
};

/** Body text and help. */
const body: TextStyle = {
  fontFamily: fonts.body,
  fontSize: 15,
  lineHeight: 21,
  letterSpacing: 0,
};

/** Field labels. */
const label: TextStyle = {
  fontFamily: fonts.mono,
  fontSize: 10,
  lineHeight: 14,
  letterSpacing: 1.6, // .16em × 10
  textTransform: "uppercase",
};

/** Camera and chain values. */
const readout: TextStyle = {
  fontFamily: fonts.mono,
  fontSize: 13,
  lineHeight: 17,
  letterSpacing: 1.82, // .14em × 13
  textTransform: "uppercase",
};

/** Captions printed on the photo frame. */
const imprint: TextStyle = {
  fontFamily: fonts.mono,
  fontSize: 9,
  lineHeight: 12,
  letterSpacing: 1.62, // .18em × 9
  textTransform: "uppercase",
};

export const typeScale = {
  display,
  title,
  body,
  label,
  readout,
  imprint,
} as const;
