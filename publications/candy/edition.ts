/**
 * A numbered edition on Metaplex's Core Candy Machine, with no program of this app's own.
 *
 *   collection     Core collection: MasterEdition(max N) + Royalties, both authority None; after
 *                  publishing its update authority is `NO_AUTHORITY`. The candy machine's
 *                  authority PDA stays its update delegate, which is what lets copies mint.
 *   candy machine  hidden settings: copy n is named `Title #n` (n = items redeemed + 1) with the
 *                  one shared URI; `hash` holds the image's sha256. Authority: `NO_AUTHORITY`.
 *   candy guard    PDA of the candy machine's key, no groups; the publisher is its authority
 *                  (the only power left with them: the price, and closing).
 *     open         Mint Limit (id 0, 1 per wallet) + Edition [+ Sol Payment | Token Payment]
 *     Seeker-only  Third Party Signer (the server) + Edition [+ payment]; no Mint Limit: the
 *                  server enforces one copy per Genesis Token.
 *
 * Publishing is two transactions (`publishTransactions`). A reader accepts an edition only when
 * every account is exactly what this file would have written (`readEdition`), and a claim is
 * built only from that verdict.
 */

import {
  createNoopSigner, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress,
  type Address, type Instruction, type KeyPairSigner,
} from "@solana/kit";
import { encodeGuardData, type GuardData, type GuardSet } from "./guards";
import type { Draft } from "./transactions";
import {
  CANDY_GUARD_HEADER,
  CANDY_GUARD_PROGRAM,
  CANDY_MACHINE_HIDDEN_BYTES,
  CANDY_MACHINE_PROGRAM,
  MAX_ACCOUNT_BYTES,
  MAX_NAME_LENGTH,
  MAX_URI_LENGTH,
  MINT_COUNTER_BYTES,
  MPL_CORE,
  SYSTEM_PROGRAM,
  TOKEN_ACCOUNT_BYTES,
  TOKEN_PROGRAM,
  allocateInstruction,
  associatedTokenAddress,
  candyGuardAddress,
  candyMachineAuthorityPda,
  closeTokenAccountInstruction,
  createAccountInstruction,
  createCollectionInstruction,
  createTokenAccountInstruction,
  decodeCandyGuard,
  decodeCandyMachine,
  initializeCandyGuardInstruction,
  initializeCandyMachineInstruction,
  initializeTokenAccountInstruction,
  mintCounterAddress,
  mintInstruction,
  setCandyMachineAuthorityInstruction,
  transferSolInstruction,
  transferTokensInstruction,
  updateCandyGuardInstruction,
  updateCollectionInstruction,
  withdrawCandyGuardInstruction,
  wrapInstruction,
} from "./programs";

export { createTokenAccountInstruction };

/**
 * The key both the candy machine's authority and the collection's update authority are handed
 * to: the System Program's derived address for ["signshot", "no authority"] (bump 253). A derived
 * address lies off the ed25519 curve, so no private key exists for it, and only the deriving
 * program could sign for it by CPI; the System Program never makes one. `noAuthorityAddress()`
 * re-derives it.
 */
export const NO_AUTHORITY = "864BTg5dsR5DtBxPHm8uiU9GnRWL5V94AneqsnLRxgg8" as Address;
export const noAuthorityAddress = async () =>
  (await getProgramDerivedAddress({ programAddress: SYSTEM_PROGRAM, seeds: [utf8("signshot"), utf8("no authority")] }))[0];

export const MINT_LIMIT_ID = 0;
export const MAX_SUPPLY = 1000;
/** The app's title limit; with " #1001" the longest name is 30 of the candy machine's 32 bytes. */
export const MAX_TITLE_BYTES = 24;
export const NAME_PATTERN = "$ID+1$";
/** Core's flat fee on every asset it creates (`mpl-core` `state/collect.rs` CREATE_FEE). */
export const CORE_CREATE_FEE = 1_500_000n;
/** The base fee per signature. */
export const SIGNATURE_FEE = 5_000n;

const utf8 = (s: string) => new TextEncoder().encode(s);

export type Price =
  | { kind: "free" }
  | { kind: "sol"; lamports: bigint }
  /** `tokenProgram` is the mint account's owner; only classic SPL Token (SKR is one) is accepted. */
  | { kind: "token"; mint: Address; amount: bigint; tokenProgram: Address };

export interface EditionTerms {
  title: string;
  /** The one metadata URI every copy carries. */
  uri: string;
  /** 32 bytes, kept in the candy machine's hidden-settings hash. */
  imageSha256: Uint8Array;
  supply: number;
  royaltyBasisPoints: number;
  price: Price;
  /** The server key whose co-signature a claim needs (Seeker holders only), or null. */
  cosigner: Address | null;
}

