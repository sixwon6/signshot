/**
 * The deploy's keys and its state file, one folder per cluster under
 * %LOCALAPPDATA%\signshot-deploy\<cluster>\: `deployer.json`, `program.json` and `buffer.json`
 * (the Solana CLI keypair format, 64 numbers) beside `state.json`. Keys are made once and never
 * overwritten; after loading, a private key lives only in a non-extractable CryptoKey. Nothing
 * here prints or saves a secret byte, and the RPC endpoint is never saved.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  type KeyPairSigner,
} from "@solana/kit";
import type { Journal } from "../deploy/loaderV3";
import type { Cluster } from "../types";

export const KEYS = ["deployer", "program", "buffer"] as const;
export type KeyName = (typeof KEYS)[number];
export type Keys = Record<KeyName, KeyPairSigner>;

export interface DeployState {
  version: 1;
  cluster: Cluster;
  createdAt: string;
  deployer: string;
  program: string;
  buffer: string;
  prepared?: {
    outputRoot: string;
    elf: string;
    bytes: number;
    sha256: string;
    sharedSourceSha256: string;
    commit: string | null;
    /** `programs/editions` had no uncommitted change when it was built. */
    sourceClean: boolean;
    at: string;
  };
  svm?: { passed: boolean; sha256: string; at: string };
  quote?: {
    elfBytes: number;
    rent: { programData: number; programAccount: number; buffer: number };
    required: number;
    balance: number;
    at: string;
  };
  /** Rent per account size, frozen on first use so a re-run builds the same transactions. */
  rent?: Record<string, number>;
  deploy?: {
    offset?: number;
    initialized?: boolean;
    deploymentSignature?: string;
    deployed?: boolean;
    programData?: string;
    slot?: string;
  };
  journal: Journal;
  verified?: { authority: string; slot: string; programData: string; at: string };
  vault?: {
    multisig: string;
    vault: string;
    threshold: number;
    members: { name: string; address: string }[];
    at: string;
  };
  authority?: {
    to: string;
    kind: "vault" | "wallet";
    signature?: string;
    confirmed?: boolean;
    at: string;
  };
  refund?: { to: string; lamports: number; signature?: string; confirmed?: boolean; at: string };
  record?: { path: string | null; at: string };
  forgotten?: { at: string };
}

/** %LOCALAPPDATA%\signshot-deploy\<cluster>. */
export function keyRoot(cluster: Cluster): string {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error("LOCALAPPDATA is not set; the deploy keys live under it");
  return join(local, "signshot-deploy", cluster);
}

/** Keys never go into the repository or a temporary folder. */
export function assertKeyRoot(root: string, repoRoot: string) {
  const inside = (parent: string) => {
    const path = relative(resolve(parent), resolve(root));
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  };
  if (inside(repoRoot)) throw new Error(`The key folder ${root} is inside the repository`);
  if (inside(tmpdir())) throw new Error(`The key folder ${root} is inside the temporary folder`);
}

export const statePath = (root: string) => join(root, "state.json");
export const keyPath = (root: string, name: KeyName) => join(root, `${name}.json`);

export function readState(root: string): DeployState | null {
  if (!existsSync(statePath(root))) return null;
  const state = JSON.parse(readFileSync(statePath(root), "utf8")) as DeployState;
  if (state.version !== 1) throw new Error(`Unknown state version in ${statePath(root)}`);
  return state;
}

/** Written whole to a temporary name and renamed over the old file, so a kill leaves one or the other. */
export function saveState(root: string, state: DeployState) {
  const temporary = `${statePath(root)}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n");
  renameSync(temporary, statePath(root));
}

/**
 * Makes the three keys and the state that names them. Refuses when any key file or the state
 * already exists: a key is made once, and only `forget` removes it.
 */
export async function createKeys(root: string, cluster: Cluster, now: Date): Promise<DeployState> {
  for (const path of [statePath(root), ...KEYS.map((name) => keyPath(root, name))])
    if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite deploy keys`);
  mkdirSync(root, { recursive: true });
  const addresses = {} as Record<KeyName, string>;
  for (const name of KEYS) {
    const seed = randomBytes(32);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed, false);
    const pair = [...seed, ...getAddressEncoder().encode(signer.address)];
    seed.fill(0);
    // `wx`: created here or not at all.
    writeFileSync(keyPath(root, name), JSON.stringify(pair), { flag: "wx", mode: 0o600 });
    pair.fill(0);
    addresses[name] = signer.address;
  }
  const state: DeployState = {
    version: 1,
    cluster,
    createdAt: now.toISOString(),
    ...addresses,
    journal: {},
  };
  saveState(root, state);
  return state;
}

/** The three signers, non-extractable, each checked against the address the state recorded. */
export async function loadKeys(root: string, state: DeployState): Promise<Keys> {
  const keys = {} as Keys;
  for (const name of KEYS) {
    const path = keyPath(root, name);
    if (!existsSync(path)) throw new Error(`${path} is missing`);
    const bytes = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
    try {
      if (bytes.length !== 64) throw new Error(`${path} is not a 64-byte keypair`);
      keys[name] = await createKeyPairSignerFromBytes(bytes, false);
    } finally {
      bytes.fill(0);
    }
    if (keys[name].address !== state[name])
      throw new Error(`${path} holds ${keys[name].address}, but the state names ${state[name]}`);
  }
  return keys;
}

/** Deletes the three key files; returns the paths removed. */
export function deleteKeys(root: string): string[] {
  const removed: string[] = [];
  for (const name of KEYS) {
    const path = keyPath(root, name);
    if (existsSync(path)) {
      unlinkSync(path);
      removed.push(path);
    }
  }
  return removed;
}
