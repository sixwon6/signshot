/**
 * The collect page's router: `/collect/?core=<edition PDA>[&cluster=devnet]`.
 *
 * Exactly one non-empty `core` must be present; a missing or repeated one is an error panel, never
 * a guess. Unknown parameters (`utm_*`, `fbclid` and the like, added by messaging apps) are
 * ignored, since the page reads nothing but `core` and `cluster`. Retired routes (such as
 * `?album=`, which the app refuses too) and names that would steer the page are refused.
 *
 * The page never tries a second decoder when the first refuses an account, and never takes an RPC
 * endpoint or program address from the link: both come from the build's reviewed tables, so a
 * shared QR cannot point a collector's wallet at an unreviewed program or a node faking chain state.
 */
import { fail, params, run } from "./page";
import { coreAdapter } from "./core";

/** Names that must never appear: retired routes, and anything shaped like a redirect. */
const REFUSED = ["print", "album", "rpc", "endpoint", "program", "url", "api"];
const LINK_ERROR =
  "This is not a Signshot edition link. Open the link from the publisher’s share card, or from the page they shared.";

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
