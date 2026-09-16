import type { CaptureRecord } from "../../modules/seeker-camera";
import type { PublicationDraft, PublicationState } from "./creator";
import type { TransferState } from "./transfer";

interface DeletionChecks {
  readCapture(baseName: string): Promise<CaptureRecord | undefined>;
  readPublication(record: CaptureRecord): Promise<PublicationState>;
  readTransfer(record: CaptureRecord, draft: PublicationDraft): Promise<TransferState>;
  publicationWorking(record: CaptureRecord): boolean;
  transferWorking(record: CaptureRecord): boolean;
  /** Deletes the files and the durable state that describes them; the draft names the transfer key. */
  removeFiles(record: CaptureRecord, draft: PublicationDraft | null): Promise<void>;
}

const IN_FLIGHT = "Wait for the current publish or send to finish, then delete.";
const MAY_LAND = "A transaction for this photo may still land. Check it, then delete.";

/**
 * Called after the confirmation tap, on freshly read state. Only work in flight, or a transaction
 * that may still land, blocks deletion.
 */
export async function deletePhotoAfterFreshChecks(
  baseName: string,
  checks: DeletionChecks,
): Promise<void> {
  const record = await checks.readCapture(baseName);
  if (!record) throw new Error("This photo is no longer on the phone. Refresh Photos.");
  const busy = () => checks.publicationWorking(record) || checks.transferWorking(record);
  if (busy()) throw new Error(IN_FLIGHT);
  const publication = await checks.readPublication(record);
  if (publication.status === "pending") throw new Error(MAY_LAND);
  if (publication.draft) {
    const transfer = await checks.readTransfer(record, publication.draft);
    if (transfer.status === "pending") throw new Error(MAY_LAND);
  }
  if (busy()) throw new Error(IN_FLIGHT);
  await checks.removeFiles(record, publication.draft);
}