function checkPrice(price: Price) {
  if (price.kind === "sol" && !(price.lamports > 0n)) throw new Error("A SOL price is above zero");
  if (price.kind === "token") {
    if (price.tokenProgram !== TOKEN_PROGRAM) throw new Error("Only a classic SPL Token mint can be a price (the guard refuses Token-2022)");
    if (!(price.amount > 0n)) throw new Error("A token price is above zero");
  }
}

export function checkTerms(t: EditionTerms) {
  const bytes = (s: string) => utf8(s).length;
  if (!Number.isInteger(t.supply) || t.supply < 1 || t.supply > MAX_SUPPLY) throw new Error(`Supply is 1 to ${MAX_SUPPLY}`);
  if (bytes(t.title) === 0 || bytes(t.title) > MAX_TITLE_BYTES) throw new Error(`A title is 1 to ${MAX_TITLE_BYTES} bytes`);
  // The candy machine substitutes these in every copy's name.
  if (t.title.includes("$ID$") || t.title.includes("$ID+1$")) throw new Error("A title cannot contain $ID$ or $ID+1$");
  if (bytes(`${t.title} #${t.supply + 1}`) > MAX_NAME_LENGTH) throw new Error("Title too long");
  if (bytes(t.uri) === 0 || bytes(t.uri) > MAX_URI_LENGTH) throw new Error(`A URI is 1 to ${MAX_URI_LENGTH} bytes`);
  if (t.imageSha256.length !== 32) throw new Error("Image hash is 32 bytes");
  if (!Number.isInteger(t.royaltyBasisPoints) || t.royaltyBasisPoints < 0 || t.royaltyBasisPoints > 10_000) throw new Error("Royalty out of range");
  checkPrice(t.price);
}

/** The only guard sets this app writes after publishing. */
export async function editionGuards(publisher: Address, price: Price, cosigner: Address | null): Promise<GuardData> {
  checkPrice(price);
  const set: GuardSet = {};
  if (price.kind === "sol") set.solPayment = { lamports: price.lamports, destination: publisher };
  if (price.kind === "token")
    set.tokenPayment = { amount: price.amount, mint: price.mint, destinationAta: await associatedTokenAddress(publisher, price.mint) };
  if (cosigner) set.thirdPartySigner = { signerKey: cosigner };
  else set.mintLimit = { id: MINT_LIMIT_ID, limit: 1 };
  set.edition = { editionStartOffset: 0 };
  return { default: set, groups: [] };
}

/** The guard copy 1 is minted under: Edition only, so the publisher opens no counter. */
const COPY_ONE_GUARDS: GuardData = { default: { edition: { editionStartOffset: 0 } }, groups: [] };

export interface PublishInput {
  /** The wallet's address: it pays, and signs first (see `transactions.ts`). */
  publisher: Address;
  /** Fresh keypairs the phone generates: the collection, the candy machine (also the guard's base), copy 1. */
  collection: KeyPairSigner;
  candyMachine: KeyPairSigner;
  copy: KeyPairSigner;
  terms: EditionTerms;
  /** Rent for `CANDY_MACHINE_HIDDEN_BYTES` (getMinimumBalanceForRentExemption). */
  candyMachineRent: bigint;
}

/**
 * Two transactions, in order (the second fails unless the first has landed):
 *   1. Core CreateCollectionV1; System CreateAccount (candy machine); candy machine `initialize`
 *      (the publisher is authority and, until wrapped, sole mint authority).
 *   2. [the publisher's token account, for a token price]; guard `initialize` with Edition only;
 *      `wrap`; `mint_v1` copy 1 to the publisher; guard `update` to the edition's set; candy
 *      machine authority and collection update authority both to `NO_AUTHORITY`. Atomic: nobody
 *      can mint before copy 1, and no edition ever exists unlocked.
 *      (No VerifiedCreators plugin: on a collection, Core checks it on every asset created into
 *      the collection, and the candy machine's authority is not the creator, so every claim
 *      would fail with "Verified creators: Rejected".)
 * Signers: the wallet on both; collection + candy machine on 1; candy machine + copy on 2.
 */
