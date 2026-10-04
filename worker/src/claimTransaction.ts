import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";

/**
 * The only transactions the co-signer key ever signs: a claim of one copy of a Seeker-only
 * edition, exactly as the app's client builds it (`claimDraft` in
 * publications/candy/edition.ts, instruction builders in publications/candy/programs.ts).
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 * │ CLAIM LAYOUT                                                                             │
 * │                                                                                          │
 * │ v0 messages, signed by the wallet first; accounts resolved through each instruction's     │
 * │ indexes (the wallet reorders them). Beside the shapes: at most one SetComputeUnitLimit    │
 * │ and one SetComputeUnitPrice, capped; `WALLET_ADDED_PROGRAMS_ALLOWED` (empty).             │
 * │ Three shapes, nothing else. W = wallet (fee payer, minter), P = one-shot payer (fresh    │
 * │ keypair), A = the copy (fresh keypair), T = temporary token account (fresh keypair),     │
 * │ S = this Worker's key. Accounts listed in instruction order.                              │
 * │                                                                                          │
 * │ free / SOL price                                                                          │
 * │   0 System Transfer(2, u64)          [W ws, P w]                                          │
 * │   1 Candy Guard mint_v1               13 fixed + remaining                                │
 * │   2 System Allocate(8, u64)          [P ws]                                               │
 * │   signers: W, P, A, S                                                                     │
 * │                                                                                          │
 * │ token price                                                                               │
 * │   0 System Transfer(2, u64)          [W ws, P w]                                          │
 * │   1 System CreateAccount(0, u64 lamports, u64 165, Token program)  [W ws, T ws]           │
 * │   2 Token InitializeAccount3(18, owner = W)   [T w, mint r]                               │
 * │   3 Token Transfer(3, u64)           [ATA(W, mint) w, T w, W rs]                          │
 * │   4 Candy Guard mint_v1               13 fixed + remaining                                │
 * │   5 System Allocate(8, u64)          [P ws]                                               │
 * │   6 Token CloseAccount(9)            [T w, W w, W rs]                                     │
 * │   signers: W, P, A, T, S                                                                  │
 * │                                                                                          │
 * │ Sources: Core Candy Guard IDL `mintV1` (mpl-core-candy-machine, idls/candy_guard.json),  │
 * │ the guards' account cursors in the program source, and the client named above.           │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 */
export const LAYOUT = {
  /** sha256("global:mint_v1")[..8]; equal to the official generated client's `discriminator`. */
  discriminator: [145, 98, 192, 118, 184, 147, 118, 104],
  /** `mint_args: Vec<u8>` empty (u32 0), then `label: Option<String>` = None (0x00): no groups. */
  mintDataLength: 8 + 4 + 1,
  /** The 13 fixed accounts of `mintV1`, by position. */
  accounts: {
    candyGuard: 0, //            PDA ["candy_guard", candy machine]: the app uses the candy machine as base
    candyMachineProgram: 1,
    candyMachine: 2, //          the edition
    candyMachineAuthority: 3, // PDA ["candy_machine", candy machine] of the Candy Machine program
    payer: 4, //                 P, the one-shot payer
    minter: 5, //                W
    owner: 6, //                 absent (= the guard program id) or W
    asset: 7, //                 A
    collection: 8, //            the candy machine's collection (checked on chain)
    mplCore: 9,
    systemProgram: 10,
    sysvarInstructions: 11,
    recentSlotHashes: 12,
  },
  fixedAccounts: 13,
  /**
   * Remaining accounts, in GuardSet order for a Seeker-only default set (no groups, no Mint Limit):
   *   free   [S]
   *   SOL    [Sol Payment destination, S]
   *   token  [T (source), destination ATA, Token program, S]
   * The Edition guard takes no account.
   */
  remaining: { free: 1, sol: 2, token: 4 },
  signers: { free: 4, sol: 4, token: 5 },
  system: { createAccount: 0, transfer: 2, advanceNonce: 4, allocate: 8 },
  token: { transfer: 3, closeAccount: 9, initializeAccount3: 18 },
  /** Token account size the temporary account is created with. */
  tokenAccountBytes: 165,
  /**
   * The wallet signs first and may rewrite its own ComputeBudget instructions (Seed Vault replaces
   * the SetComputeUnitPrice value and reorders the message's accounts). Accepted at any position:
   * SetComputeUnitLimit (2, u32) and SetComputeUnitPrice (3, u64), at most one each, no accounts,
   * within the caps below.
   */
  computeBudget: { setComputeUnitLimit: 2, setComputeUnitPrice: 3 },
} as const;

