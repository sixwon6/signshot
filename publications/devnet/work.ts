/**
 * Disposable devnet acceptance for `era_editions`: sending, deploying, byte verification.
 *
 *  - every key this file touches is generated in `session.ts` and lives only in process memory;
 *    nothing here reads, imports or writes any personal wallet,
 *  - `guard` pins the endpoint AND the devnet genesis hash before any request that could send,
 *  - every send is simulated with `sigVerify` first, size-checked against the packet limit, and
 *    journalled by a blockhash-independent operation id BEFORE it is broadcast, so a lost
 *    response is reconciled rather than duplicated,
 *  - a deployment is accepted only after the uploaded and the deployed bytes are compared with
 *    the locally built ELF byte for byte, and only for the reviewed source this repository holds.
 *
 * The journalled send and the loader-v3 upload are `../deploy/loaderV3`, shared with `../mainnet/`.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { type Instruction, type KeyPairSigner } from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import {
  LEGACY_WITHOUT_GENESIS,
  LEGACY_WITHOUT_OFFERS,
  LEGACY_WITHOUT_PUBLISHED_AT,
  LEGACY_WITHOUT_ROYALTIES_AND_SEEKER_ONLY,
  programFeatures,
} from "../deployments";
import { request } from "../rpc";
import { type TransactionAttempt } from "../lifecycle";
import {
  LAMPORTS_PER_SIGNATURE,
  UPLOAD_CHUNK_BYTES,
  retryRateLimited,
  sendJournalled,
  uploadAndDeploy,
  verifyDeployed,
  type Sender,
} from "../deploy/loaderV3";

/** The reviewed program source this session is allowed to deploy a copy of. */
const PROGRAM_SOURCE = new URL("../../programs/editions/src/lib.rs", import.meta.url);

/** `prepared.json`, written by `programs/editions/scripts/prepare-devnet-windows.ps1`. */
interface PreparedArtifact {
  program: string;
  sourcePath: string;
  binaryPath: string;
  sha256: string;
  bytes: number;
  imagePath: string;
  imageHash: string;
  imageBytes: number;
  sharedSourceSha256: string;
}
export interface Context {
  endpoint: string;
  payer: KeyPairSigner;
  program: KeyPairSigner;
  buffer: KeyPairSigner;
  collectors: KeyPairSigner[];
  reportRoot: string;
  artifact?: PreparedArtifact;
  sendJournal: Record<string, TransactionAttempt & { confirmed?: boolean }>;
  offset?: number;
  initialized?: boolean;
  deployed?: boolean;
  deploymentSignature?: string;
}
export async function guard(c: Pick<Context, "endpoint">) {
  assert.equal(c.endpoint, "https://api.devnet.solana.com");
  assert.equal(
    await request(c.endpoint, "getGenesisHash", []),
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  );
}

/**
 * What this session must still be able to pay for AFTER the program is deployed, from the
 * measured per-instruction lamports in `programs/editions/README.md` rather than a round number,
 * so a new acceptance case cannot silently outgrow the reserve.
 */
export const TEST_COSTS = {
  /**
   * Measured `publish`: supply 3, supply 1, supply 5, the priced supply-3, the sealed 1/1, the
   * zero-royalty supply-2 and the sealed Seeker-only supply-3. Plus 55,680 lamports for the 8
   * bytes of `published_at`, at 6,960 per byte; and 361,920 more for 52 bytes: the
   * collection's `Royalties` plugin (41 bytes of data and a 10-byte registry record) and
   * `seeker_only`.
   */
  publish: 12_905_480,
  publishes: 7,
  /**
   * The Genesis Token stand-in the sealed publish needs: the group mint, one member mint, the
   * payer's frozen token account for it, bob's and an empty one of the payer's. Five Token-2022
   * accounts of about 320, 380, 170, 170 and 165 bytes, as rent, plus their creation fees. The
   * group mint is made once per cluster and skipped when it exists, so a later session pays less.
   */
  genesisFixture: 14_000_000,
  /**
   * One more member mint held by another wallet: 378 and 170 bytes, 5,595,840 of rent, plus a
   * three-signature fee (5,610,840). The reserve holds bob's, for the Seeker-only claims. A
   * `stand-in <wallet>` from `session.ts` is paid from what is left: every rent row here is priced
   * at 6,960 per byte, well above what devnet charges, and the margin alone covers one.
   */
  standIn: 6_000_000,
  /** Bob's stand-in sent to frank: frank's 170-byte token account, 2,074,080, plus the fee. */
  genesisMove: 2_500_000,
  /** Measured first `set_offer`: 1,482,480 lamports of rent for the 85-byte account plus the fee. */
  firstSetOffer: 1_487_480,
  /** Every later `set_offer` writes an account that already exists: one signature. */
  laterSetOffer: 5_000,
  /** 0.01 devnet SOL, the acceptance price. Paid by the buyer, funded by the payer. */
  price: 10_000_000,
  /** Measured `collect`/`buy` issuance, paid by the collector out of its own funding. */
  collect: 5_367_800,
  /** Core `TransferV1` of print #2, paid by its owner. */
  transfer: 1_000_000,
  /** Per disposable wallet, over its own measured work: priority fees, a retry and rounding. */
  walletMargin: 2_000_000,
  /** Payer transaction fees across the run, generously. */
  fees: 1_000_000,
  /** Headroom over the computed need: priority fees, a retry and rounding. */
  margin: 10_000_000,
} as const;