export async function publishTransactions(input: PublishInput) {
  const { collection, candyMachine, copy, terms } = input;
  const publisher = createNoopSigner(input.publisher);
  checkTerms(terms);
  const authorityPda = await candyMachineAuthorityPda(candyMachine.address);
  const candyGuard = await candyGuardAddress(candyMachine.address);
  const guards = await editionGuards(publisher.address, terms.price, terms.cosigner);
  const first: Instruction[] = [
    createCollectionInstruction({
      collection, updateAuthority: publisher.address, payer: publisher,
      terms: {
        name: terms.title, uri: terms.uri, maxSupply: terms.supply, royaltyBasisPoints: terms.royaltyBasisPoints,
        creators: [{ address: publisher.address, percentage: 100 }], pluginAuthority: { kind: "None" },
      },
    }),
    createAccountInstruction(publisher, candyMachine, input.candyMachineRent, CANDY_MACHINE_HIDDEN_BYTES, CANDY_MACHINE_PROGRAM),
    await initializeCandyMachineInstruction({
      candyMachine: candyMachine.address, authority: publisher.address, payer: publisher,
      collection: collection.address, collectionUpdateAuthority: publisher,
      data: {
        itemsAvailable: BigInt(terms.supply), maxSupply: 0n, isMutable: true,
        hidden: { name: `${terms.title} #${NAME_PATTERN}`, uri: terms.uri, hash: terms.imageSha256 },
      },
    }),
  ];
  const second: Instruction[] = [
    ...(terms.price.kind === "token" ? [await createTokenAccountInstruction(publisher, publisher.address, terms.price.mint)] : []),
    await initializeCandyGuardInstruction({ base: candyMachine, authority: publisher.address, payer: publisher, guards: COPY_ONE_GUARDS }),
    wrapInstruction({ candyGuard, guardAuthority: publisher, candyMachine: candyMachine.address, candyMachineAuthority: publisher }),
    await mintInstruction({
      candyMachine: candyMachine.address, candyGuard, collection: collection.address, guards: COPY_ONE_GUARDS,
      payer: publisher, minter: publisher, asset: copy,
    }),
    updateCandyGuardInstruction({ candyGuard, authority: publisher, payer: publisher, guards }),
    setCandyMachineAuthorityInstruction({ candyMachine: candyMachine.address, authority: publisher, newAuthority: NO_AUTHORITY }),
    updateCollectionInstruction({ collection: collection.address, authority: publisher, payer: publisher, newUpdateAuthority: NO_AUTHORITY }),
  ];
  const draft: Draft = {
    feePayer: input.publisher,
    transactions: [
      { instructions: first, localSigners: [collection, candyMachine] },
      { instructions: second, localSigners: [candyMachine, copy] },
    ],
  };
  return { draft, candyGuard, authorityPda, guards };
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** An account as an RPC returns it; `null` when it does not exist. */
export interface AccountView { address: Address; owner: Address; lamports: bigint; bytes: Uint8Array }

export interface Edition {
  ok: true;
  candyMachine: Address;
  candyGuard: Address;
  collection: Address;
  /**
   * The publisher: one key that (a) is the collection's only royalty creator, (b) receives every
   * payment, and (c) alone can change the price or close the sale (the guard's authority). It
   * proves those three are the same key. It does NOT prove that key signed the publish: anyone can
   * publish an edition naming someone else as creator, payee and guard authority (that someone
   * then gets the money and the controls, but the photograph and title are the real signer's).
   * Nor does it prove who holds the key or that the photograph is theirs. A later `set_authority`
   * hands the guard on, and the edition then stops reading.
   */
  publisher: Address;
  royaltyBasisPoints: number;
  minted: number;
  supply: number;
  soldOut: boolean;
  price: Price;
  /** The server key a claim needs, or null on an open edition. */
  cosigner: Address | null;
  /** Open editions: one copy per wallet, counted on chain. Seeker-only: the server counts. */
  onePerWallet: boolean;
  title: string;
  /** The next copy's name and the shared URI. */
  nextName: string;
  uri: string;
  imageSha256: Uint8Array;
  guards: GuardData;
}
export type EditionVerdict = Edition | { ok: false; reason: string };

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const keyBytes = (a: Address) => new Uint8Array(getAddressEncoder().encode(a));
const le32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const le16 = (n: number) => new Uint8Array([n & 255, n >>> 8]);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** Core `Authority` in a registry record. */
type RecordAuthority = "None" | "Owner" | "UpdateAuthority" | Address;

/**
 * A Core `CollectionV1` read to the last byte: key 5, update authority, name, uri, num_minted,
 * current_size, then `PluginHeaderV1` (key 3, registry offset) and `PluginRegistryV1` (key 4,
 * records of {plugin type, authority, offset}, external records), which must end the account.
 */
function readCollection(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n: number) => { if (at + n > bytes.length) throw new Error("truncated collection"); const was = at; at += n; return was; };
  const key = () => { const was = need(32); return getAddressDecoder().decode(bytes.subarray(was, was + 32)); };
  const text = () => { const n = view.getUint32(need(4), true); const was = need(n); return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(was, was + n)); };
  if (bytes[need(1)] !== 5) throw new Error("not a Core collection");
  const updateAuthority = key();
  const name = text();
  const uri = text();
  const numMinted = view.getUint32(need(4), true);
  need(4); // current_size
  if (bytes[need(1)] !== 3) throw new Error("no plugin header");
  at = Number(view.getBigUint64(need(8), true));
  if (bytes[need(1)] !== 4) throw new Error("no plugin registry");
  const count = view.getUint32(need(4), true);
  const records: { type: number; authority: RecordAuthority; offset: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const type = bytes[need(1)];
    const tag = bytes[need(1)];
    let authority: RecordAuthority;
    if (tag === 0) authority = "None";
    else if (tag === 1) authority = "Owner";
    else if (tag === 2) authority = "UpdateAuthority";
    else if (tag === 3) authority = key();
    else throw new Error("bad plugin authority");
    records.push({ type, authority, offset: Number(view.getBigUint64(need(8), true)) });
  }
  const external = view.getUint32(need(4), true);
  if (at !== bytes.length) throw new Error("bytes after the plugin registry");
  return { updateAuthority, name, uri, numMinted, records, external };
}