export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
/** The runtime's own ceiling on a transaction's compute units. */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
/** Without SetComputeUnitLimit the runtime grants 200k units per non-ComputeBudget instruction. */
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000;
/**
 * The most priority fee (price × limit, in lamports) a claim may carry: 0.0001 SOL. The app reviews
 * at most 50,000 lamports (src/prints/send.ts) and lets a wallet's rewrite add at most 50,000 more
 * (`FEE_ALLOWANCE_LAMPORTS`, publications/candy/transactions.ts). Price × limit is the only way
 * this transaction can cost the wallet more than the reviewed amounts.
 */
export const MAX_PRIORITY_FEE_LAMPORTS = 300_000n;

export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
/**
 * Programs whose instructions a wallet is known to add beside the claim, set aside by the shape
 * check (they may not name the co-signer or the one-shot payer). EMPTY: whether Seed Vault adds
 * Lighthouse assertions (`LIGHTHOUSE_PROGRAM`) is measured on the phone, and that result goes
 * here. No other program is ever allowed.
 */
export const WALLET_ADDED_PROGRAMS_ALLOWED: readonly string[] = [];

export const CANDY_GUARD_PROGRAM = "CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ";
export const CANDY_MACHINE_PROGRAM = "CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J";
export const MPL_CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";
export const SYSVAR_SLOT_HASHES = "SysvarS1otHashes111111111111111111111111111";

// -------------------------------------------------------------------------------------------
// Wire format (legacy and v0), parsed strictly
// -------------------------------------------------------------------------------------------

export interface CompiledInstruction { programIndex: number; accounts: number[]; data: Uint8Array }

export interface ParsedTransaction {
  version: "legacy" | 0;
  signatureCount: number;
  /** The 64-byte signatures, in signer order. */
  signatures: Uint8Array[];
  /** Where the signatures start in the wire bytes. */
  signaturesStart: number;
  /** The bytes every signature signs. */
  message: Uint8Array;
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  keys: string[];
  blockhash: string;
  instructions: CompiledInstruction[];
  lookupCount: number;
}

export class Refused extends Error {
  constructor(readonly reason: string) { super(reason); }
}

const refuse = (reason: string): never => { throw new Refused(reason); };

/** Solana's packet limit: no valid transaction is longer. */
export const MAX_TRANSACTION_BYTES = 1232;

