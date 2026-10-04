/**
 * Test fixtures, written from the documented layouts (the table in src/claimTransaction.ts, the
 * programs' account layouts) and NOT from the app's client, so the two implementations check each
 * other; `client.test.ts` then holds the Worker to what the real client builds. Transactions are
 * compiled and encoded by @solana/kit, so the Worker's hand parser is held to the official wire
 * format. The fake JSON-RPC endpoint answers in the shapes Helius and Solana use.
 */

import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getAddressEncoder,
  getAddressFromPublicKey,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  type AccountMeta,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { createSignInMessageText } from "@solana/wallet-standard-util";
import {
  CANDY_GUARD_PROGRAM,
  CANDY_MACHINE_PROGRAM,
  LAYOUT,
  MPL_CORE,
  SYSTEM_PROGRAM,
  SYSVAR_INSTRUCTIONS,
  SYSVAR_SLOT_HASHES,
  TOKEN_PROGRAM,
  associatedTokenOf,
  candyGuardOf,
  candyMachineAuthorityOf,
} from "../src/claimTransaction";
import { CANDY_GUARD_DISCRIMINATOR, CANDY_MACHINE_DISCRIMINATOR, CANDY_MACHINE_HIDDEN_BYTES, NO_AUTHORITY } from "../src/edition";
import { SGT_GROUP_ADDRESS, SGT_METADATA_ADDRESS, TOKEN_2022_PROGRAM } from "../src/genesis";
import { GENESIS_HASH } from "../src/rpc";
import type { Env } from "../src/index";

export const MAINNET_URL = "https://mainnet.helius-rpc.com/?api-key=SECRET-API-KEY-0123456789";
export const DEVNET_URL = "https://api.devnet.solana.com";
export const API_KEY = "SECRET-API-KEY-0123456789";

// ---------------------------------------------------------------------------------------------
// Keys and bytes
// ---------------------------------------------------------------------------------------------

export interface TestKey { address: Address; publicKey: Uint8Array; privateKey: CryptoKey; secret: Uint8Array }

export async function newKey(): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const secret = new Uint8Array(64);
  secret.set(pkcs8.subarray(pkcs8.length - 32));
  secret.set(publicKey, 32);
  return { address: await getAddressFromPublicKey(pair.publicKey), publicKey, privateKey: pair.privateKey, secret };
}

export const randomAddress = async () => (await newKey()).address;

export const b64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);
export const keyBytes = (a: string) => new Uint8Array(getAddressEncoder().encode(a as Address));
export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
export const u8 = (n: number) => new Uint8Array([n]);
const u16 = (n: number) => new Uint8Array([n & 255, n >> 8]);
export const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
export const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const str = (s: string) => { const b = new TextEncoder().encode(s); return concat(u32(b.length), b); };

// ---------------------------------------------------------------------------------------------
// Genesis Token mints
// ---------------------------------------------------------------------------------------------

/** A Token-2022 mint with MetadataPointer and TokenGroupMember, as an SGT is laid out. */
export function sgtMintBytes(mint: string, member: bigint, opts: { group?: string; memberMint?: string; metadata?: string } = {}) {
  const base = new Uint8Array(82);
  base[45] = 1; // is_initialized
  const padding = new Uint8Array(165 - 82);
  const pointer = concat(u16(18), u16(64), new Uint8Array(32), keyBytes(opts.metadata ?? SGT_METADATA_ADDRESS));
  const groupMember = concat(u16(23), u16(72), keyBytes(opts.memberMint ?? mint), keyBytes(opts.group ?? SGT_GROUP_ADDRESS), u64(member));
  return concat(base, padding, u8(1), pointer, groupMember);
}

/** A plain Token-2022 mint: metadata pointer, no group membership. */
export function plainToken2022MintBytes() {
  const base = new Uint8Array(82);
  base[45] = 1;
  return concat(base, new Uint8Array(165 - 82), u8(1), concat(u16(18), u16(64), new Uint8Array(32), keyBytes(SGT_METADATA_ADDRESS)));
}