/**
 * The edition, only if all three accounts are exactly what this file leaves after publishing
 * (and after `setPriceDraft`), field by field:
 *   candy machine: this program's, 652 bytes, authority NO_AUTHORITY, the guard as mint authority,
 *     hidden settings `<title> #$ID+1$` (title 1-24 bytes, no `$ID`), a 1-200 byte URI, no config
 *     lines, max_supply 0, mutable, 1-1000 available, zeros after the data;
 *   guard: the PDA of the candy machine, its data re-encoding byte for byte from this app's set for
 *     its price and co-signer, every payment going to its authority;
 *   collection: update authority NO_AUTHORITY, name = title, uri = the hidden URI, num_minted =
 *     items redeemed (no copy minted around the candy machine), and exactly three plugins and no
 *     external adapters: MasterEdition(max = available) None, Royalties(creators [authority 100%],
 *     RuleSet None) None, UpdateDelegate([candy machine authority PDA]) UpdateAuthority.
 * Anything else is refused with a reason, and nothing here builds a claim from it.
 */
export async function readEdition(accounts: {
  candyMachine: AccountView | null; candyGuard: AccountView | null; collection: AccountView | null;
}): Promise<EditionVerdict> {
  const { candyMachine, candyGuard, collection } = accounts;
  if (!candyMachine || !collection) return { ok: false, reason: "No such edition" };
  if (!candyGuard) return { ok: false, reason: "This edition is closed" };
  const no = (why: string): EditionVerdict => ({ ok: false, reason: `Not a Signshot edition (${why})` });
  try {
    if (candyMachine.owner !== CANDY_MACHINE_PROGRAM || candyGuard.owner !== CANDY_GUARD_PROGRAM || collection.owner !== MPL_CORE) return no("account owners");
    // Candy machine.
    if (candyMachine.bytes.length !== CANDY_MACHINE_HIDDEN_BYTES) return no("candy machine size");
    const machine = decodeCandyMachine(candyMachine.bytes);
    if (machine.mintAuthority !== candyGuard.address) return { ok: false, reason: "This edition is not open (the guard is detached)" };
    if (machine.authority !== NO_AUTHORITY) return no("candy machine authority");
    if (machine.collection !== collection.address) return no("collection");
    const { itemsAvailable, maxSupply, isMutable, hidden } = machine.data;
    if (itemsAvailable < 1n || itemsAvailable > BigInt(MAX_SUPPLY) || machine.itemsRedeemed > itemsAvailable) return no("supply");
    if (maxSupply !== 0n || !isMutable) return no("candy machine data");
    const suffix = ` #${NAME_PATTERN}`;
    if (!hidden.name.endsWith(suffix)) return no("name");
    const title = hidden.name.slice(0, -suffix.length);
    const titleBytes = utf8(title).length;
    if (titleBytes < 1 || titleBytes > MAX_TITLE_BYTES || title.includes("$ID")) return no("title");
    if (utf8(hidden.uri).length < 1 || utf8(hidden.uri).length > MAX_URI_LENGTH) return no("uri");
    // CandyMachine (state/candy_machine.rs): discriminator, authority, mint_authority, collection_mint,
    // items_redeemed (u64); CandyMachineData: items_available, max_supply (u64 each), is_mutable,
    // config_line_settings None, hidden_settings Some { name, uri, hash }. Three u64s in all.
    const used = 8 + 32 * 3 + 8 * 3 + 1 + 1 + 1 + 4 + utf8(hidden.name).length + 4 + utf8(hidden.uri).length + 32;
    if (candyMachine.bytes.subarray(used).some((b) => b !== 0)) return no("candy machine padding");

    // Guard.
    if (candyGuard.address !== (await candyGuardAddress(candyMachine.address))) return no("guard address");
    const guard = decodeCandyGuard(candyGuard.bytes);
    if (guard.base !== candyMachine.address) return no("guard base");
    const publisher = guard.authority;
    const set = guard.guards.default;
    const price: Price = set.solPayment ? { kind: "sol", lamports: set.solPayment.lamports }
      : set.tokenPayment ? { kind: "token", mint: set.tokenPayment.mint, amount: set.tokenPayment.amount, tokenProgram: TOKEN_PROGRAM }
      : { kind: "free" };
    const cosigner = set.thirdPartySigner?.signerKey ?? null;
    // Re-encoding from `publisher` also pins the SOL destination, and the token destination's owner, to it.
    const expected = encodeGuardData(await editionGuards(publisher, price, cosigner));
    if (!sameBytes(candyGuard.bytes.subarray(CANDY_GUARD_HEADER), expected)) return { ok: false, reason: "This edition's terms are not ones this app sets" };

    // Collection.
    const c = readCollection(collection.bytes);
    if (c.updateAuthority !== NO_AUTHORITY) return no("collection authority");
    if (c.name !== title || c.uri !== hidden.uri) return no("collection name or uri");
    if (BigInt(c.numMinted) !== machine.itemsRedeemed) return no("copies minted outside the candy machine");
    if (c.external !== 0) return no("collection external plugins");
    if (c.records.length !== 3 || new Set(c.records.map((r) => r.type)).size !== 3) return no("collection plugins");
    const royalty = c.records.find((r) => r.type === 0);
    if (!royalty) return no("royalties");
    const bps = collection.bytes[royalty.offset + 1] | (collection.bytes[royalty.offset + 2] << 8);
    if (bps > 10_000) return no("royalties");
    const authorityPda = await candyMachineAuthorityPda(candyMachine.address);
    const plugins: Record<number, { authority: RecordAuthority; bytes: Uint8Array }> = {
      10: { authority: "None", bytes: join(new Uint8Array([10, 1]), le32(Number(itemsAvailable)), new Uint8Array([0, 0])) },
      0: { authority: "None", bytes: join(new Uint8Array([0]), le16(bps), le32(1), keyBytes(publisher), new Uint8Array([100, 0])) },
      4: { authority: "UpdateAuthority", bytes: join(new Uint8Array([4]), le32(1), keyBytes(authorityPda)) },
    };
    for (const r of c.records) {
      const want = plugins[r.type];
      if (!want || r.authority !== want.authority || !sameBytes(collection.bytes.subarray(r.offset, r.offset + want.bytes.length), want.bytes))
        return no(`collection plugin ${r.type}`);
    }

    const minted = Number(machine.itemsRedeemed);
    return {
      ok: true, candyMachine: candyMachine.address, candyGuard: candyGuard.address, collection: collection.address,
      publisher, royaltyBasisPoints: bps, minted, supply: Number(itemsAvailable),
      soldOut: machine.itemsRedeemed >= itemsAvailable,
      price, cosigner, onePerWallet: cosigner === null, title,
      nextName: `${title} #${minted + 1}`, uri: hidden.uri, imageSha256: hidden.hash, guards: guard.guards,
    };
  } catch (error) {
    return no((error as Error).message);
  }
}