class Cursor {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  u8() { if (this.at >= this.bytes.length) refuse("malformed"); return this.bytes[this.at++]; }
  take(n: number) {
    if (this.at + n > this.bytes.length) refuse("malformed");
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  /** Compact-u16, canonical encoding only. */
  shortVec() {
    let value = 0;
    for (let i = 0; i < 3; i += 1) {
      const byte = this.u8();
      value |= (byte & 0x7f) << (7 * i);
      if ((byte & 0x80) === 0) {
        if (i > 0 && byte === 0) refuse("malformed");
        if (value > 0xffff) refuse("malformed");
        return value;
      }
    }
    return refuse("malformed");
  }
}

const keyDecoder = getAddressDecoder();
const keyEncoder = getAddressEncoder();

export function parseTransaction(wire: Uint8Array): ParsedTransaction {
  if (wire.length > MAX_TRANSACTION_BYTES) refuse("malformed");
  const c = new Cursor(wire);
  const signatureCount = c.shortVec();
  const signaturesStart = c.at;
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < signatureCount; i += 1) signatures.push(c.take(64));
  const messageStart = c.at;
  let version: "legacy" | 0 = "legacy";
  const first = c.bytes[c.at];
  if (first !== undefined && first & 0x80) {
    if ((c.u8() & 0x7f) !== 0) refuse("unsupported-version");
    version = 0;
  }
  const numRequiredSignatures = c.u8();
  const numReadonlySigned = c.u8();
  const numReadonlyUnsigned = c.u8();
  const keyCount = c.shortVec();
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i += 1) keys.push(keyDecoder.decode(c.take(32)));
  const blockhash = keyDecoder.decode(c.take(32));
  const instructionCount = c.shortVec();
  const instructions: CompiledInstruction[] = [];
  for (let i = 0; i < instructionCount; i += 1) {
    const programIndex = c.u8();
    const accounts = [...c.take(c.shortVec())];
    const data = c.take(c.shortVec());
    instructions.push({ programIndex, accounts, data });
  }
  let lookupCount = 0;
  if (version === 0) {
    lookupCount = c.shortVec();
    for (let i = 0; i < lookupCount; i += 1) {
      c.take(32);
      c.take(c.shortVec());
      c.take(c.shortVec());
    }
  }
  if (c.at !== wire.length) refuse("malformed");
  if (signatureCount !== numRequiredSignatures) refuse("malformed");
  if (numRequiredSignatures === 0 || numReadonlySigned >= numRequiredSignatures ||
      numRequiredSignatures + numReadonlyUnsigned > keyCount)
    refuse("malformed");
  return {
    version, signatureCount, signatures, signaturesStart, message: wire.subarray(messageStart), numRequiredSignatures, numReadonlySigned,
    numReadonlyUnsigned, keys, blockhash, instructions, lookupCount,
  };
}

const isWritable = (t: ParsedTransaction, i: number) =>
  i < t.numRequiredSignatures - t.numReadonlySigned ||
  (i >= t.numRequiredSignatures && i < t.keys.length - t.numReadonlyUnsigned);


// -------------------------------------------------------------------------------------------
// Addresses the claim must name
// -------------------------------------------------------------------------------------------

const utf8 = (s: string) => new TextEncoder().encode(s);
const pda = async (program: string, seeds: Uint8Array[]) =>
  (await getProgramDerivedAddress({ programAddress: program as Address, seeds }))[0] as string;
const keyBytes = (a: string) => new Uint8Array(keyEncoder.encode(a as Address));

export const candyGuardOf = (candyMachine: string) =>
  pda(CANDY_GUARD_PROGRAM, [utf8("candy_guard"), keyBytes(candyMachine)]);
export const candyMachineAuthorityOf = (candyMachine: string) =>
  pda(CANDY_MACHINE_PROGRAM, [utf8("candy_machine"), keyBytes(candyMachine)]);
/** The classic SPL Token associated account. */
export const associatedTokenOf = (owner: string, mint: string) =>
  pda(ASSOCIATED_TOKEN_PROGRAM, [keyBytes(owner), keyBytes(TOKEN_PROGRAM), keyBytes(mint)]);

// -------------------------------------------------------------------------------------------
// The check
// -------------------------------------------------------------------------------------------

export type ClaimPayment =
  | { kind: "free" }
  | { kind: "sol"; destination: string }
  | { kind: "token"; mint: string; amount: bigint; destinationAta: string };

export interface ClaimTransaction {
  /** The message bytes the co-signer signs. */
  message: Uint8Array;
  /** The new Core asset's address: how a later request sees whether the claim landed. */
  asset: string;
  blockhash: string;
  /** The candy guard and collection the mint names, checked against the chain afterwards. */
  candyGuard: string;
  collection: string;
  payment: ClaimPayment;
  /** The co-signer's signature slot, and where the signatures start in the wire bytes. */
  cosignerSlot: number;
  signaturesStart: number;
}

