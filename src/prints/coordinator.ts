/**
 * Decides whether a photograph may start a new publication, and owns the one lock every
 * publication and transfer operation takes. An unreadable draft fails closed: not knowing cannot
 * authorise spending SOL twice on one photograph.
 */

import type { CaptureRecord } from "../../modules/seeker-camera";
import { operationInProgress } from "./locks";
import { CLUSTER_NAME as cluster } from "../solana/cluster";
import type { Cluster, CoreDraft } from "../../publications/types";
// `creator.ts` imports this module in return; only function references cross that cycle and
// none of them runs at module scope.
import { readDraft } from "./creator";
import { safeErrorText } from "../ui/errorText";

/**
 * One in-process operation per photograph per network, shared by publishing and transfer so the
 * two can never race for one wallet.
 */
export function publicationLockKey(cluster: Cluster, baseName: string): string {
  return `publication:${cluster}:${baseName}`;
}

/** Is a publication operation running for this photograph right now? */
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