/** The wallet's mint-limit counter on an open edition. */
export const counterAddress = (edition: Edition, wallet: Address) =>
  mintCounterAddress(MINT_LIMIT_ID, wallet, edition.candyGuard, edition.candyMachine);

export type ClaimStatus =
  /** Open edition, this wallet has its copy. */
  | "claimed"
  | "unclaimed"
  /**
   * Something else sits at the counter's address (lamports someone sent there, any other owner
   * or size): the guard cannot create the counter, so this wallet can never claim this edition.
   */
  | "blocked"
  /** Seeker-only: the server decides, one copy per Genesis Token. */
  | "server";

/** Whether `counter` (the account at `counterAddress`, or null) lets this wallet claim. */
export function claimStatus(edition: Edition, counter: AccountView | null): ClaimStatus {
  if (!edition.onePerWallet) return "server";
  if (!counter || counter.lamports === 0n) return "unclaimed";
  if (counter.owner !== CANDY_GUARD_PROGRAM || counter.bytes.length !== MINT_COUNTER_BYTES) return "blocked";
  return (counter.bytes[0] | (counter.bytes[1] << 8)) >= 1 ? "claimed" : "unclaimed";
}

// ---------------------------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------------------------

/** A copy's Core account: key, owner, update authority (kind + key), name, uri, seq None, then the Edition plugin's header, registry and data. */
export const copyBytes = (name: string, uri: string) => 108 + utf8(name).length + utf8(uri).length;