// ---------------------------------------------------------------------------------------------
// Edition accounts
// ---------------------------------------------------------------------------------------------

export type TestPrice =
  | { kind: "free" }
  | { kind: "sol"; lamports: bigint }
  | { kind: "token"; mint: Address; amount: bigint };

export interface GuardOptions {
  cosigner?: string | null;
  /** A Mint Limit (bit 9) as an open edition has. */
  mintLimit?: boolean;
  /** Bot Tax (bit 0). */
  botTax?: boolean;
  /** A SOL payment destination other than the publisher. */
  solDestination?: string;
  /** A group after the default set. */
  group?: boolean;
}

/** Guard data in the program's layout: u64 features, bodies in bit order, u32 group count. */
export async function guardData(publisher: string, price: TestPrice, o: GuardOptions = {}) {
  let features = 0n;
  const body: Uint8Array[] = [];
  if (o.botTax) { features |= 1n << 0n; body.push(u64(1000n), u8(0)); }
  if (price.kind === "sol") { features |= 1n << 1n; body.push(u64(price.lamports), keyBytes(o.solDestination ?? publisher)); }
  if (price.kind === "token") {
    features |= 1n << 2n;
    body.push(u64(price.amount), keyBytes(price.mint), keyBytes(await associatedTokenOf(publisher, price.mint)));
  }
  if (o.cosigner) { features |= 1n << 4n; body.push(keyBytes(o.cosigner)); }
  if (o.mintLimit) { features |= 1n << 9n; body.push(u8(0), u16(1)); }
  features |= 1n << 23n; body.push(u32(0));
  const groups = o.group ? concat(u32(1), new TextEncoder().encode("claim\0"), u64(0n)) : u32(0);
  return concat(u64(features), ...body, groups);
}

export async function candyGuardBytes(edition: string, publisher: string, price: TestPrice, o: GuardOptions = {}) {
  return concat(new Uint8Array(CANDY_GUARD_DISCRIMINATOR), keyBytes(edition), u8(255), keyBytes(publisher),
    await guardData(publisher, price, o));
}

export interface MachineOptions {
  authority?: string;
  mintAuthority: string;
  collection: string;
  redeemed?: bigint;
  available?: bigint;
  name?: string;
}

/** A hidden-settings candy machine, exactly `CANDY_MACHINE_HIDDEN_BYTES` long. */
export function candyMachineBytes(o: MachineOptions) {
  const body = concat(new Uint8Array(CANDY_MACHINE_DISCRIMINATOR), keyBytes(o.authority ?? NO_AUTHORITY), keyBytes(o.mintAuthority),
    keyBytes(o.collection), u64(o.redeemed ?? 1n), u64(o.available ?? 10n), u64(0n), u8(1), u8(0), u8(1),
    str(o.name ?? "Harbour #$ID+1$"), str(EDITION_URI), new Uint8Array(32));
  const out = new Uint8Array(CANDY_MACHINE_HIDDEN_BYTES);
  out.set(body);
  return out;
}

export const EDITION_URI = "https://erashot.app/m/1.json";

export interface CollectionOptions {
  edition: string;
  publisher: string;
  title?: string;
  uri?: string;
  numMinted?: number;
  available?: number;
  updateAuthority?: string;
  bps?: number;
  /** A fourth plugin record (Attributes, type 9) after the three. */
  extraPlugin?: boolean;
}

/**
 * A Core `CollectionV1` as publishing leaves it: key 5, update authority, name, uri, num_minted,
 * current_size, `PluginHeaderV1` (3, registry offset), the three plugins, `PluginRegistryV1` (4,
 * records {type, authority tag, offset}, no external records) ending the account.
 */
