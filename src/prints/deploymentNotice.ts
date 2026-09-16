/**
 * What the publishing sheet says about the program it is about to publish to. An upgradeable
 * program's bytes can be replaced at the same address, so the deployed image is compared with the
 * reviewed digest; anything a person cannot act on produces no line at all.
 */
import {
  deploymentStatus,
  type DeploymentStatus,
} from "../../publications/programImage";
import { configuredProgram } from "../../publications/deployments";
import { CLUSTER_NAME as cluster, RPC_ENDPOINT } from "../solana/cluster";
import { publish as copy } from "../ui/copy";

/** The sentence to show, or null when there is nothing a person could do anything with. */
export function deploymentNotice(status: DeploymentStatus | null): string | null {
  if (!status || !status.available) return null;
  if (status.matchesPin === false) return copy.programReplaced;
  return null;
}

let pending: Promise<DeploymentStatus | null> | null = null;

/** The configured program's deployed image, read at most once per process. Never throws. */
export function sessionDeploymentStatus(): Promise<DeploymentStatus | null> {
  pending ??= (async () => {
    try {
      return await deploymentStatus(RPC_ENDPOINT, configuredProgram(cluster), cluster);
    } catch {
      // A failure is not memoized, so a later sheet can ask again.
      pending = null;
      return null;
    }
  })();
  return pending;
}