export interface ClaimCost {
  /** The SOL price (0 unless priced in SOL). */
  price: bigint;
  /** Token units, for a token price. */
  tokens: bigint;
  /** The copy's lamports: rent for its size plus Core's create fee. */
  copy: bigint;
  /** The counter's rent (open editions). */
  counter: bigint;
  /** Exactly what the one-shot payer is funded with: price + copy + counter. */
  payerFunding: bigint;
  /**
   * Bytes the one-shot payer is allocated after `mint_v1`: enough that its rent exceeds
   * `payerFunding`, so any balance left (a lowered price) fails the transaction instead of
   * stranding lamports under a key nobody keeps. Null when no account can be that large.
   */
  payerSpace: number | null;
  /** The temporary token account's rent: paid and returned within the transaction. */
  tokenAccountRent: bigint;
  signatures: number;
  /** Base fees (no priority fee). */
  fees: bigint;
  /** What leaves the wallet: payer funding + fees. */
  total: bigint;
  /** The most the wallet must hold mid-transaction. */
  peak: bigint;
}

/**
 * The one set of amounts the review screen shows and the claim transaction moves. `rent` answers
 * getMinimumBalanceForRentExemption.
 */
export async function claimCost(edition: Edition, rent: (bytes: number) => bigint | Promise<bigint>): Promise<ClaimCost> {
  const price = edition.price.kind === "sol" ? edition.price.lamports : 0n;
  const tokens = edition.price.kind === "token" ? edition.price.amount : 0n;
  const copy = (await rent(copyBytes(edition.nextName, edition.uri))) + CORE_CREATE_FEE;
  const counter = edition.onePerWallet ? await rent(MINT_COUNTER_BYTES) : 0n;
  const tokenAccountRent = edition.price.kind === "token" ? await rent(TOKEN_ACCOUNT_BYTES) : 0n;
  const payerFunding = price + copy + counter;
  // Rent is linear in size: the smallest space whose rent is above the funding.
  const floor = await rent(0);
  const perByte = (await rent(1)) - floor;
  let payerSpace: number | null = payerFunding < floor ? 0 : Number((payerFunding - floor) / perByte) + 1;
  while (payerSpace !== null && payerSpace <= MAX_ACCOUNT_BYTES && (await rent(payerSpace)) <= payerFunding) payerSpace += 1;
  if (payerSpace !== null && payerSpace > MAX_ACCOUNT_BYTES) payerSpace = null;
  // wallet, copy, one-shot payer [, temporary token account] [, server]
  const signatures = 3 + (edition.price.kind === "token" ? 1 : 0) + (edition.cosigner ? 1 : 0);
  const fees = BigInt(signatures) * SIGNATURE_FEE;
  return { price, tokens, copy, counter, payerFunding, payerSpace, tokenAccountRent, signatures, fees, total: payerFunding + fees, peak: payerFunding + fees + tokenAccountRent };
}

/**
 * Whether a wallet holding `lamports` can pay `cost`: it must cover the peak, and what remains
 * must be zero or at least the rent floor (`rentFloor` = rent for 0 bytes), or the runtime
 * refuses the transaction (InsufficientFundsForRent) however small the shortfall.
 */
export function canAfford(lamports: bigint, cost: ClaimCost, rentFloor: bigint) {
  if (lamports < cost.peak) return false;
  const left = lamports - cost.total;
  return left === 0n || left >= rentFloor;
}

export interface ClaimInput {
  edition: EditionVerdict;
  /** The account at `counterAddress` (open editions), or null. */
  counter: AccountView | null;
  /** From `claimCost`, as shown on the review screen. */
  cost: ClaimCost;
  /** The wallet's address: it pays the fee and signs first. */
  collector: Address;
  /** Fresh keypairs: the copy; the one-shot payer; for a token price, the temporary token account. */
  asset: KeyPairSigner;
  payer: KeyPairSigner;
  tokenAccount?: KeyPairSigner;
}

/**
 * One claim at exactly the reviewed terms, as a one-transaction draft:
 *   transfer `payerFunding` to a one-shot payer that pays the price, the counter and the copy in
 *   `mint_v1` and must end at zero; it is then allocated `payerSpace` bytes, so any balance left
 *   is below its rent. A raised SOL price fails (6018, or System 1 inside the guard when the rise
 *   is smaller than the copy and counter); a lowered one leaves a balance and fails
 *   (InsufficientFundsForRent). Nothing is swept back: a System transfer needs its amount when the
 *   transaction is signed, so failing is the only safe answer to a lowered price.
 *   Token price: a temporary token account is created, funded with exactly the reviewed amount,
 *   pays in `mint_v1` and is closed back to the wallet. A raised price fails (6020), a lowered one
 *   leaves tokens and the close fails.
 * A Seeker-only claim names the server's key as a signer; the server signs after `finish`.
 * Refuses (throws) for anything `readEdition` did not accept, a sold-out edition, or a wallet that
 * has claimed or is blocked.
 */
