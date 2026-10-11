/**
 * Gate for starting a publication, and the lock shared by publishing and transfer. An unreadable
 * draft fails closed so one photo is never paid for twice.
 */

import type { CaptureRecord } from "../../modules/seeker-camera";
import { operationInProgress } from "./locks";
import { CLUSTER_NAME as cluster } from "../solana/cluster";
import type { Cluster, CoreDraft } from "../../publications/types";
// Import cycle with `creator.ts`; safe because nothing crosses it at module scope.
import { readDraft } from "./creator";
import { safeErrorText } from "../ui/errorText";

/** One in-process operation per photo per network, so publishing and transfer never race. */
export function publicationLockKey(cluster: Cluster, baseName: string): string {
  return `publication:${cluster}:${baseName}`;
}

export function publicationInProgress(record: CaptureRecord): boolean {
  return operationInProgress(publicationLockKey(cluster, record.baseName));
}

/** The Core draft, or the reason it could not be read. Never throws. */
async function readCore(
  record: CaptureRecord,
): Promise<{ draft: CoreDraft | null; error?: string }> {
  try {
    return { draft: await readDraft(record) };
  } catch (error) {
    return { draft: null, error: safeErrorText(error) };
  }
}

/**
 * May this photograph start a fresh publication? Returns the existing draft for the caller to
 * continue, `null` when clear, and throws while an operation runs or the draft key cannot be read.
 */
export async function assertFreshIntentAllowed(
  record: CaptureRecord,
): Promise<CoreDraft | null> {
  if (publicationInProgress(record))
    throw new Error("This photo already has a publication in progress. Wait for it to finish.");
  const core = await readCore(record);
  if (core.error)
    throw new Error(
      `${core.error} Its saved edition cannot be replaced until it can be read.`,
    );
  return core.draft;
}
