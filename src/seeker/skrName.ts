import {
  address,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getUtf8Decoder,
  getUtf8Encoder,
  type Address,
  type Base58EncodedBytes,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * `.skr` name (Seeker ID) resolution, reverse direction only (address → names), per Solana Mobile's
 * kit resolver (https://docs.solanamobile.com/solana-mobile-stack/skr-domain). Each name is an ANS
 * account found by a PDA chain seeded with `sha256("ALT Name Service" + name)`:
 *
 *   ANS root      hash("ANS"),   32 zero bytes, 32 zero bytes
 *   `.skr` parent hash(".skr"),  32 zero bytes, ANS root
 *   `alice.skr`   hash("alice"), 32 zero bytes, `.skr` parent
 *
 * RPC failures throw, so "no name" and "could not look" stay different answers. A wrong derivation
 * would also look like "no name", so the ANS root is checked against its known address once.
 * Mainnet only; the caller passes a mainnet client, whatever cluster the build publishes on.
 */

const ANS_PROGRAM = address("ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK");
const TLD_HOUSE_PROGRAM = address("TLDHkysf5pCnKsVA4gXpNvmy7psXLPEu4LAdDJthT9S");
const ROOT_ANS = address("3mX9b4AZaQehNoQGfckVcmgmA6bkBoFcbLj9RMmMyNcU");
const HASH_PREFIX = "ALT Name Service";
const TLD = ".skr";

const HEADER_SIZE = 200;
const OWNER_OFFSET = 40;
const EXPIRES_AT_OFFSET = 104;

/**
 * `.skr` name records, as measured on mainnet: 200 bytes, starting with this discriminator. Both
 * are checked before fixed offsets are trusted, so another ANS account type cannot pass as a name.
 */
const NAME_RECORD_SIZE = 200;
const NAME_RECORD_DISCRIMINATOR = new Uint8Array([0x44, 0x48, 0x58, 0x2c, 0x0f, 0xa7, 0x67, 0xf3]);

const utf8Decoder = getUtf8Decoder();
const base64Encoder = getBase64Encoder();

const utf8 = (value: string) => new Uint8Array(getUtf8Encoder().encode(value));
const addressBytes = (value: Address) => new Uint8Array(getAddressEncoder().encode(value));
const ZERO_32 = new Uint8Array(32);

const hashName = (name: string) => sha256(utf8(HASH_PREFIX + name));

async function pda(programAddress: Address, seeds: Uint8Array[]): Promise<Address> {
  const [derived] = await getProgramDerivedAddress({ programAddress, seeds });
  return derived;
}

const deriveNameAccount = (name: string, parent?: Address) =>
  pda(ANS_PROGRAM, [hashName(name), ZERO_32, parent ? addressBytes(parent) : ZERO_32]);

const deriveTldHouse = () => pda(TLD_HOUSE_PROGRAM, [utf8("tld_house"), utf8(TLD)]);

const deriveReverseAccount = (nameAccount: Address, tldHouse: Address) =>
  pda(ANS_PROGRAM, [hashName(nameAccount), addressBytes(tldHouse), ZERO_32]);

async function fetchAccountData(
  rpc: Rpc<SolanaRpcApi>,
  account: Address,
  abortSignal?: AbortSignal,
): Promise<Uint8Array | null> {
  const { value } = await rpc
    .getAccountInfo(account, { encoding: "base64" })
    .send({ abortSignal });
  return value ? new Uint8Array(base64Encoder.encode(value.data[0])) : null;
}

let derivationChecked: Promise<void> | null = null;

/** Derives the ANS root and asserts it equals the documented constant. */
async function assertSkrDerivation(): Promise<void> {
  const root = await pda(ANS_PROGRAM, [hashName("ANS"), ZERO_32, ZERO_32]);
  if (root !== ROOT_ANS) {
    throw new Error(`.skr derivation is wrong: ANS root derived as ${root}, expected ${ROOT_ANS}`);
  }
}

function checkDerivationOnce(): Promise<void> {
  if (derivationChecked === null) {
    derivationChecked = assertSkrDerivation().catch((e: unknown) => {
      // Do not cache the failure as settled-bad; a transient crypto-polyfill hiccup at cold
      // start should be retried rather than poisoning every later lookup.
      derivationChecked = null;
      throw e;
    });
  }
  return derivationChecked;
}

/**
 * Every `.skr` name `owner` holds, sorted. An address can own several and the on-chain order is
 * not a ranking — sorting is what stops the displayed name changing between calls.
 */
async function resolveSkrNames(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address,
  abortSignal?: AbortSignal,
): Promise<string[]> {
  await checkDerivationOnce();

  const parent = await deriveNameAccount(TLD, ROOT_ANS);
  const tldHouse = await deriveTldHouse();

  // Whole accounts (filtered to one owner, so a handful of 200-byte records): size, discriminator
  // and expiry (`expiresAt`, u64 LE seconds at offset 104; 0 = never) all come from this response.
  const accounts = await rpc
    .getProgramAccounts(ANS_PROGRAM, {
      encoding: "base64",
      filters: [
        {
          memcmp: {
            offset: 8n,
            bytes: parent as string as Base58EncodedBytes,
            encoding: "base58",
          },
        },
        {
          memcmp: {
            offset: BigInt(OWNER_OFFSET),
            bytes: owner as string as Base58EncodedBytes,
            encoding: "base58",
          },
        },
      ],
    })
    .send({ abortSignal });

  // The human-readable label lives in a separate reverse-lookup account, seeded with the name
  // account's own base58 string — which is why this costs one extra read per name.
  const nowSeconds = Date.now() / 1000;
  const live = accounts.filter(({ account }) => {
    const data = new Uint8Array(base64Encoder.encode(account.data[0]));
    if (data.length !== NAME_RECORD_SIZE) return false;
    if (NAME_RECORD_DISCRIMINATOR.some((byte, index) => data[index] !== byte)) return false;
    const expiresAt = new DataView(data.buffer, data.byteOffset + EXPIRES_AT_OFFSET, 8).getBigUint64(0, true);
    return expiresAt === 0n || Number(expiresAt) > nowSeconds;
  });

  const names = await Promise.all(
    live.map(async ({ pubkey }) => {
      const data = await fetchAccountData(
        rpc,
        await deriveReverseAccount(pubkey, tldHouse),
        abortSignal,
      );
      if (!data || data.length <= HEADER_SIZE) return null;
      const label = utf8Decoder.decode(data.subarray(HEADER_SIZE)).replace(/\0.*$/, "");
      if (!label) return null;
      // The label must re-derive to this name account. Otherwise it is unverified third-party text
      // that would be shown in place of the address and stamped onto shared pictures.
      if ((await deriveNameAccount(label, parent)) !== pubkey) return null;
      return `${label}${TLD}`;
    }),
  );
  return names.filter((name): name is string => name !== null).sort();
}

/**
 * The one `.skr` name to display for `owner`, or null when it holds none. Throws on RPC
 * failure, so "no name" and "could not look" stay different answers. `rpc` must be a mainnet
 * client; `abortSignal` bounds every request made here.
 */
export async function resolveSkrName(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const names = await resolveSkrNames(rpc, owner, abortSignal);
  return names[0] ?? null;
}