export async function claimDraft(input: ClaimInput): Promise<Draft> {
  const e = input.edition;
  if (!e.ok) throw new Error(e.reason);
  if (e.soldOut) throw new Error("Sold out");
  const status = claimStatus(e, input.counter);
  if (status === "claimed") throw new Error("This wallet has its copy");
  if (status === "blocked") throw new Error("This wallet cannot claim this edition: its claim record's address is taken");
  const { payer, cost } = input;
  const collector = createNoopSigner(input.collector);
  if (cost.payerSpace === null) throw new Error("This price is too high to claim safely");
  const out: Instruction[] = [transferSolInstruction(collector, payer.address, cost.payerFunding)];
  let paymentSource: Address | undefined;
  if (e.price.kind === "token") {
    const temp = input.tokenAccount;
    if (!temp) throw new Error("A token price needs a temporary token account");
    out.push(
      createAccountInstruction(collector, temp, cost.tokenAccountRent, TOKEN_ACCOUNT_BYTES, TOKEN_PROGRAM),
      initializeTokenAccountInstruction(temp.address, e.price.mint, collector.address),
      transferTokensInstruction(await associatedTokenAddress(collector.address, e.price.mint), temp.address, collector, cost.tokens),
    );
    paymentSource = temp.address;
  }
  out.push(await mintInstruction({
    candyMachine: e.candyMachine, candyGuard: e.candyGuard, collection: e.collection, guards: e.guards,
    payer, minter: collector, asset: input.asset, cosigner: e.cosigner ? createNoopSigner(e.cosigner) : undefined, paymentSource,
  }));
  out.push(allocateInstruction(payer, cost.payerSpace));
  if (input.tokenAccount) out.push(closeTokenAccountInstruction(input.tokenAccount.address, collector.address, collector));
  return {
    feePayer: input.collector,
    transactions: [{ instructions: out, localSigners: [input.asset, payer, ...(input.tokenAccount ? [input.tokenAccount] : [])] }],
  };
}

export type ClaimFailure =
  | "not-enough-sol" | "not-enough-tokens" | "tokens-frozen" | "terms-changed" | "sold-out" | "already-claimed"
  | "needs-cosigner" | "closed" | "publisher-cannot-receive" | "other";

/**
 * One reason for a failed claim, from the transaction error, its logs and the account keys of the
 * message as sent (static accounts in order, after any wallet reordering). For `claimDraft`
 * transactions, where the one-shot payer and the temporary token account hold exactly the
 * reviewed amounts, so any shortfall inside the guard means the terms moved.
 */
export function classifyClaimFailure(failure: { err: string; custom?: { code: number } | null; logs: string[] },
  context: { accountKeys: readonly Address[]; wallet: Address; payer: Address }): ClaimFailure {
  const rent = /InsufficientFundsForRent \{ account_index: (\d+) \}/.exec(failure.err);
  if (rent) {
    const key = context.accountKeys[Number(rent[1])];
    return key === context.wallet ? "not-enough-sol" : key === context.payer ? "terms-changed" : "other";
  }
  if (/InsufficientFundsForFee/.test(failure.err)) return "not-enough-sol";
  // The top-level program that failed: the last depth-1 invoke in the logs.
  const top = [...failure.logs].reverse().map((l) => /^Program (\w+) invoke \[1\]$/.exec(l)?.[1]).find(Boolean);
  const code = failure.custom?.code;
  if (top === SYSTEM_PROGRAM && code === 1) return "not-enough-sol";
  if (top === TOKEN_PROGRAM) return code === 1 ? "not-enough-tokens" : code === 17 ? "tokens-frozen" : code === 11 ? "terms-changed" : "other";
  if (top === CANDY_GUARD_PROGRAM) {
    const said = (pattern: RegExp) => failure.logs.some((l) => pattern.test(l));
    if (code === 3012) return "closed";
    // 6006 is both the candy machine's CandyMachineEmpty and the guard's MissingRemainingAccount:
    // only the log tells them apart, and without it nothing is claimed.
    if (code === 6006) return said(/CandyMachineEmpty/) ? "sold-out" : said(/MissingRemainingAccount/) ? "terms-changed" : "other";
    // NotEnoughSOL, NotEnoughTokens, shifted accounts: the price moved.
    if (code === 6018 || code === 6020 || code === 6002) return "terms-changed";
    // The one-shot payer short for the copy or the counter (a small rise, or the copy's number
    // gaining a digit): System 1 with its own log line, not another program's error 1.
    if (code === 1 && said(/Transfer: insufficient lamports|insufficient lamports/)) return "terms-changed";
    if (code === 6029) return "already-claimed";
    if (code === 6022) return "needs-cosigner";
    // The publisher's token account frozen (SPL Token 17, logged by Token) or closed (not a token
    // account any more).
    if (code === 17 && said(/Account is frozen/)) return "publisher-cannot-receive";
    if (/InvalidAccountData/.test(failure.err)) return "publisher-cannot-receive";
  }
  return "other";
}

// ---------------------------------------------------------------------------------------------
// The publisher, after publishing
// ---------------------------------------------------------------------------------------------

