import { turboItemStatus, TurboError } from "../src/arweave/turbo";
import { TURBO_PAYMENT_HOSTS, TURBO_UPLOAD_HOSTS } from "./turboHosts";
import type { PublicationStorageProblem } from "./types";

type StorageProblem = PublicationStorageProblem;
class PublicationStorageError extends Error {
  constructor(readonly problem: StorageProblem) { super(problem.message); }
}
async function json(url: string) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("Storage provider is unavailable.");
    return await response.json();
  } finally { clearTimeout(timer); }
}
/** The first host that answers, in `turboHosts.ts` order, so one dead host cannot stop a publication. */
async function firstAnswer(hosts: readonly string[], path: (host: string) => string) {
  let last: unknown;
  for (const host of hosts) {
    try { return await json(path(host)); } catch (error) { last = error; }
  }
  throw last ?? new Error("Storage provider is unavailable.");
}
/** Advisory allowance only: the provider's shared-IP quota is checked at upload time. */
export async function checkStorageCapacity(uploader: string, items: { id: string; bytes: Uint8Array }[]) {
  const held = await Promise.all(items.map(item => turboItemStatus(item.id)));
  const pending = items.filter((_, index) => !held[index]);
  if (!pending.length) return { requiredBytes: 0, remainingBytes: null };
  let info, allowance;
  try {
    [info, allowance] = await Promise.all([
      firstAnswer(TURBO_UPLOAD_HOSTS, (host) => `${host}/info`),
      firstAnswer(
        TURBO_PAYMENT_HOSTS,
        (host) => `${host}/v1/account/free?address=${encodeURIComponent(uploader)}`,
      ),
    ]);
  } catch {
    throw new PublicationStorageError({ kind: "unavailable", retryable: true,
      message: "Could not check image storage. Try again before approving a wallet transaction." });
  }
  const limit = info?.freeTier?.maxItemBytes ?? info?.freeUploadLimitBytes;
  const remaining = allowance?.bytesRemaining;
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(remaining) || remaining < 0)
    throw new PublicationStorageError({ kind: "unavailable", retryable: true,
      message: "The storage provider returned an unsupported allowance. Publishing is paused until it can be checked." });
  if (pending.some(item => item.bytes.length >= limit))
    throw new PublicationStorageError({ kind: "size", retryable: false,
      message: "This published copy exceeds the provider's free image size. It cannot be uploaded by this build." });
  const requiredBytes = pending.reduce((sum, item) => sum + item.bytes.length, 0);
  if (requiredBytes > remaining)
    throw new PublicationStorageError({ kind: "quota", retryable: false,
      message: "The free image-storage allowance is used up. Publishing needs paid storage support before you can continue; no wallet approval is needed now." });
  return { requiredBytes, remainingBytes: remaining };
}
export function storageProblem(error: unknown): StorageProblem {
  if (error instanceof PublicationStorageError) return error.problem;
  if (error instanceof TurboError && error.status === 402)
    return { kind: "quota", retryable: false, message: "The storage provider refused the free upload allowance. Your wallet record remains published, but completing the image upload needs restored provider capacity or paid storage support." };
  if (error instanceof TurboError && error.status === 413)
    return { kind: "size", retryable: false, message: "The storage provider refused this image's size. Your wallet record remains published; this build cannot complete its upload." };
  const message = error instanceof Error ? error.message : String(error);
  if (/fingerprint|identifiers changed|Saved print changed|not retryable|does not match its onchain/i.test(message))
    return { kind: "integrity", retryable: false, message: "The image or metadata no longer matches its published fingerprint. Upload stopped. This app's storage and its upload key hold the only copy of the published image and details; export the publication bundle from this photograph to keep them." };
  return { kind: "unavailable", retryable: true, message: "The wallet record is published. Its image is still uploading or becoming available; you can check and complete the upload again." };
}
