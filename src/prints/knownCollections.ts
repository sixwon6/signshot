import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Cluster } from "../../publications/types";

/**
 * Collections this wallet has had a print verified in, per wallet and cluster. Anyone can mint
 * Core assets owned by any wallet and crowd real prints out of the owner scan, so these seed a
 * targeted scan. Entries only choose a filter; every returned row is verified from scratch.
 */

/** Matches `MAX_TARGETED_COLLECTIONS` in `publications/core/library.ts`; more would be dropped. */
const MAX_KNOWN_COLLECTIONS = 32;

/** Base58 addresses are 32..44 characters. Cheap shape check, so junk is never stored. */
const ADDRESS_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const knownCollectionsKey = (cluster: Cluster, wallet: string) =>
  `es.known-collections.v1:${cluster}:${wallet}`;

/** The remembered seeds, newest first. Never throws; a corrupt value reads as no seeds. */
export async function readKnownCollections(
  cluster: Cluster,
  wallet: string,
): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(knownCollectionsKey(cluster, wallet));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return dedupe(parsed).slice(0, MAX_KNOWN_COLLECTIONS);
  } catch {
    return [];
  }
}

/**
 * Fold this load's verified collections into the stored list, newest first. A union rather than a
 * replacement: the load that most needs a seed may be the one whose results were crowded out.
 */
export async function rememberKnownCollections(
  cluster: Cluster,
  wallet: string,
  collections: readonly unknown[],
): Promise<void> {
  try {
    const seen = dedupe(collections);
    if (!seen.length) return;
    const stored = await readKnownCollections(cluster, wallet);
    const next = dedupe([...seen, ...stored]).slice(0, MAX_KNOWN_COLLECTIONS);
    if (next.length === stored.length && next.every((v, i) => v === stored[i])) return;
    await AsyncStorage.setItem(
      knownCollectionsKey(cluster, wallet),
      JSON.stringify(next),
    );
  } catch {
    /* Best effort: a seed that could not be written costs a slower scan, never a failed read. */
  }
}

/** Well-shaped addresses, in first-seen order, with duplicates removed. */
function dedupe(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !ADDRESS_SHAPE.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