/**
 * What each disposable collector wallet must hold, in the order `session.ts` generates them.
 * Computed from each wallet's own work: a flat grant would push the reserve past what the faucet
 * can give for a program of this size. A wallet that only has rejections simulated for it still
 * needs a balance: simulation verifies signatures and fee payment.
 */
export const WALLET_WORK: readonly {
  name: string;
  claims: number;
  transfers?: number;
  buys?: number;
}[] = [
  { name: "bob", claims: 3, transfers: 1 },
  { name: "carol", claims: 2 },
  { name: "dave", claims: 1 },
  { name: "erin", claims: 1 },
  { name: "frank", claims: 0 },
  { name: "grace", claims: 1, buys: 1 },
  { name: "heidi", claims: 1 },
  { name: "ivan", claims: 0 },
];

/** The lamports one disposable collector wallet is funded with. */
export function walletFunding(index: number): number {
  const work = WALLET_WORK[index];
  assert.ok(work, `No funding is defined for collector wallet ${index}`);
  const t = TEST_COSTS;
  return (
    work.claims * t.collect +
    (work.transfers ?? 0) * t.transfer +
    (work.buys ?? 0) * t.price +
    t.walletMargin
  );
}

/** The lamports `test` needs after `deploy`, computed rather than remembered. */
export function testReserve(): number {
  const t = TEST_COSTS;
  const wallets = WALLET_WORK.reduce((total, _, index) => total + walletFunding(index), 0);
  return (
    wallets +
    t.publish * t.publishes +
    // set_offer 0.01, set_offer 0, set_offer 0.02: one account creation and two rewrites.
    t.firstSetOffer +
    t.laterSetOffer * 2 +
    t.genesisFixture +
    t.standIn +
    t.genesisMove +
    t.fees +
    t.margin
  );
}

/**
 * The most a single devnet `requestAirdrop` is granted. The public faucet refuses larger amounts
 * outright, and this session makes exactly ONE request, so asking for more than it can give would
 * spend the only request on a guaranteed failure.
 */
export const FAUCET_MAX = 2_000_000_000;

/**
 * Everything this session will spend, from this build's size and live rent (the cluster's rent
 * schedule can change), so the session can report how much devnet SOL the run needs.
 *
 * Fees are the buffer writes and the two account creations. Each write has one signature; buffer
 * creation and deployment each have two. The chunk size is the upload loop's
 * (`UPLOAD_CHUNK_BYTES` in `../deploy/loaderV3`), so a larger ELF cannot silently outgrow a fixed
 * fee allowance. No priority fee is requested here. The buffer's own rent is not counted:
 * `DeployWithMaxDataLen` drains it to the payer before it funds program-data, so the two never
 * coexist.
 */
export async function sessionBudget(c: Pick<Context, "endpoint">, elfBytes: number) {
  assert.ok(Number.isSafeInteger(elfBytes) && elfBytes > 0, "Invalid program byte count");
  const rent = (size: number) =>
    request<number>(c.endpoint, "getMinimumBalanceForRentExemption", [size]);
  const [programData, programAccount] = await Promise.all([rent(elfBytes + 45), rent(36)]);
  const reserve = testReserve();
  const fees = (Math.ceil(elfBytes / UPLOAD_CHUNK_BYTES) + 4) * LAMPORTS_PER_SIGNATURE;
  return {
    programData,
    programAccount,
    fees,
    reserve,
    total: programData + programAccount + fees + reserve,
  };
}