/** Whether `signature` is `signer`'s ed25519 signature of `message` (WebCrypto). */
async function verifies(signer: string, signature: Uint8Array | undefined, message: Uint8Array): Promise<boolean> {
  if (!signature || signature.every((b) => b === 0)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes(signer), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
  } catch {
    return false;
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const u32At = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(at, true);
const u64At = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);

/**
 * The transaction as a claim on `edition` by `wallet` co-signed by `cosigner`, in one of the
 * three shapes of the table, or a `Refused` naming the first rule it breaks. Nothing else is
 * ever signed. What depends on the edition's terms (price kind, destination, token mint and
 * amount, collection) is returned for `checkAgainstEdition` to hold to the chain.
 */
export async function checkClaimTransaction(
  wire: Uint8Array,
  expected: { wallet: string; edition: string; cosigner: string },
  walletAddedPrograms: readonly string[] = WALLET_ADDED_PROGRAMS_ALLOWED,
): Promise<ClaimTransaction> {
  const { wallet, edition, cosigner } = expected;
  if (wallet === cosigner) refuse("cosigner-is-wallet");
  const t = parseTransaction(wire);
  // First: the wallet signed exactly these message bytes (it signs before this Worker does).
  if (t.version !== 0) refuse("version");
  if (t.keys[0] !== wallet) refuse("fee-payer");
  if (!(await verifies(wallet, t.signatures[0], t.message))) refuse("wallet-signature");
  if (t.lookupCount !== 0) refuse("lookup-tables");
  if (new Set(t.keys).size !== t.keys.length) refuse("duplicate-accounts");

  // Every account is resolved through its instruction's indexes; no position in the message's
  // account list, and no canonical account order, is relied on.
  const all = t.instructions.map((ix) => {
    const program = t.keys[ix.programIndex];
    if (program === undefined || ix.accounts.some((i) => i >= t.keys.length)) refuse("malformed");
    return { program, keys: ix.accounts.map((i) => t.keys[i]), data: ix.data, accounts: ix.accounts };
  });
  // A durable nonce would keep the signature usable indefinitely: named, before anything else.
  if (all.some((ix) => ix.program === SYSTEM_PROGRAM && ix.data.length >= 4 && u32At(ix.data, 0) === LAYOUT.system.advanceNonce))
    refuse("durable-nonce");

  // ComputeBudget, wherever the wallet put it, capped.
  let limit: number | undefined;
  let price: bigint | undefined;
  for (const ix of all.filter((i) => i.program === COMPUTE_BUDGET_PROGRAM)) {
    const tag = ix.data[0];
    if (ix.accounts.length !== 0) refuse("compute-budget");
    if (tag === LAYOUT.computeBudget.setComputeUnitLimit && ix.data.length === 5 && limit === undefined) limit = u32At(ix.data, 1);
    else if (tag === LAYOUT.computeBudget.setComputeUnitPrice && ix.data.length === 9 && price === undefined) price = u64At(ix.data, 1);
    else refuse("compute-budget");
  }
  const others = all.filter((i) => i.program !== COMPUTE_BUDGET_PROGRAM).length;
  const units = BigInt(limit ?? Math.min(MAX_COMPUTE_UNIT_LIMIT, DEFAULT_UNITS_PER_INSTRUCTION * others));
  if (units > BigInt(MAX_COMPUTE_UNIT_LIMIT)) refuse("compute-budget");
  if (((price ?? 0n) * units + 999_999n) / 1_000_000n > MAX_PRIORITY_FEE_LAMPORTS) refuse("priority-fee-cap");

  // Instructions from an allowed wallet-added program are set aside (none are allowed today).
  const added = all.filter((i) => walletAddedPrograms.includes(i.program));
  const ixs = all.filter((i) => i.program !== COMPUTE_BUDGET_PROGRAM && !walletAddedPrograms.includes(i.program));

  const programs = ixs.map((ix) => ix.program).join(",");
  const S = SYSTEM_PROGRAM, G = CANDY_GUARD_PROGRAM, K = TOKEN_PROGRAM;
  const kind = programs === [S, G, S].join(",") ? "plain" : programs === [S, S, K, K, G, S, K].join(",") ? "token" : null;
  if (!kind) refuse(ixs.every((ix) => [S, G, K].includes(ix.program)) ? "wrong-instructions" : "wrong-program");
  /** The account at `position` of instruction `i` holds at least these flags in the message. */
  const flags = (i: number, position: number, want: "ws" | "w" | "rs") => {
    const index = ixs[i].accounts[position];
    if ((want !== "w" && index >= t.numRequiredSignatures) || (want !== "rs" && !isWritable(t, index))) refuse("account-flags");
  };
  const at = kind === "token"
    ? { transfer: 0, create: 1, init: 2, tokens: 3, mint: 4, allocate: 5, close: 6 }
    : { transfer: 0, mint: 1, allocate: 2 };
  const exact = (i: number, keys: string[]) =>
    ixs[i].keys.length === keys.length && ixs[i].keys.every((k, j) => k === keys[j]);

  // 0. The wallet funds the one-shot payer; nothing else is a SOL transfer.
  const transfer = ixs[at.transfer];
  if (transfer.data.length !== 12 || u32At(transfer.data, 0) !== LAYOUT.system.transfer || transfer.keys.length !== 2 ||
      transfer.keys[0] !== wallet)
    refuse("wrong-transfer");
  const payer = transfer.keys[1];

  // The mint.
  const mint = ixs[at.mint];
  const d = mint.data;
  if (d.length < LAYOUT.mintDataLength || LAYOUT.discriminator.some((b, i) => d[i] !== b)) refuse("not-mint");
  if (u32At(d, 8) !== 0) refuse("mint-args");
  if (d[12] !== 0) refuse("label-present");
  if (d.length !== LAYOUT.mintDataLength) refuse("not-mint");
  const A = LAYOUT.accounts;
  const key = (position: number) => mint.keys[position];
  const remaining = mint.keys.length - LAYOUT.fixedAccounts;
  const paymentKind = kind === "token" ? "token" : remaining === LAYOUT.remaining.sol ? "sol" : "free";
  if (remaining !== LAYOUT.remaining[paymentKind]) refuse("account-count");

  const candyGuard = await candyGuardOf(edition);
  if (key(A.candyMachine) !== edition) refuse("wrong-candy-machine");
  if (key(A.candyGuard) !== candyGuard) refuse("wrong-candy-guard");
  if (key(A.candyMachineProgram) !== CANDY_MACHINE_PROGRAM) refuse("wrong-account");
  if (key(A.candyMachineAuthority) !== (await candyMachineAuthorityOf(edition))) refuse("wrong-account");
  if (key(A.payer) !== payer) refuse("payer-not-funded");
  if (key(A.minter) !== wallet) refuse("minter-not-wallet");
  const owner = key(A.owner);
  if (owner !== CANDY_GUARD_PROGRAM && owner !== wallet) refuse("owner-not-wallet");
  if (key(A.mplCore) !== MPL_CORE || key(A.systemProgram) !== SYSTEM_PROGRAM ||
      key(A.sysvarInstructions) !== SYSVAR_INSTRUCTIONS || key(A.recentSlotHashes) !== SYSVAR_SLOT_HASHES)
    refuse("wrong-account");
  if (key(mint.keys.length - 1) !== cosigner) refuse("cosigner-position");
  const asset = key(A.asset);
  const collection = key(A.collection);

  // The payer ends with no balance to strand: allocated after the mint.
  const allocate = ixs[at.allocate];
  if (allocate.data.length !== 12 || u32At(allocate.data, 0) !== LAYOUT.system.allocate || !exact(at.allocate, [payer]))
    refuse("wrong-allocate");

  let payment: ClaimPayment = { kind: "free" };
  let temp: string | undefined;
  if (paymentKind === "sol") payment = { kind: "sol", destination: key(LAYOUT.fixedAccounts) };
  if (kind === "token") {
    const t0 = ixs[(at as { create: number }).create], t1 = ixs[(at as { init: number }).init];
    const t2 = ixs[(at as { tokens: number }).tokens], t3 = ixs[(at as { close: number }).close];
    // 1. The temporary account: a fresh signer the wallet funds, a token account of the Token program.
    temp = t0.keys[1];
    if (t0.data.length !== 52 || u32At(t0.data, 0) !== LAYOUT.system.createAccount ||
        u64At(t0.data, 12) !== BigInt(LAYOUT.tokenAccountBytes) || t0.keys.length !== 2 || t0.keys[0] !== wallet ||
        !sameBytes(t0.data.subarray(20), keyBytes(TOKEN_PROGRAM)))
      refuse("wrong-temporary-account");
    // 2. Initialized for the price's mint, owned by the wallet.
    if (t1.data.length !== 33 || t1.data[0] !== LAYOUT.token.initializeAccount3 || t1.keys.length !== 2 || t1.keys[0] !== temp ||
        keyDecoder.decode(t1.data.subarray(1)) !== wallet)
      refuse("wrong-temporary-account");
    const tokenMint = t1.keys[1];
    // 3. Tokens go only from the wallet's own associated account to the temporary account.
    if (t2.data.length !== 9 || t2.data[0] !== LAYOUT.token.transfer ||
        !exact((at as { tokens: number }).tokens, [await associatedTokenOf(wallet, tokenMint), temp, wallet]))
      refuse("wrong-token-transfer");
    // 6. Closed back to the wallet.
    if (t3.data.length !== 1 || t3.data[0] !== LAYOUT.token.closeAccount || !exact((at as { close: number }).close, [temp, wallet, wallet]))
      refuse("wrong-close");
    // The mint pays from the temporary account, through the classic Token program.
    const f = LAYOUT.fixedAccounts;
    if (key(f) !== temp || key(f + 2) !== TOKEN_PROGRAM) refuse("wrong-payment");
    payment = { kind: "token", mint: tokenMint, amount: u64At(t2.data, 1), destinationAta: key(f + 1) };
  }

  // Signers: exactly W, P, A, S (and T), all distinct, the fresh ones writable.
  const signers = [wallet, payer, asset, cosigner, ...(temp ? [temp] : [])];
  if (new Set(signers).size !== signers.length) refuse("signers");
  if (t.numRequiredSignatures !== LAYOUT.signers[paymentKind]) refuse("signers");
  const index = (k: string) => t.keys.indexOf(k);
  if (signers.some((k) => index(k) < 0 || index(k) >= t.numRequiredSignatures)) refuse("signers");
  for (const k of [payer, asset, ...(temp ? [temp] : [])])
    if (!isWritable(t, index(k))) refuse("signers");

  // The co-signer: a readonly signer, not the fee payer, named once in the whole transaction.
  const cosignerIndex = index(cosigner);
  if (cosignerIndex <= 0) refuse("cosigner-missing");
  if (isWritable(t, cosignerIndex)) refuse("cosigner-writable");
  const uses = (k: number) => t.instructions.reduce((sum, i) => sum + i.accounts.filter((a) => a === k).length, 0);
  if (uses(cosignerIndex) !== 1) refuse("cosigner-position");
  // The one-shot payer only where the table puts it: funded, paying, allocated.
  if (uses(index(payer)) !== 3) refuse("payer-elsewhere");

  // Signer and writable flags of every account the table names, as resolved.
  flags(at.transfer, 0, "ws"); flags(at.transfer, 1, "w");
  for (const p of [A.candyMachine, A.candyMachineAuthority, A.collection]) flags(at.mint, p, "w");
  for (const p of [A.payer, A.minter, A.asset]) flags(at.mint, p, "ws");
  for (let p = LAYOUT.fixedAccounts; p < mint.keys.length - 1; p += 1) if (key(p) !== TOKEN_PROGRAM) flags(at.mint, p, "w");
  flags(at.mint, mint.keys.length - 1, "rs");
  flags(at.allocate, 0, "ws");
  if (kind === "token") {
    const k = at as { create: number; init: number; tokens: number; close: number };
    flags(k.create, 0, "ws"); flags(k.create, 1, "ws"); flags(k.init, 0, "w");
    flags(k.tokens, 0, "w"); flags(k.tokens, 1, "w"); flags(k.tokens, 2, "rs");
    flags(k.close, 0, "w"); flags(k.close, 1, "w"); flags(k.close, 2, "rs");
  }

  return {
    message: t.message, asset, blockhash: t.blockhash, candyGuard, collection, payment,
    cosignerSlot: cosignerIndex, signaturesStart: t.signaturesStart,
  };
}
