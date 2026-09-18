/**
 * The collector page's router.
 *
 * A public link names its publication protocol explicitly and permanently:
 *
 *   /collect/?core=<edition PDA>[&cluster=devnet]   metaplex-core-editions-v1, one photograph
 *
 * with an optional `cluster`. EXACTLY ONE `core` must be present and non-empty; a missing or
 * repeated one is an error panel — never a guess. The app refuses album links too
 * (`src/prints/collect.ts`), so the old `?album=` route is not served here either.
 *
 * Unknown parameters are IGNORED, not refused. Real share links pick up `utm_*`, `fbclid`,
 * `igshid` and friends on the way through a messaging app, and a collector whose link was
 * "helpfully" tagged must still see the photograph. Ignoring is safe because the page reads
 * nothing but `core` and `cluster`: an unread parameter cannot influence anything.
 *
 * The exception is a short list of names that would be an attempt to steer the page —
 * `print`, `rpc`, `endpoint`, `program`, `url`, `api`. None of them does anything here, so any
 * link carrying one is either a retired route or someone probing for a way in; both deserve a
 * refusal rather than a page that silently ignores what the sender intended.
 *
 * Two rules the routing exists to keep. The page never tries a second decoder when the first
 * refuses an account: that would let a link author point at whichever account happened to
 * decode. And it never accepts an RPC endpoint or a program address from the link — both come
 * from the build's reviewed tables, so a shared QR cannot redirect a collector's wallet at an
 * unreviewed program or a chain-state-faking node.
 */
import { fail, params, run } from "./page";
import { coreAdapter } from "./core";

/** Names that must never appear: retired routes, and anything shaped like a redirect. */
const REFUSED = ["print", "album", "rpc", "endpoint", "program", "url", "api"];
const LINK_ERROR =
  "This is not a Seedshot edition link. Open the link from the publisher’s share card, or from the page they shared.";

function route(): (() => void) | null {
  if (REFUSED.some((name) => params.has(name))) return null;
  // A repeated parameter has no answer: `?core=a&core=b` names two different editions.
  const core = params.getAll("core");
  if (core.length !== 1 || params.getAll("cluster").length > 1) return null;
  return core[0] ? () => run(coreAdapter(core[0])) : null;
}

const open = route();
if (open) open();
else fail(LINK_ERROR);