/** The journalled send of `../deploy/loaderV3`, guarded to devnet, its journal in the report folder. */
export function send(
  c: Context,
  instructions: Instruction[],
  signers = [c.payer],
  expectedFailure?: RegExp,
) {
  return sendJournalled(sender(c), instructions, signers, expectedFailure);
}

const sender = (c: Context): Sender => ({
  endpoint: c.endpoint,
  payer: c.payer,
  journal: c.sendJournal,
  guard: () => guard(c),
  save: () =>
    writeFileSync(
      join(c.reportRoot, "transactions.json"),
      JSON.stringify(c.sendJournal, null, 2),
    ),
});

/** An account's current confirmed balance, used for funding and deployment preparation. */
export async function balanceOf(c: Pick<Context, "endpoint">, key: string): Promise<number> {
  const { value } = await request<{ value: number }>(c.endpoint, "getBalance", [
    key,
    { commitment: "confirmed" },
  ]);
  assert.ok(Number.isSafeInteger(value) && value >= 0, "Invalid balance");
  return value;
}

export async function test(c: Context) {
  await guard(c);
  assert.ok(c.deployed, "Deploy and verify the program first");
  const { lifecycle } = await import(`./test.ts?run=${Date.now()}`);
  // The lifecycle journals completed checks and transaction signatures on the same context.
  // Resume that work after public RPC throttling, including a lost confirmation response.
  await retryRateLimited(() => lifecycle(c));
}

export async function deploy(c: Context, pause?: () => Promise<void>) {
  // Re-enter through the existing receipt/buffer checks after rate limiting. Never
  // assume that a send failed just because its confirmation request was rejected.
  return retryRateLimited(() => deployAttempt(c, pause), pause);
}

