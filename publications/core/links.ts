import { address } from "@solana/kit";
import type { Cluster } from "../types";

/**
 * Public link: edition and cluster only, never an RPC endpoint or program. Also the document's
 * `external_url`, which `readPhotoMetadata` requires verbatim.
 */
export function collectUrl(edition: string, cluster: Cluster, origin = "https://erashot.app") {
  address(edition);
  return `${origin}/collect/?core=${edition}${cluster === "devnet" ? "&cluster=devnet" : ""}`;
}