export async function collectionBytes(o: CollectionOptions) {
  const head = concat(u8(5), keyBytes(o.updateAuthority ?? NO_AUTHORITY), str(o.title ?? "Harbour"), str(o.uri ?? EDITION_URI),
    u32(o.numMinted ?? 1), u32(o.numMinted ?? 1));
  const bps = o.bps ?? 500;
  const plugins: [number, number, Uint8Array][] = [ // type, authority tag (0 None, 2 UpdateAuthority), bytes
    [10, 0, concat(u8(10), u8(1), u32(o.available ?? 10), u8(0), u8(0))],
    [0, 0, concat(u8(0), u16(bps), u32(1), keyBytes(o.publisher), u8(100), u8(0))],
    [4, 2, concat(u8(4), u32(1), keyBytes(await candyMachineAuthorityOf(o.edition)))],
    ...(o.extraPlugin ? [[9, 2, concat(u8(9), u32(0))] as [number, number, Uint8Array]] : []),
  ];
  let at = head.length + 9;
  const records: Uint8Array[] = [];
  for (const [type, tag, bytes] of plugins) { records.push(concat(u8(type), u8(tag), u64(BigInt(at)))); at += bytes.length; }
  const header = concat(u8(3), u64(BigInt(at)));
  return concat(head, header, ...plugins.map((p) => p[2]), u8(4), u32(plugins.length), ...records, u32(0));
}

// ---------------------------------------------------------------------------------------------
// The claim transaction, per the table
// ---------------------------------------------------------------------------------------------

export interface ClaimParts {
  wallet: Address;
  /** The wallet's key: it signs first. */
  walletKey?: Signer;
  edition: Address;
  collection: Address;
  asset: Address;
  payer: Address;
  cosigner: Address;
  /** The temporary token account (token price). */
  temp: Address;
  blockhash: string;
}

export const ro = (a: string): AccountMeta => ({ address: a as Address, role: AccountRole.READONLY });
export const w = (a: string): AccountMeta => ({ address: a as Address, role: AccountRole.WRITABLE });
export const rs = (a: string): AccountMeta => ({ address: a as Address, role: AccountRole.READONLY_SIGNER });
export const ws = (a: string): AccountMeta => ({ address: a as Address, role: AccountRole.WRITABLE_SIGNER });

const ix = (program: string, accounts: AccountMeta[], data: Uint8Array): Instruction =>
  ({ programAddress: program as Address, accounts, data: data as Uint8Array<ArrayBuffer> });

export const transferSol = (from: string, to: string, lamports: bigint) => ix(SYSTEM_PROGRAM, [ws(from), w(to)], concat(u32(2), u64(lamports)));
export const createAccount = (from: string, account: string, lamports: bigint, space: number, owner: string) =>
  ix(SYSTEM_PROGRAM, [ws(from), ws(account)], concat(u32(0), u64(lamports), u64(BigInt(space)), keyBytes(owner)));
export const allocate = (account: string, space: bigint) => ix(SYSTEM_PROGRAM, [ws(account)], concat(u32(8), u64(space)));
export const advanceNonce = (nonceAccount: string, authority: string) =>
  ix(SYSTEM_PROGRAM, [w(nonceAccount), ro("SysvarRecentB1ockHashes11111111111111111111"), rs(authority)], u32(4));
export const initializeAccount3 = (account: string, mint: string, owner: string) => ix(TOKEN_PROGRAM, [w(account), ro(mint)], concat(u8(18), keyBytes(owner)));
export const tokenTransfer = (source: string, destination: string, owner: string, amount: bigint) =>
  ix(TOKEN_PROGRAM, [w(source), w(destination), rs(owner)], concat(u8(3), u64(amount)));
export const closeAccount = (account: string, destination: string, owner: string) => ix(TOKEN_PROGRAM, [w(account), w(destination), rs(owner)], u8(9));

/** `mint_v1` data: discriminator, empty `mint_args`, label None. */
export const MINT_V1_DATA = concat(new Uint8Array(LAYOUT.discriminator), u32(0), u8(0));

/** The 13 fixed accounts then `remaining`. */
export async function mintAccounts(p: ClaimParts, remaining: AccountMeta[]): Promise<AccountMeta[]> {
  return [
    ro(await candyGuardOf(p.edition)), ro(CANDY_MACHINE_PROGRAM), w(p.edition), w(await candyMachineAuthorityOf(p.edition)),
    ws(p.payer), ws(p.wallet), ro(CANDY_GUARD_PROGRAM), ws(p.asset), w(p.collection), ro(MPL_CORE),
    ro(SYSTEM_PROGRAM), ro(SYSVAR_INSTRUCTIONS), ro(SYSVAR_SLOT_HASHES), ...remaining,
  ];
}

