/**
 * Bundled OFL typefaces (licences in `assets/fonts/`). `useAppFonts` reports ready even on failure
 * so the splash never hangs; Android falls back to the system font.
 */
import { useFonts, type FontSource } from "expo-font";

export const fonts = {
  /** Display and titles. Space Grotesk Medium (500). */
  display: "SpaceGrotesk-Medium",
  /** Body copy. Manrope Regular (400). */
  body: "Manrope-Regular",
  /** Pill and tab labels. Manrope SemiBold (600). */
  bodyStrong: "Manrope-SemiBold",
  /** Labels, readouts and imprints. IBM Plex Mono Regular (400). */
  mono: "IBMPlexMono-Regular",
  /** Selected chips. IBM Plex Mono Medium (500). */
  monoStrong: "IBMPlexMono-Medium",
} as const;

type FontFamily = (typeof fonts)[keyof typeof fonts];

const fontAssets: Record<FontFamily, FontSource> = {
  "SpaceGrotesk-Medium": require("../../assets/fonts/SpaceGrotesk-Medium.ttf"),
  "Manrope-Regular": require("../../assets/fonts/Manrope-Regular.ttf"),
  "Manrope-SemiBold": require("../../assets/fonts/Manrope-SemiBold.ttf"),
  "IBMPlexMono-Regular": require("../../assets/fonts/IBMPlexMono-Regular.ttf"),
  "IBMPlexMono-Medium": require("../../assets/fonts/IBMPlexMono-Medium.ttf"),
};

export function useAppFonts(): boolean {
  const [loaded, error] = useFonts(fontAssets);
  return loaded || error != null;
}
