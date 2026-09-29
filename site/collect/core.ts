/**
 * The Metaplex Core adapter for `/collect/?core=<edition>`: the trusted program, the reader, the
 * claim instruction, the links and the wording that names Core's costs, so `page.ts` stays a page.
 *
 * The reader is the app's own (`publications/core/protocol.ts`): the edition account's owner is
 * checked against the reviewed deployments for this network, the metadata document is hash-checked
 * against the edition, and a `seedshot-attestation/1` chain is verified to Google's pinned roots
 * and checked for the release app, boot state, revocation and dates at publication before the page
 * names the device. Neither the link nor the metadata grants trust.
 *
 * A claim creates a Core asset and a receipt account, so the collector pays rent, the network fee
 * and Metaplex Core's flat create fee; a priced edition adds the creator's price, and only that
 * part reaches the creator.
 */
import {
  addresses,
  buyInstruction,
  collectInstruction,
  collectUrl,
  explorerUrl,
  loadTrustedEdition,
  pricedOffer,
  readOfferAccount,
} from "../../publications/core/protocol";
import { verifyGenesisToken } from "../../publications/core/genesisToken";
import { claimGenesis, claimedCopy } from "../../publications/core/seekerClaim";
import { isSeeker } from "../../publications/core/attestation";
import { checkDevice, publicationTime, readRevocationList } from "../../publications/core/attestationCheck";
import { assertReviewedProgram } from "../../publications/programImage";
import type { CoreMetadata } from "../../publications/types";

import {
  attestationStatusUrl,
  cluster,
  endpoint,
  mainnetEndpoint,
  type Adapter,
  type Device,
  type Genesis,
  type Loaded,
} from "./page";
import { deviceLine, NEEDS_GENESIS } from "./summary";

/** Metaplex Core's flat `CREATE_FEE`, quoted in the fine print only; the estimate is measured. */
const CORE_CREATE_FEE_SOL = "0.0015";

/** The document's Seeker Genesis Token claim and its mainnet check (`seedshot-genesis/1`). */
function genesisRow(e: CoreMetadata): Genesis {
  const mint = e.genesisMint;
  return mint
    ? { mint, sealed: !!e.genesisSealed, standing: () => verifyGenesisToken(mainnetEndpoint, mint, e.creator) }
    : null;
}

/**
 * The document's device evidence and the check that decides whether the page may name the device
 * (`deviceVerdict`): judged at the edition's on-chain publication time (`publicationTime`: its
 * recorded `published_at`, or on a legacy deployment the block time of the transaction that
 * created the publisher's claim receipt), against Google's revocation list.
 */
function deviceRow(
  e: CoreMetadata,
  publication: { program: string; edition: string },
): Device {
  const a = e.attestation;
  if (!a) return e.attestationProblem ? { problem: e.attestationProblem } : null;
  return {
    line: deviceLine(a),
    seeker: isSeeker(a),
    check: () =>
      checkDevice(a, {
        revocationList: () => readRevocationList(attestationStatusUrl),
        publishedAt: () => publicationTime(endpoint, publication.program, publication.edition),
      }),
  };
}

export function coreAdapter(edition: string): Adapter {
  let meta: CoreMetadata | null = null;
  /** Read off the Edition with `meta`: only Seeker Genesis Token holders collect, one per token. */
  let seekerOnly = false;
  const current = () => {
    if (!meta) throw new Error("This edition has not been read yet.");
    return meta;
  };
  /**
   * One Genesis Token lookup per wallet for a minute: `hasCollected`, `claim` and the check after
   * confirming ask in quick succession, and each lookup is several proxy requests. A failure is
   * not held. The program checks the token again whatever this found.
   */
  let held: { wallet: string; until: number; genesis: ReturnType<typeof claimGenesis> } | null = null;
  const genesisOf = (wallet: string) => {
    if (!held || held.wallet !== wallet || held.until < Date.now()) {
      const genesis = claimGenesis(endpoint, cluster, seekerOnly, wallet);
      held = { wallet, until: Date.now() + 60_000, genesis };
      genesis.catch(() => {
        if (held?.genesis === genesis) held = null;
      });
    }
    return held.genesis;
  };
  return {
    edition,
    pendingKey: `seedshot.core-collect.v2:${cluster}:${edition}`,
    copy: {
      solo: "Edition of 1",
      cost: "",
      details: (loaded: Loaded) =>
        `${loaded.width} × ${loaded.height} px · One copy per ${loaded.seekerOnly ? "Seeker Genesis Token" : "wallet"}`,
      fees: () => `Metaplex Core fee · ${CORE_CREATE_FEE_SOL} SOL`,
      card: (supply: number) => `EDITION OF ${supply} NUMBERED COP${supply === 1 ? "Y" : "IES"}`,
      collected: (number: number, supply: number) =>
        `Copy ${number} of ${supply} collected.`,
    },
    async load() {
      const result = await loadTrustedEdition(endpoint, edition, cluster);
      meta = result.edition;
      seekerOnly = result.seekerOnly;
      return {
        title: result.edition.title,
        creator: result.edition.creator,
        supply: result.edition.supply,
        minted: result.minted,
        remaining: result.remaining,
        width: result.edition.width,
        height: result.edition.height,
        imageBytes: result.imageBytes,
        // `""` when the publisher wrote no caption. `loadTrustedEdition` has already refused
        // a document whose description is not publishable text.
        description: result.edition.description,
        // What a screen renders. A quote never uses this copy: `claim()` re-reads the offer.
        price: result.offer,
        seekerOnly: result.seekerOnly,
        device: deviceRow(result.edition, result.publication),
        // A claim until `standing()` has asked mainnet, which the page does after it has rendered.
        genesis: genesisRow(result.edition),
      };
    },
    // A seeker-only edition's claim is its token's, whichever wallet made it (`seekerClaim.ts`);
    // the page also asks this after confirming, so the same rule proves the claim landed.
    async hasCollected(wallet) {
      const e = current();
      return (await claimedCopy(endpoint, e, wallet, await genesisOf(wallet))) !== null;
    },
    async claim(wallet, number) {
      const e = current();
      // The collector signs and pays, and a signer's privileges reach every program it calls, so
      // a program whose bytes or upgrade authority are not the reviewed ones is refused first.
      await assertReviewedProgram(endpoint, e.program, cluster);
      // A seeker-only edition takes the collector's Genesis Token, found on the edition's own
      // cluster (the devnet stand-in on devnet); the program checks it again.
      const genesis = await genesisOf(wallet);
      if (genesis === null) throw new Error(NEEDS_GENESIS);
      // The print PDA this claim creates, recorded in the durable attempt before the wallet opens.
      const keys = await addresses(e.program, e.creator, e.nonce, number, wallet);
      // The live offer, never the one loaded with the edition: a price can change at any moment.
      // `pricedOffer` reads no offer account, no offers on this program and a zero price as free,
      // the program's own rule: `collect` succeeds only at price 0, `buy` refuses it.
      const offer = pricedOffer(await readOfferAccount(endpoint, e.program, e.edition));
      const instruction = offer
        ? await buyInstruction(e, wallet, number, offer.priceLamports, offer.revision, genesis ?? undefined)
        : await collectInstruction(e, wallet, number, genesis ?? undefined);
      return { instruction, asset: keys.print, price: offer };
    },
    assertProgram: () => assertReviewedProgram(endpoint, current().program, cluster),
    collectUrl: () => collectUrl(edition, cluster),
    links: () => ({
      source: explorerUrl(edition, cluster),
      container: {
        href: explorerUrl(current().collection, cluster),
        label: "View the Metaplex Core collection ↗",
      },
    }),
  };
}