export const mintInstruction = (accounts: AccountMeta[], data: Uint8Array = MINT_V1_DATA) => ix(CANDY_GUARD_PROGRAM, accounts, data);

export const PAYER_FUNDING = 4_000_000n;
export const PAYER_SPACE = 600n;

/** The instruction list of the table for `price`, given the publisher (SOL destination, token destination ATA). */
export async function claimInstructions(p: ClaimParts, price: TestPrice, publisher: string): Promise<Instruction[]> {
  const funding = PAYER_FUNDING + (price.kind === "sol" ? price.lamports : 0n);
  if (price.kind === "token") {
    return [
      transferSol(p.wallet, p.payer, funding),
      createAccount(p.wallet, p.temp, 2_039_280n, 165, TOKEN_PROGRAM),
      initializeAccount3(p.temp, price.mint, p.wallet),
      tokenTransfer(await associatedTokenOf(p.wallet, price.mint), p.temp, p.wallet, price.amount),
      mintInstruction(await mintAccounts(p, [w(p.temp), w(await associatedTokenOf(publisher, price.mint)), ro(TOKEN_PROGRAM), rs(p.cosigner)])),
      allocate(p.payer, PAYER_SPACE),
      closeAccount(p.temp, p.wallet, p.wallet),
    ];
  }
  const remaining = price.kind === "sol" ? [w(publisher), rs(p.cosigner)] : [rs(p.cosigner)];
  return [transferSol(p.wallet, p.payer, funding), mintInstruction(await mintAccounts(p, remaining)), allocate(p.payer, PAYER_SPACE)];
}

/** Anything that can sign: an address and its WebCrypto private key. */
export interface Signer { address: string; privateKey: CryptoKey }

export interface BuildOptions {
  feePayer?: string;
  version?: 0 | "legacy";
  lookupTable?: { address: Address; addresses: Address[] };
  /** Who signs, as the wallet then the app do before the Worker. Default: the wallet's key, if known. */
  signers?: Signer[];
  /** Shuffle the static accounts within each header group, as Seed Vault reorders them. */
  reorder?: boolean;
}

/**
 * Wire bytes compiled by kit, signed by `signers` (default `p.walletKey`); the co-signer's and
 * any other slot stay zero.
 */
export async function buildTransaction(p: { wallet: string; blockhash: string; walletKey?: Signer }, instructions: Instruction[],
  o: BuildOptions = {}): Promise<Uint8Array> {
  let message: any = pipe(
    createTransactionMessage({ version: o.version ?? 0 }),
    (m) => setTransactionMessageFeePayer((o.feePayer ?? p.wallet) as Address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: p.blockhash as Blockhash, lastValidBlockHeight: 1000n }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  if (o.lookupTable)
    message = compressTransactionMessageUsingAddressLookupTables(message, { [o.lookupTable.address]: o.lookupTable.addresses });
  let tx = compileTransaction(message) as unknown as { messageBytes: Uint8Array; signatures: Record<string, Uint8Array | null> };
  if (o.reorder) tx = reorderAccounts(tx);
  const signatures = { ...tx.signatures };
  for (const signer of o.signers ?? (p.walletKey ? [p.walletKey] : []))
    if (signer.address in signatures) signatures[signer.address] = new Uint8Array(await signBytes(signer.privateKey, tx.messageBytes as never));
  return new Uint8Array(getTransactionEncoder().encode({ ...tx, signatures } as never));
}

/**
 * The same message with its static accounts permuted inside each header group (the fee payer
 * stays first) and every instruction's indexes remapped: a valid message kit would never emit.
 */
export function reorderAccounts(tx: { messageBytes: Uint8Array; signatures: Record<string, Uint8Array | null> }) {
  const m: any = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const n = m.staticAccounts.length;
  const { numSignerAccounts: signers, numReadonlySignerAccounts: roSigners, numReadonlyNonSignerAccounts: roOthers } = m.header;
  const groups = [[1, signers - roSigners], [signers - roSigners, signers], [signers, n - roOthers], [n - roOthers, n]];
  const order = [0];
  for (const [from, to] of groups) {
    const g = Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i).filter((i) => i !== 0);
    order.push(...g.reverse());
  }
  const newIndex = new Map(order.map((old, i) => [old, i]));
  const reordered = {
    ...m,
    staticAccounts: order.map((i) => m.staticAccounts[i]),
    instructions: m.instructions.map((ix: any) => ({
      ...ix,
      programAddressIndex: newIndex.get(ix.programAddressIndex),
      accountIndices: ix.accountIndices?.map((i: number) => newIndex.get(i)),
    })),
  };
  const messageBytes = new Uint8Array(getCompiledTransactionMessageEncoder().encode(reordered));
  const signatures: Record<string, Uint8Array | null> = {};
  for (const a of reordered.staticAccounts.slice(0, signers)) signatures[a] = null;
  return { messageBytes, signatures };
}

