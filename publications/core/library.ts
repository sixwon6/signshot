/**
 * The Wallet screen's two lists. Published: the editions whose guard this wallet holds. Collected:
 * Core assets this wallet owns whose collection belongs to an edition `readEdition` accepts. Copies
 * of anything else are not shown.
 */
import { address, getBase64Decoder } from "@solana/kit";
import {
  copiesHeld,
  editionDisplay,
  heldCollections,
  loadEdition,
  machineOf,
  publishedBy,
  type EditionDisplay,
} from "../editions";
import type { Cluster } from "../types";

export type LibraryMode = "collected" | "published";
export type LibraryPhoto = {
  /** The candy machine (published) or the copy's Core asset (collected). */
  id: string;
  photo: EditionDisplay;
  imageUri: string;
  number?: number;
  /** The wallet the scan found holding this copy. Collected copies only. */
  owner?: string;
};
export type LibraryResult = {
  items: LibraryPhoto[];
  unavailable: number;
  /** Candidates this scan did not resolve, because the cap was reached. */
  hiddenCount: number;
};

/** Editions resolved per scan. */
const MAX_EDITIONS = 60;

export async function loadLibrary(
  endpoint: string, cluster: Cluster, wallet: string, mode: LibraryMode,
  signal?: AbortSignal, _knownCollections?: readonly string[],
): Promise<LibraryResult> {
  address(wallet);
  const check = () => { if (signal?.aborted) throw new Error("Library request cancelled."); };
  const result: LibraryResult = { items: [], unavailable: 0, hiddenCount: 0 };
  const imageUri = (d: EditionDisplay) => `data:image/jpeg;base64,${getBase64Decoder().decode(d.imageBytes)}`;
  const show = async (candyMachine: string) => {
    const verdict = await loadEdition(endpoint, candyMachine);
    if (!verdict.ok) return null;
    return editionDisplay(cluster, verdict);
  };

  if (mode === "published") {
    const machines = await publishedBy(endpoint, wallet);
    result.hiddenCount = Math.max(0, machines.length - MAX_EDITIONS);
    for (const machine of machines.slice(0, MAX_EDITIONS)) {
      check();
      try {
        const photo = await show(machine);
        if (!photo) continue;
        if (photo.edition.creator !== wallet) continue;
        result.items.push({ id: machine, photo, imageUri: imageUri(photo) });
      } catch {
        result.unavailable++;
      }
    }
  } else {
    const held = [...(await heldCollections(endpoint, wallet)).keys()];
    result.hiddenCount = Math.max(0, held.length - MAX_EDITIONS);
    for (const collection of held.slice(0, MAX_EDITIONS)) {
      check();
      try {
        const machine = await machineOf(endpoint, collection);
        if (!machine) continue;
        const photo = await show(machine);
        if (!photo || photo.edition.collection !== collection) continue;
        const uri = imageUri(photo);
        for (const copy of await copiesHeld(endpoint, collection, wallet))
          if (copy.edition !== null)
            result.items.push({ id: copy.address, photo, imageUri: uri, number: copy.edition, owner: wallet });
      } catch {
        result.unavailable++;
      }
    }
  }
  check();
  result.items.sort((a, b) => a.photo.edition.title.localeCompare(b.photo.edition.title) ||
    a.photo.edition.edition.localeCompare(b.photo.edition.edition) || (a.number ?? 0) - (b.number ?? 0));
  return result;
}