async function deployAttempt(c: Context, pause?: () => Promise<void>) {
  await guard(c);
  assert.ok(
    c.artifact,
    "Prepare the isolated devnet build first",
  );
  // A generated address is never the deployment that predates offers, but say so rather than
  // assume it: if this client thought the new program had no `Offer` account it would send the
  // old seven-account `collect` and no part of the paid acceptance would mean anything.
  assert.ok(
    !LEGACY_WITHOUT_OFFERS.includes(c.program.address) &&
      programFeatures(c.program.address).offers,
    "This client would treat the session program as a deployment without offers",
  );
  // Likewise for the two Genesis Token accounts: without them `publish` would be sent short and
  // the sealed case could not be exercised at all.
  assert.ok(
    !LEGACY_WITHOUT_GENESIS.includes(c.program.address) &&
      programFeatures(c.program.address).genesis,
    "This client would treat the session program as a deployment without Genesis Token accounts",
  );
  // And for `published_at`: read in the older layout, every Edition would be refused as the wrong length.
  assert.ok(
    !LEGACY_WITHOUT_PUBLISHED_AT.includes(c.program.address) &&
      programFeatures(c.program.address).publishedAt,
    "This client would read the session program's editions without their publication time",
  );
  // And for the royalty and Seeker-only arguments: without them `publish` would be sent short,
  // `collect` without its Genesis Token accounts, and every Edition read one byte short.
  assert.ok(
    !LEGACY_WITHOUT_ROYALTIES_AND_SEEKER_ONLY.includes(c.program.address) &&
      programFeatures(c.program.address).royaltiesAndSeekerOnly,
    "This client would treat the session program as a deployment without royalties or Seeker-only editions",
  );
  const source = readFileSync(c.artifact.sourcePath, "utf8");
  assert.ok(
    source.includes(`declare_id!("${c.program.address}")`),
    "Build must use this session program address first",
  );
  // The isolated tree is a copy of this repository's program with only its `declare_id!`
  // rewritten, and `prepared.json` records the digest of the file it copied. Recompute it
  // here so a manifest prepared from some other source tree, or one prepared before a
  // later edit to the reviewed program, cannot be deployed.
  assert.equal(
    c.artifact.sharedSourceSha256,
    createHash("sha256").update(readFileSync(PROGRAM_SOURCE)).digest("hex"),
    "Prepared build was not copied from this repository's reviewed program source",
  );
  const binary = readFileSync(c.artifact.binaryPath);
  assert.equal(
    createHash("sha256").update(binary).digest("hex"),
    c.artifact.sha256,
    "Reviewed build changed",
  );
  assert.equal(binary.length, c.artifact.bytes, "Reviewed build size changed");
  // The preparation manifest names the program ID this exact ELF was built under.
  // Optimized SBF may encode the ID as instruction immediates instead of a contiguous
  // 32-byte constant, so a raw substring search rejects valid binaries. Bind the
  // manifest's declared identity and the hash-checked ELF instead.
  assert.equal(
    c.artifact.program,
    c.program.address,
    "The prepared build belongs to a different program",
  );
  const rent = async (size: number) =>
    request<number>(c.endpoint, "getMinimumBalanceForRentExemption", [size]);
  await uploadAndDeploy({
    sender: sender(c),
    program: c.program,
    buffer: c.buffer,
    binary,
    progress: c,
    saveProgress: () => {},
    rent,
    beforeBuffer: async () => {
      const balance = (
        await request<any>(c.endpoint, "getBalance", [c.payer.address])
      ).value;
      // Refuse to start an upload that would leave the session unable to run `test`: the
      // deployment consumes the grant first and there is only ever one faucet request.
      const budget = await sessionBudget(c, binary.length);
      assert.ok(
        balance >= budget.total,
        `Need ${budget.total} lamports for program rent, deployment fees and test reserve; the payer ` +
          `holds ${balance}, short by ${budget.total - balance}. Fund the generated ` +
          "payer from existing devnet SOL, or stop: do not lower the reserve to fit.",
      );
    },
    prefix: {
      buffer: [],
      write: [],
      deploy: [getSetComputeUnitLimitInstruction({ units: 1_400_000 })],
    },
    pauseMs: 1500,
    skipWritten: false,
    retryPause: pause,
  });
  const { programData } = await verifyDeployed(c.endpoint, c.program.address, binary, c.payer.address);
  c.deployed = true;
  const sha256 = createHash("sha256").update(binary).digest("hex");
  writeFileSync(
    join(c.reportRoot, "deployment.json"),
    JSON.stringify(
      {
        cluster: "devnet",
        program: c.program.address,
        programData,
        signature: c.deploymentSignature ?? null,
        sha256,
        bytes: binary.length,
        authority: c.payer.address,
        authorityPersistence:
          "Ephemeral test session only; redeploy for future changes",
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log("DEPLOYED AND BYTE-VERIFIED", c.program.address);
  printDeploymentsEntry(c.program.address, sha256, binary.length, c.payer.address);
}

/**
 * The exact lines to paste into `publications/deployments.ts` after a byte-verified deploy.
 * Printed, never written: `deployments.ts` is the reviewed allow-list of programs this app will
 * talk to, so a deployment joins it only through a human edit.
 */
function printDeploymentsEntry(program: string, sha256: string, bytes: number, authority: string) {
  const grouped = String(bytes).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  console.log(`
================ PASTE INTO publications/deployments.ts ================

1. HISTORICAL.devnet — add the new address (keep the existing ones; their records stay readable):

  devnet: [
    "${program}",
    "A1fnWjJD7LcHeksyVPiZrUhLoj6T78bEC24iGgf1SLAz",
    "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU",
    "BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq",
  ],

2. PROGRAM_IMAGES.devnet — add the reviewed ELF digest and upgrade authority of what was just
   byte-verified (publish, collect and buy refuse a program without both):

    // The devnet acceptance deployment with royalties and Seeker-only editions (devnet-genesis build).
    "${program}": {
      sha256: "${sha256}",
      bytes: ${grouped},
      upgradeAuthority: "${authority}",
      source: "devnet acceptance build, publications/devnet session",
    },

3. Leave LEGACY_WITHOUT_OFFERS, LEGACY_WITHOUT_GENESIS, LEGACY_WITHOUT_PUBLISHED_AT and
   LEGACY_WITHOUT_ROYALTIES_AND_SEEKER_ONLY exactly as they are: each lists only the OLD builds,
   and the default for anything else is already offers, genesis, publishedAt and
   royaltiesAndSeekerOnly: true. This deployment carries the devnet-genesis stand-in addresses, so
   the sealed publish and the Seeker-only claim work only with stand-ins the fixture mints
   (\`stand-in <wallet>\` in the session), never a real token.

4. Select it, in .env.local (gitignored):

EXPO_PUBLIC_EDITIONS_DEVNET_PROGRAM=${program}

=======================================================================
`);
}