/** A new price (or free), keeping the edition's kind (open or Seeker-only). */
export async function setPriceDraft(input: { publisher: Address; edition: Pick<Edition, "candyGuard" | "cosigner">; price: Price }): Promise<Draft> {
  const publisher = createNoopSigner(input.publisher);
  const guards = await editionGuards(input.publisher, input.price, input.edition.cosigner);
  return {
    feePayer: input.publisher,
    transactions: [{ instructions: [
      ...(input.price.kind === "token" ? [await createTokenAccountInstruction(publisher, input.publisher, input.price.mint)] : []),
      updateCandyGuardInstruction({ candyGuard: input.edition.candyGuard, authority: publisher, payer: publisher, guards }),
    ], localSigners: [] }],
  };
}

/**
 * Closing ends the sale: the guard is withdrawn and its rent returns to the publisher. The
 * candy machine's rent cannot be recovered (its authority is `NO_AUTHORITY`); the collection,
 * copies and counters stay.
 */
export const closeDraft = (input: { publisher: Address; candyGuard: Address }): Draft => ({
  feePayer: input.publisher,
  transactions: [{ instructions: [withdrawCandyGuardInstruction({ candyGuard: input.candyGuard, authority: createNoopSigner(input.publisher) })], localSigners: [] }],
});

// ---------------------------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------------------------

/** A copy as the edition reader needs it: its address, name and Edition plugin number (null: none). */
export interface CopyView { address: Address; name: string; edition: number | null }

/**
 * A Core `AssetV1` of `collection` read as a copy, or null when it is not one: key 1, owner,
 * update authority Collection(collection), name, uri, seq, then the plugin registry, whose
 * Edition plugin (type 9) gives the number.
 */
export function readCopy(account: AccountView, collection: Address): CopyView | null {
  try {
    const bytes = account.bytes;
    if (account.owner !== MPL_CORE || bytes[0] !== 1) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decode = getAddressDecoder();
    if (bytes[33] !== 2 || decode.decode(bytes.subarray(34, 66)) !== collection) return null;
    let at = 66;
    const nameLength = view.getUint32(at, true);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at + 4, at + 4 + nameLength));
    at += 4 + nameLength;
    at += 4 + view.getUint32(at, true); // uri
    at += bytes[at] ? 9 : 1; // seq
    let edition: number | null = null;
    if (at < bytes.length) {
      if (bytes[at] !== 3) return null;
      let r = Number(view.getBigUint64(at + 1, true));
      if (bytes[r] !== 4) return null;
      const count = view.getUint32(r + 1, true);
      r += 5;
      for (let i = 0; i < count; i += 1) {
        const type = bytes[r];
        r += 2 + (bytes[r + 1] === 3 ? 32 : 0);
        const offset = Number(view.getBigUint64(r, true));
        r += 8;
        if (type === 9 && bytes[offset] === 9) edition = view.getUint32(offset + 1, true);
      }
    }
    return { address: account.address, name, edition };
  } catch {
    return null;
  }
}

export type CopyAnomaly =
  | { kind: "duplicate-number"; number: number; copies: Address[] }
  | { kind: "number-out-of-range"; copy: Address; number: number | null }
  | { kind: "name-mismatch"; copy: Address; name: string; number: number | null }
  | { kind: "too-many-copies"; copies: number; minted: number };

/**
 * What `readEdition` cannot see from the three accounts, judged from the collection's copies (the
 * app fetches them): the guard's authority can shift the Edition offset, mint, and shift it back,
 * leaving two copies with one number or a copy whose `#n` is not its Edition number. Returns every
 * anomaly: a number held by more than one copy, a number outside 1..minted (or none), a name that
 * is not `<title> #<its Edition number>`, more copies than were minted. Empty means consistent.
 * Burned copies are simply absent; fewer copies than minted is not an anomaly.
 */
export function copyAnomalies(edition: { title: string; minted: number }, copies: readonly CopyView[]): CopyAnomaly[] {
  const out: CopyAnomaly[] = [];
  if (copies.length > edition.minted) out.push({ kind: "too-many-copies", copies: copies.length, minted: edition.minted });
  const byNumber = new Map<number, Address[]>();
  for (const copy of copies) {
    const n = copy.edition;
    if (n === null || !Number.isInteger(n) || n < 1 || n > edition.minted) out.push({ kind: "number-out-of-range", copy: copy.address, number: n });
    if (n !== null) byNumber.set(n, [...(byNumber.get(n) ?? []), copy.address]);
    if (copy.name !== `${edition.title} #${n}`) out.push({ kind: "name-mismatch", copy: copy.address, name: copy.name, number: n });
  }
  for (const [number, list] of byNumber) if (list.length > 1) out.push({ kind: "duplicate-number", number, copies: list });
  return out;
}
