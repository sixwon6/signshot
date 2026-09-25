import { address } from "@solana/kit";
import type { Cluster } from "../types";

/**
 * The public link: an edition address and a cluster only, never an RPC endpoint or program.
 * `?core=` names the protocol so an unknown parameter set is an error. Also the document's
 * `external_url`, which `readPhotoMetadata` requires to be exactly this.
 */
export function collectUrl(edition: string, cluster: Cluster, origin = "https://erashot.app") {
  address(edition);
  return `${origin}/collect/?core=${edition}${cluster === "devnet" ? "&cluster=devnet" : ""}`;
}