// ---------------------------------------------------------------------------------------------
// SIWS, as the wallet does it
// ---------------------------------------------------------------------------------------------

export async function signIn(key: TestKey, payload: Record<string, string>, asAddress = key.address) {
  const text = createSignInMessageText({ ...payload, address: asAddress } as never);
  const message = new TextEncoder().encode(text);
  const signature = new Uint8Array(await signBytes(key.privateKey, message));
  return { address: b64(key.publicKey), signed_message: b64(message), signature: b64(signature) };
}

// ---------------------------------------------------------------------------------------------
// The fake RPC
// ---------------------------------------------------------------------------------------------

type AccountEntry = { owner: string; data: Uint8Array; lamports?: number } | null;

/**
 * A cluster as the fake RPC models it: a processed block height, a confirmed bank `lag` blocks
 * behind it, slots `SLOT_OFFSET` ahead of heights, and blockhashes registered at the processed
 * height when added. A blockhash is valid at a commitment while that bank has seen it and its
 * height is within 150 blocks of the blockhash's.
 */
export class Blockhashes extends Set<string> {
  readonly heights = new Map<string, number>();
  constructor(private readonly chain: () => Chain) { super(); }
  override add(blockhash: string) {
    if (this.chain) this.heights.set(blockhash, this.chain().height);
    return super.add(blockhash);
  }
}

export interface Chain {
  genesis: string;
  accounts: Map<string, AccountEntry>;
  validBlockhashes: Blockhashes;
  /** The processed bank's block height. */
  height: number;
  /** How many blocks the confirmed bank lags the processed one. */
  lag: number;
}

export const SLOT_OFFSET = 10_000;

/** Move the chain on by `blocks` (default: past any blockhash's lifetime, and its confirmed lag). */
export const advance = (chain: Chain, blocks = 200) => { chain.height += blocks; };

export interface FakeRpc {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  chains: Record<string, Chain>;
  /** Token-2022 accounts per owner, as getTokenAccountsByOwnerV2 returns them. */
  tokenAccounts: Map<string, unknown[]>;
  calls: { url: string; method: string; params?: unknown[] }[];
  /** Fail every request this way, when set. */
  failure?: "throw" | "http-500" | "rpc-error";
  /** Called before answering; may wait. */
  gate?: (method: string) => Promise<void>;
}

const accountJson = (e: Exclude<AccountEntry, null>) => ({
  lamports: e.lamports ?? 1_000_000, owner: e.owner, data: [b64(e.data), "base64"], executable: false, rentEpoch: 0, space: e.data.length,
});

