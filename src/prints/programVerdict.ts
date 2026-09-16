/**
 * Which recovery a sheet should offer for a program failure. The matched sentences are produced by
 * `describeProgramError` itself from synthetic errors, so they cannot drift from what
 * `prepareTransaction` throws.
 *
 *   `publish-without-album`  Core's `GroupVectorFull` (54): the album is full; publish without it.
 *   `new-album`              `ExistingAsset` (6003) from `create_album`: choose a different name.
 */
import {
  describeProgramError,
  type ProgramErrorFallback,
} from "../../publications/rpc";
import { MPL_CORE } from "../../publications/core/protocol";

/** The shape `simulateTransaction` and `getTransaction` both report a program failure in. */
const failure = (code: number, program: string) => ({
  err: { InstructionError: [0, { Custom: code }] },
  logs: [`Program ${program} failed: custom program error: 0x${code.toString(16)}`],
});

/** An Anchor code is read whatever program failed, so any program id works here. */
const ERA_EDITIONS_PLACEHOLDER = "Editions1111111111111111111111111111111111";

const VERDICTS: readonly { message: string; fallback: ProgramErrorFallback }[] = [
  describeProgramError(failure(54, MPL_CORE), null, { operation: "publish-in-album" }),
  describeProgramError(failure(6003, ERA_EDITIONS_PLACEHOLDER), null, {
    operation: "create-album",
  }),
]
  .filter((verdict) => verdict.known && verdict.fallback !== undefined)
  .map((verdict) => ({ message: verdict.message, fallback: verdict.fallback! }));

/** The action to offer instead of this failure, if there is one. */
export function programFallback(error: unknown): ProgramErrorFallback | undefined {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return VERDICTS.find((verdict) => text.includes(verdict.message))?.fallback;
}
