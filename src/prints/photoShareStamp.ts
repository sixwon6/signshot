import { hasUnsafeText } from "../../publications/core/details";
import type { PhotoPublication } from "./photoPresentation";

/**
 * The publishing wallet's `.skr` name for a shared photo or QR card. Anyone can register a name, so
 * one with unsafe (e.g. bidi) characters is not stamped; `ShareStamp.kt` rejects the same code points.
 */
export function photoShareStamp({
  publication,
  enabled,
  wallet,
  name,
}: {
  publication: PhotoPublication;
  enabled: boolean;
  wallet: string | null;
  name: string | null | undefined;
}): { uri: string; expectedHash: string; text: string } | null {
  if (!enabled || !wallet || !name || hasUnsafeText(name)) return null;
  const draft = publication.draft;
  if (!draft) return null;
  if (
    (publication.status !== "published" && draft.confirmedAt === undefined) ||
    draft.edition.creator !== wallet
  )
    return null;
  return {
    uri: `file://${draft.imagePath}`,
    expectedHash: draft.edition.imageHash,
    text: name,
  };
}