export function tokenAccountRow(owner: string, mint: string, amount: "0" | "1", pubkey: string) {
  return {
    pubkey,
    account: {
      lamports: 2_074_080, owner: TOKEN_2022_PROGRAM, executable: false, rentEpoch: 18446744073709551615, space: 170,
      data: {
        program: "spl-token-2022", space: 170,
        parsed: {
          type: "account",
          info: {
            isNative: false, mint, owner, state: "frozen",
            tokenAmount: { amount, decimals: 0, uiAmount: Number(amount), uiAmountString: amount },
            extensions: [{ extension: "immutableOwner" }],
          },
        },
      },
    },
  };
}

function newChain(genesis: string): Chain {
  const chain: Chain = { genesis, accounts: new Map(), validBlockhashes: undefined as never, height: 300_000_000, lag: 2 };
  chain.validBlockhashes = new Blockhashes(() => chain);
  return chain;
}

export function fakeRpc(): FakeRpc {
  const chains: Record<string, Chain> = { [MAINNET_URL]: newChain(GENESIS_HASH["mainnet-beta"]), [DEVNET_URL]: newChain(GENESIS_HASH.devnet) };
  const rpc: FakeRpc = {
    chains, tokenAccounts: new Map(), calls: [],
    async fetch(url, init) {
      const { method, params } = JSON.parse(init.body as string) as { method: string; params: any[] };
      rpc.calls.push({ url, method, params });
      if (rpc.failure === "throw") throw new TypeError(`fetch failed: connect ECONNREFUSED ${url}`);
      if (rpc.failure === "http-500") return new Response(`upstream error for ${url}`, { status: 500 });
      if (rpc.failure === "rpc-error") return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `bad key ${url}` } });
      await rpc.gate?.(method);
      const chain = chains[url];
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
      // The bank a request reads: its commitment ("finalized" lags further), and its min context slot.
      const config = (params.find((p) => p && typeof p === "object" && !Array.isArray(p)) ?? {}) as { commitment?: string; minContextSlot?: number };
      const commitment = config.commitment ?? "finalized";
      const height = chain.height - (commitment === "processed" ? 0 : commitment === "confirmed" ? chain.lag : chain.lag + 30);
      const slot = height + SLOT_OFFSET;
      if (config.minContextSlot !== undefined && config.minContextSlot > slot)
        return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32016, message: "Minimum context slot has not been reached" } });
      const ctx = { apiVersion: "2.3.0", slot };
      switch (method) {
        case "getGenesisHash": return reply(chain.genesis);
        case "isBlockhashValid": {
          const at = chain.validBlockhashes.has(params[0]) ? chain.validBlockhashes.heights.get(params[0]) : undefined;
          return reply({ context: ctx, value: at !== undefined && at <= height && height <= at + 150 });
        }
        case "getBlockHeight": return reply(height);
        case "getEpochInfo":
          return reply({ absoluteSlot: slot, blockHeight: height, epoch: 900, slotIndex: 1, slotsInEpoch: 432_000, transactionCount: null });
        case "getAccountInfo": {
          const e = chain.accounts.get(params[0]) ?? null;
          return reply({ context: ctx, value: e && accountJson(e) });
        }
        case "getMultipleAccounts": {
          const keys = params[0] as string[];
          return reply({ context: ctx, value: keys.map((k) => { const e = chain.accounts.get(k) ?? null; return e && accountJson(e); }) });
        }
        case "getTokenAccountsByOwnerV2":
          if (url !== MAINNET_URL) throw new Error("V2 asked of a non-Helius endpoint");
          return reply({ context: ctx, value: rpc.tokenAccounts.get(params[0]) ?? [], paginationKey: null });
        default:
          return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
      }
    },
  };
  return rpc;
}

export function testEnv(base: { DB: D1Database }, cosigner: TestKey): Env {
  return {
    DB: base.DB,
    COSIGNER_SECRET_KEY: JSON.stringify([...cosigner.secret]),
    NONCE_HMAC_SECRET: "test-hmac-secret-0123456789abcdef0123456789abcdef",
    MAINNET_RPC_URL: MAINNET_URL,
    DEVNET_RPC_URL: DEVNET_URL,
    SIWS_DOMAIN: "erashot.app",
    SIWS_URI: "https://erashot.app",
  };
}
