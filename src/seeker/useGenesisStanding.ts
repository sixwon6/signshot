import { useEffect, useState } from "react";
import { verifyGenesisToken, type GenesisCheck } from "../../publications/core/genesisToken";
import { MAINNET_READ_ENDPOINT } from "../solana/cluster";

/**
 * A document's Seeker Genesis Token claim, checked against mainnet for a screen: the mint is a
 * genuine SGT and `holder` (the publishing wallet) holds it now. Null when there is no claim.
 * `unavailable` (mainnet could not be asked) is never shown as held, never as not held.
 */
export function useGenesisStanding(
  mint: string | undefined,
  holder: string | undefined,
): GenesisCheck | null {
  const key = mint && holder ? `${mint}:${holder}` : null;
  const [check, setCheck] = useState<{ key: string; value: GenesisCheck } | null>(null);

  useEffect(() => {
    if (!mint || !holder || !key) return;
    let live = true;
    verifyGenesisToken(MAINNET_READ_ENDPOINT, mint, holder).then(
      (value) => {
        if (live) setCheck({ key, value });
      },
      () => {
        if (live) setCheck({ key, value: "unavailable" });
      },
    );
    return () => {
      live = false;
    };
  }, [key, mint, holder]);

  if (!key) return null;
  return check?.key === key ? check.value : "checking";
}
