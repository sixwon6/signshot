import type { CaptureRecord, PhotoEdit } from "../../modules/seeker-camera";
import type { RecipeManifest } from "../recipes/model";
import type { PublicationDraft } from "./creator";
import type { PublicationView } from "../../publications/types";
import { hasCorePublication, selectPhotoProof } from "./photoProof";
import { actions } from "../ui/copy";

type PublicationStatus =
  | "local"
  | "checking"
  | "draft"
  | "pending"
  | "published"
  | "unavailable";
/**
 * What a screen is handed about one photograph's publication. `view` holds the derived addresses
 * and links, so no screen builds a URL itself; it is absent when the draft could not be described.
 */
export interface PhotoPublication {
  status: PublicationStatus;
  draft: PublicationDraft | null;
  view?: PublicationView;
  reason?: string;
}

/** Presentation only; the coordinator still validates every operation before any wallet call. */
export function selectPhotoPresentation(
  record: CaptureRecord,
  publication: PhotoPublication,
) {
  const proof = selectPhotoProof(record, publication);
  const core = hasCorePublication(publication);
  const published = proof.confirmation === "confirmed" || proof.confirmation === "cached";
  return {
    proof,
    publishLabel: published ? null : !core ? actions.publish
      : publication.status === "draft" ? actions.continuePublication : actions.checkPublication,
    publisherLabel: published ? "Published by" : "Publishing wallet",
  };
}

/**
 * A saved version, and the recipe that made it. Native storage records only the profile id, so
 * the name and recipe are kept beside it to label the version after the recipe is renamed or gone.
 */
export interface DevelopedEdit extends PhotoEdit {
  recipeName?: string;
  /** The recipe that made this version, whole, so Develop can reopen on it after the recipe is gone. */
  recipe?: { manifest: RecipeManifest; lut: string | null; name: string };
}

/** The recipe a saved version was developed with, by name, or null when it records none. */
export function developedRecipeName(edit?: PhotoEdit): string | null {
  const name = (edit as DevelopedEdit | undefined)?.recipeName;
  return typeof name === "string" && name.length > 0 ? name : null;
}

export function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 5)}…${value.slice(-5)}` : value;
}

/** The photograph's status word, or null for a photograph nothing has been done to. */
export function photoStatus(publication?: PhotoPublication): string | null {
  if (publication?.status === "published")
    return publication.draft?.storage === "available"
      ? "Published"
      : "Upload pending";
  if (publication?.status === "pending" || publication?.status === "checking") return "Checking publication";
  if (publication?.status === "unavailable") return "Status unavailable";
  if (publication?.status === "draft") return "Ready to continue";
  return null;
}

type PhotoMark = "published" | "attention" | null;

/**
 * The one mark a print carries in the Photos grid. "Checking publication" is a read in flight, so
 * it marks nothing.
 */
export function photoMark(publication?: PhotoPublication): PhotoMark {
  const status = photoStatus(publication);
  if (status === null || status === "Checking publication") return null;
  if (status === "Published") return "published";
  return "attention";
}

/** Once a draft exists its source is fixed, including while chain access is unavailable. */
export function selectedPhotoUri(
  record: CaptureRecord,
  edit?: PhotoEdit,
  draft?: PublicationDraft | null,
): string {
  if (draft) return `file://${draft.imagePath}`;
  return edit?.uri ?? record.styledUri;
}

/**
 * The file a share is made from, with the hash it must still have: the native side copies a file
 * only if it matches. Same order as `selectedPhotoUri`: published copy, chosen edit, styled frame.
 */
export function selectedShareSource(
  record: CaptureRecord,
  edit?: PhotoEdit,
  draft?: PublicationDraft | null,
): { uri: string; expectedHash: string } {
  if (draft)
    return { uri: `file://${draft.imagePath}`, expectedHash: draft.edition.imageHash };
  if (edit) return { uri: edit.uri, expectedHash: edit.sha256 };
  return { uri: record.styledUri, expectedHash: record.styled.sha256 };
}

/** Only a photograph with no draft or publication naming a version can be developed again. */
export function canDevelop(publication?: PhotoPublication): boolean {
  return !publication?.draft && publication?.status !== "unavailable";
}
