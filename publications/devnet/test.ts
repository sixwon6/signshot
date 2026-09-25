/**
 * The live devnet acceptance run. Permitted only after `deploy` has byte-verified the program.
 *
 * Everything published here is generated: a labelled 512x512 test card and a three-key metadata
 * document per edition. **These Arweave items are public and permanent even though the program is
 * on devnet**, so the wallet count is asserted BEFORE the first upload.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { AccountRole, address, generateKeyPairSigner, type Instruction, type KeyPairSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { buildDataItem } from "../../src/arweave/dataItem";
import { uploadDataItem } from "../../src/arweave/turbo";
import { base58Encode } from "../../src/arweave/codec";
import { canonicalize, type JcsValue } from "../../src/jcs";
import { checkStorageCapacity } from "../storage";
import {
  GENESIS_ATTRIBUTE,
  MPL_CORE,
  account,
  addresses,
  buyInstruction,
  collectInstruction,
  decodeAsset,
  decodeCollection,
  hasCollected,
  hash,
  instruction,
  metadata,
  offerAddress,
  pricedOffer,
  readEdition,
  readOfferAccount,
  readPublication,
  readReceipt,
  sealedGenesisMint,
  setOfferInstruction,
  SYSTEM_PROGRAM,
  terms,
  utf8,
  verifyEditionCollection,
  verifyPrintAsset,
} from "../core/protocol";
import {
  assertMemberDecodes,
  devnetGenesisKeys,
  foilInstructions,
  genesisTokenAccount,
  groupInstructions,
  memberInstructions,
} from "./genesisFixture";
import { normalizeDescription } from "../core/details";
import { albumUrl, readAlbum, verifyAlbumGroup, createAlbumInstruction } from "../core/album";
import { inspectTransfer, transferInstructions } from "../core/transfer";
import { CORE_PROTOCOL, type CoreMetadata } from "../types";
import { arweaveBytes, request } from "../rpc";
import { verifyCreatorProceeds } from "./purchaseReceipt";
import {
  WALLET_WORK,
  send,
  walletFunding,
  type Context,
} from "./work";

interface TestContext extends Context {
  testJournal?: Record<string, string>;
  testEditions?: CoreMetadata[];
  testUploads?: { id: string; bytes: Uint8Array; dataHash: string }[];
  uploader?: string;
  /** The Genesis Token stand-in's member mint; its address is in the sealed edition's document. */
  genesisMember?: KeyPairSigner;
  /** A fresh, empty token account of the payer's, for the refusal that needs one. */
  genesisEmpty?: KeyPairSigner;
}

/** 0.01 devnet SOL, the acceptance price. Matches `TEST_COSTS.price` in `work.ts`. */
const PRICE = 10_000_000n;

/**
 * A `collect` past the edition's supply.
 *
 * `collectInstruction` bounds `number` by `supply` because that is a program rule, and failing it
 * locally costs no simulation and opens no wallet. The refusals below are about the PROGRAM's own
 * answer (`SoldOut`), so the local restatement has to be got past — and raising `supply` in the
 * caller's own record is the only thing that changes: the instruction data is the discriminator
 * and `number` as a u16, and every account is derived from the creator and the nonce.
 */
const collectBeyondSupply = (item: CoreMetadata, collector: string, number: number) =>
  collectInstruction({ ...item, supply: Math.max(item.supply, number) }, collector, number);

/** Any wallet that is not the creator; only the account list `creatorCollect` builds is ever used. */
const SOME_OTHER_WALLET = "11111111111111111111111111111112";

/**
 * The `collect` a creator cannot build.
 *
 * `collectInstruction` refuses `collector === creator` outright, for the same reason: `publish`
 * already initialised the creator's receipt, so the program would reject the transaction. Assembled
 * here on purpose, in `struct Collect`'s exact account order, so that the refusal observed on the
 * cluster is the program's and not this client's.
 */
async function creatorCollect(item: CoreMetadata, number: number): Promise<Instruction> {
  const template = await collectInstruction(item, SOME_OTHER_WALLET, number);
  const k = await addresses(item.program, item.creator, item.nonce, number, item.creator);
  return {
    ...template,
    accounts: [
      { address: address(item.creator), role: AccountRole.WRITABLE_SIGNER },
      ...[k.edition, k.collection, k.print, k.receipt].map((a) => ({
        address: a,
        role: AccountRole.WRITABLE,
      })),
      { address: await offerAddress(item.program, item.edition), role: AccountRole.READONLY },
      { address: MPL_CORE, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
  };
}

/**
 * What this run publishes, in order.
 *
 * The supply-3 and supply-1 cases are the original acceptance: a shared run and the sold-out 1/1
 * whose only print is the creator's own. Supply 5 is the free-moment row — one publisher plus four
 * friends. The two album members carry the album acceptance, `offer` carries the paid one and
 * `genesis` the sealed Genesis Token publish, whose document names the stand-in's member mint.
 */
function editionPlan() {
  return [
    { key: "3", title: "DEVNET Core Test", supply: 3 },
    { key: "1", title: "DEVNET Solo Test", supply: 1 },
    { key: "5", title: "DEVNET Five Test", supply: 5 },
    { key: "album-a", title: "DEVNET Album One", supply: 2 },
    { key: "album-b", title: "DEVNET Album Two", supply: 2 },
    { key: "offer", title: "DEVNET Offer Test", supply: 3 },
    { key: "genesis", title: "DEVNET Genesis Test", supply: 1 },
  ];
}

export async function lifecycle(c: TestContext) {
  const journal = (c.testJournal ??= {});
  const save = () =>
    writeFileSync(
      join(c.reportRoot, "test-results.json"),
      JSON.stringify(
        {
          program: c.program.address,
          cluster: "devnet",
          protocol: CORE_PROTOCOL,
          editions: c.testEditions,
          checks: journal,
        },
        null,
        2,
      ),
    );
  const once = async (name: string, work: () => Promise<string>) => {
    if (!journal[name]) {
      journal[name] = await work();
      save();
    }
    console.log("PASS", name, journal[name]);
  };
  // Checked BEFORE a single byte reaches Arweave: an upload is public and permanent, so a session
  // started with an older session.ts (five collector wallets, before the paid case) must stop here
  // rather than pay for uploads and then abort at the buy.
  assert.ok(
    c.collectors.length >= WALLET_WORK.length,
    `This acceptance needs ${WALLET_WORK.length} disposable collector wallets; see publications/devnet/session.ts`,
  );
  const budget = getSetComputeUnitLimitInstruction({ units: 400_000 });
  const plan = editionPlan();
  if (!c.testEditions) {
    assert.ok(c.artifact, "Prepare a generated test image first");
    const image = readFileSync(c.artifact.imagePath);
    assert.equal(
      hash(image),
      c.artifact.imageHash,
      "Prepared synthetic image changed",
    );
    assert.equal(image.length, c.artifact.imageBytes, "Prepared image size changed");
    const secret = randomBytes(32);
    const signer = {
      publicKey: ed25519.getPublicKey(secret),
      sign: (message: Uint8Array) => ed25519.sign(message, secret),
    };
    c.uploader = base58Encode(signer.publicKey);
    c.testUploads = [];
    const prepareUpload = (bytes: Uint8Array, mime: string) => {
      const item = buildDataItem({
        data: bytes,
        tags: [
          { name: "Content-Type", value: mime },
          { name: "App-Name", value: "Signshot-Devnet-Test" },
        ],
        signer,
      });
      c.testUploads!.push({
        id: item.id,
        bytes: item.bytes,
        dataHash: hash(bytes),
      });
      return `https://arweave.net/${item.id}`;
    };
    try {
      const imageUri = prepareUpload(image, "image/jpeg");
      c.testEditions = [];
      // Named in the sealed edition's document before anything is uploaded; minted later.
      c.genesisMember ??= await generateKeyPairSigner();
      for (const item of plan) {
        const nonce = randomBytes(32).toString("hex");
        const keys = await addresses(c.program.address, c.payer.address, nonce);
        const e: CoreMetadata = {
          cluster: "devnet",
          program: c.program.address,
          edition: keys.edition,
          collection: keys.collection,
          creator: c.payer.address,
          nonce,
          title: item.title,
          supply: item.supply,
          image: imageUri,
          imageHash: hash(image),
          width: 512,
          height: 512,
          description: `Devnet acceptance publication: ${item.key}.`,
          ...(item.key === "genesis" ? { genesisMint: c.genesisMember.address } : {}),
        };
        // The two gates that decide what may reach permanent storage, run before it does.
        terms(e.title, e.supply);
        normalizeDescription(e.description);
        // The document exactly as the app writes it: `metadata()` canonicalized by RFC 8785.
        const bytes = utf8(canonicalize(metadata(e) as unknown as JcsValue));
        const uri = prepareUpload(bytes, "application/json");
        journal[`metadata-${item.key}`] = uri;
        journal[`metadataHash-${item.key}`] = hash(bytes);
        c.testEditions.push(e);
        save();
      }
    } finally {
      secret.fill(0);
    }
  }
  assert.equal(c.testEditions.length, plan.length, "Test metadata setup incomplete");
  assert.ok(
    c.uploader && c.testUploads?.length === plan.length + 1,
    "Prepared public test assets are missing",
  );
  // Retain the identical signed items in this session across partial-upload or
  // gateway failures. Retrying never creates a new permanent test publication.
  await checkStorageCapacity(c.uploader, c.testUploads);
  for (const item of c.testUploads) {
    await uploadDataItem(item.bytes, item.id);
    await arweaveBytes(item.id, item.dataHash);
  }
  const [bob, carol, dave, erin, frank, grace, heidi, ivan] = c.collectors;
  // Each wallet is funded from its own measured work (`walletFunding`), not a flat grant: the
  // paid case added three wallets and program-data rent for this build leaves little spare.
  await once("fund-collectors", () =>
    send(
      c,
      c.collectors.map((s, index) =>
        getTransferSolInstruction({
          source: c.payer,
          destination: s.address,
          amount: walletFunding(index),
        }),
      ),
    ),
  );
  const byKey = new Map(plan.map((item, index) => [item.key, c.testEditions![index]]));
  const e = byKey.get("3")!;
  const solo = byKey.get("1")!;
  const five = byKey.get("5")!;
  const publish = (item: CoreMetadata, key: string, album?: string) =>
    instruction(
      item,
      c.payer.address,
      1,
      journal[`metadata-${key}`],
      journal[`metadataHash-${key}`],
      album,
    );
  await once("publish-edition-of-three", async () =>
    send(c, [budget, await publish(e, "3")]),
  );
  await once("publish-edition-of-one", async () =>
    send(c, [budget, await publish(solo, "1")]),
  );
  // The creator's receipt is written by `publish`, so their second claim is refused while
  // the edition is neither sold out nor stale: the receipt alone is what stops it.
  await once("creator-second-claim-rejected", async () =>
    send(c, [budget, await creatorCollect(e, 2)], [c.payer], /already in use/),
  );
  await once("collector-claims-print-2", async () =>
    send({ ...c, payer: bob }, [budget, await collectInstruction(e, bob.address, 2)], [bob]),
  );
  await once("duplicate-claim-rejected", async () =>
    send(
      { ...c, payer: bob },
      [budget, await collectInstruction(e, bob.address, 3)],
      [bob],
      /already in use/,
    ),
  );
  await once("stale-number-rejected", async () =>
    send(
      { ...c, payer: carol },
      [budget, await collectInstruction(e, carol.address, 2)],
      [carol],
      /StaleNumber/,
    ),
  );
  const second = await addresses(e.program, e.creator, e.nonce, 2, bob.address);
  // Core ownership is a field in the asset: one instruction, no destination account.
  await once("transfer-print-2", async () =>
    send(
      { ...c, payer: bob },
      transferInstructions({
        owner: bob.address,
        recipient: dave.address,
        asset: second.print,
        collection: second.collection,
      }),
      [bob],
    ),
  );
  await once("transferred-owner-and-receipt", async () => {
    const raw = await account(c.endpoint, second.print);
    assert.ok(raw && raw.owner === MPL_CORE && !raw.executable, "Print #2 is not a Core asset");
    assert.equal(decodeAsset(raw.bytes).owner, dave.address);
    // The immutable shape survives the send; only the owner moved.
    assert.equal(verifyPrintAsset(raw.bytes, e, second.print, 2).uri, journal["metadata-3"]);
    assert.equal(await hasCollected(c.endpoint, e, bob.address), true);
    return "Core owner is the recipient; the sender's claim receipt is unchanged";
  });
  await once("repeat-after-transfer-rejected", async () =>
    send(
      { ...c, payer: bob },
      [budget, await collectInstruction(e, bob.address, 3)],
      [bob],
      /already in use/,
    ),
  );
  await once("collector-claims-print-3", async () =>
    send({ ...c, payer: carol }, [budget, await collectInstruction(e, carol.address, 3)], [carol]),
  );
  await once("sold-out-rejected", async () =>
    send(
      { ...c, payer: dave },
      [budget, await collectBeyondSupply(e, dave.address, 4)],
      [dave],
      /SoldOut/,
    ),
  );
  await once("solo-collect-rejected", async () =>
    send(
      { ...c, payer: dave },
      [budget, await collectBeyondSupply(solo, dave.address, 2)],
      [dave],
      /SoldOut/,
    ),
  );
  // The free-moment acceptance row: one publisher takes print #1 at publication and four
  // separate friends claim #2 to #5, each from their own wallet, with no purchase price.
  await once("publish-edition-of-five", async () =>
    send(c, [budget, await publish(five, "5")]),
  );
  const friends = [bob, carol, dave, erin] as const;
  for (const [index, friend] of friends.entries()) {
    const number = index + 2;
    await once(`five-friend-${number}-collects`, async () =>
      send(
        { ...c, payer: friend },
        [budget, await collectInstruction(five, friend.address, number)],
        [friend],
      ),
    );
  }
  await once("five-sold-out-rejected", async () =>
    send(
      { ...c, payer: frank },
      [budget, await collectBeyondSupply(five, frank.address, 6)],
      [frank],
      /SoldOut/,
    ),
  );
  await once("five-prints-and-receipts", async () => {
    for (const [number, wallet] of [
      [1, c.payer.address],
      ...friends.map((f, i) => [i + 2, f.address] as const),
    ] as const) {
      const keys = await addresses(five.program, five.creator, five.nonce, number, wallet);
      const printRaw = await account(c.endpoint, keys.print);
      assert.ok(printRaw && printRaw.owner === MPL_CORE, "Print is not a Core account");
      assert.equal(verifyPrintAsset(printRaw.bytes, five, keys.print, number).owner, wallet);
      assert.equal(await hasCollected(c.endpoint, five, wallet), true);
    }
    assert.equal(await hasCollected(c.endpoint, five, frank.address), false);
    const state = readEdition((await account(c.endpoint, five.edition))!.bytes);
    assert.equal(state.minted, 5);
    assert.equal(state.supply, 5);
    return "One publisher and four friends hold prints 1-5; a fifth friend is refused";
  });

  await once("edition-and-collection-state", async () => {
    for (const [item, key, minted] of [
      [e, "3", 3],
      [solo, "1", 1],
      [five, "5", 5],
    ] as const) {
      const raw = await account(c.endpoint, item.edition);
      assert.ok(
        raw && raw.owner === c.program.address && !raw.executable,
        "Edition account is not owned by this program",
      );
      const state = readEdition(raw.bytes);
      assert.equal(state.supply, item.supply);
      assert.equal(state.minted, minted);
      assert.equal(state.creator, item.creator);
      assert.equal(state.collection, item.collection);
      assert.equal(state.imageHash, item.imageHash);
      assert.equal(state.metadataHash, journal[`metadataHash-${key}`]);
      assert.equal(state.uri, journal[`metadata-${key}`]);
      const collectionRaw = await account(c.endpoint, item.collection);
      assert.ok(
        collectionRaw && collectionRaw.owner === MPL_CORE && !collectionRaw.executable,
        "Collection is not a Metaplex Core account",
      );
      // Decoded twice on purpose: Core wrote the plugin set the README documents, and
      // the same bytes satisfy the edition's own acceptance rule.
      const bare = decodeCollection(collectionRaw.bytes);
      assert.deepEqual(
        bare.plugins.map((p) => p.type).sort(),
        ["Attributes", "ImmutableMetadata", "MasterEdition"],
      );
      const collection = verifyEditionCollection(collectionRaw.bytes, state, item.edition);
      assert.equal(collection.numMinted, bare.numMinted);
      assert.ok(collection.numMinted >= state.minted, "Core num_minted is behind minted");
    }
    return "3/3, 1/1 and 5/5 minted; Core collections carry MasterEdition, ImmutableMetadata, Attributes";
  });
  await once("prints-and-receipts", async () => {
    for (const [number, wallet] of [
      [1, c.payer.address],
      [2, bob.address],
      [3, carol.address],
    ] as const) {
      const keys = await addresses(e.program, e.creator, e.nonce, number, wallet);
      const printRaw = await account(c.endpoint, keys.print);
      assert.ok(printRaw && printRaw.owner === MPL_CORE, "Print is not a Core account");
      const asset = verifyPrintAsset(printRaw.bytes, e, keys.print, number);
      assert.equal(asset.uri, journal["metadata-3"]);
      assert.equal(asset.name, `${e.title} #${number}`);
      // #2 was sent on; every other print is still with the wallet that claimed it.
      assert.equal(asset.owner, number === 2 ? dave.address : wallet);
      const receiptRaw = await account(c.endpoint, keys.receipt);
      assert.ok(
        receiptRaw && receiptRaw.owner === c.program.address,
        "Receipt is not owned by this program",
      );
      const receipt = readReceipt(receiptRaw.bytes);
      assert.deepEqual(
        { edition: receipt.edition, collector: receipt.collector, asset: receipt.asset, number: receipt.number },
        { edition: e.edition, collector: wallet, asset: keys.print, number },
      );
      assert.equal(await hasCollected(c.endpoint, e, wallet), true);
    }
    assert.equal(await hasCollected(c.endpoint, e, dave.address), false);
    const soloKeys = await addresses(solo.program, solo.creator, solo.nonce, 1);
    const soloRaw = await account(c.endpoint, soloKeys.print);
    assert.ok(soloRaw, "The edition of one has no print");
    assert.equal(verifyPrintAsset(soloRaw.bytes, solo, soloKeys.print, 1).owner, c.payer.address);
    return "Prints 1-3 and their receipts verified; the recipient of #2 holds no receipt";
  });
  await once("transfer-gate", async () => {
    // Read-only: the app's own send gate over the live accounts. Nothing is signed here.
    const metadataId = journal["metadata-3"].split("/").pop()!;
    const details = await inspectTransfer(
      c.endpoint,
      e,
      metadataId,
      dave.address,
      c.payer.address,
    );
    assert.equal(details.asset, (await addresses(e.program, e.creator, e.nonce, 1)).print);
    await assert.rejects(
      inspectTransfer(c.endpoint, e, metadataId, c.payer.address, c.payer.address),
      /different wallet/,
    );
    await assert.rejects(
      inspectTransfer(c.endpoint, e, metadataId, e.edition, c.payer.address),
      /personal Solana wallet/,
    );
    await assert.rejects(
      inspectTransfer(c.endpoint, e, metadataId, dave.address, bob.address),
      /does not currently own/,
    );
    return "Print #1 send gate accepts a wallet and refuses self, the edition PDA and a non-owner";
  });
  await once("published-record-loads", async () => {
    // The permanent items, fetched back through the app's own gateway reader: `arweaveBytes`
    // throws unless the retrieved bytes hash to exactly what the edition account commits to.
    for (const [item, key] of [
      [e, "3"],
      [solo, "1"],
    ] as const) {
      const state = readEdition((await account(c.endpoint, item.edition))!.bytes);
      await arweaveBytes(state.uri.split("/").pop()!, state.metadataHash);
      await arweaveBytes(item.image.split("/").pop()!, state.imageHash);
      assert.equal(state.uri, journal[`metadata-${key}`]);
      assert.equal(state.minted, item.supply, "The edition is not fully issued");
    }
    return "SHA-256 image and metadata match on both editions; 3/3 and 1/1 issued";
  });

  // ------------------------------------------------------------------ paid distribution
  // The offer acceptance. `collect` and `buy` share one receipt and one issuance path, so what is
  // proved here is that the price is the ONLY difference: a priced edition refuses the free
  // instruction, the paid one moves exactly the price to the creator, clearing the price makes
  // the free instruction work again, and a quote signed against an earlier offer is refused.
  const priced = byKey.get("offer")!;
  const offerKey = await offerAddress(priced.program, priced.edition);
  journal["offer-account"] = offerKey;
  save();
  await once("publish-priced-edition", async () =>
    send(c, [budget, await publish(priced, "offer")]),
  );
  await once("set-offer-price", async () => {
    const signature = await send(c, [budget, await setOfferInstruction(priced, PRICE)]);
    const live = await readOfferAccount(c.endpoint, priced.program, priced.edition);
    assert.ok(live, "The offer account was not written");
    assert.equal(live.priceLamports, PRICE, "The stored price is not the one that was set");
    assert.equal(live.revision, 1, "The first set_offer writes revision 1, never 0");
    assert.equal(live.creator, c.payer.address, "The offer names another creator");
    return `${signature}; ${offerKey} priced at ${PRICE} lamports, revision 1`;
  });
  // The whole reason `collect` grew an account: without it, the free instruction would be the
  // bypass around every price this program can set.
  await once("priced-collect-refused", async () =>
    send(
      { ...c, payer: grace },
      [budget, await collectInstruction(priced, grace.address, 2)],
      [grace],
      /PaymentRequired/,
    ),
  );
  await once("buy-print-2", async () => {
    const signature = await send(
      { ...c, payer: grace },
      [budget, await buyInstruction(priced, grace.address, 2, PRICE, 1)],
      [grace],
    );
    // A send can confirm while its RPC response is lost. Comparing fresh getBalance reads on
    // retry would then report zero; the receipt proves this transaction's exact payment instead.
    const receipt = await request<any>(c.endpoint, "getTransaction", [signature,
      { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    const proceeds = verifyCreatorProceeds(receipt, signature, c.payer.address, PRICE);
    return `${signature}; creator +${proceeds} lamports (confirmed transaction balances)`;
  });
  await once("bought-print-and-receipt", async () => {
    const keys = await addresses(priced.program, priced.creator, priced.nonce, 2, grace.address);
    const printRaw = await account(c.endpoint, keys.print);
    assert.ok(printRaw && printRaw.owner === MPL_CORE, "The bought print is not a Core account");
    const asset = verifyPrintAsset(printRaw.bytes, priced, keys.print, 2);
    assert.equal(asset.owner, grace.address, "The buyer does not own the print they paid for");
    assert.equal(asset.uri, journal["metadata-offer"]);
    const receiptRaw = await account(c.endpoint, keys.receipt);
    assert.ok(receiptRaw && receiptRaw.owner === c.program.address, "No receipt for the buyer");
    const receipt = readReceipt(receiptRaw.bytes);
    assert.deepEqual(
      { edition: receipt.edition, collector: receipt.collector, asset: receipt.asset, number: receipt.number },
      { edition: priced.edition, collector: grace.address, asset: keys.print, number: 2 },
    );
    assert.equal(await hasCollected(c.endpoint, priced, grace.address), true);
    return "A bought copy is the same object as a collected one, with the same permanent receipt";
  });
  await once("set-offer-free", async () => {
    const signature = await send(c, [budget, await setOfferInstruction(priced, 0n)]);
    const live = await readOfferAccount(c.endpoint, priced.program, priced.edition);
    assert.ok(live, "The offer account disappeared");
    assert.equal(live.priceLamports, 0n, "The price was not cleared");
    assert.equal(live.revision, 2, "revision must rise on every set_offer");
    // Zero and absent are the same fact to every caller outside the creator's price screen.
    assert.equal(pricedOffer(live), null, "A zero price must read as no price at all");
    return `${signature}; ${offerKey} cleared to 0, revision 2`;
  });
  await once("free-buy-refused", async () =>
    send(
      { ...c, payer: ivan },
      [budget, await buyInstruction(priced, ivan.address, 3, PRICE, 2)],
      [ivan],
      /NotForSale/,
    ),
  );
  await once("free-collect-after-clearing", async () =>
    send(
      { ...c, payer: heidi },
      [budget, await collectInstruction(priced, heidi.address, 3)],
      [heidi],
    ),
  );
  // A stale quote can only be refused as OfferChanged while there IS a price: with the offer at
  // zero the program answers NotForSale first (`price_lamports > 0` is checked before the
  // revision). So the price is moved once more, and the refused quote names the FIRST offer.
  await once("set-offer-reprice", async () => {
    const signature = await send(c, [budget, await setOfferInstruction(priced, PRICE * 2n)]);
    const live = await readOfferAccount(c.endpoint, priced.program, priced.edition);
    assert.ok(live, "The offer account disappeared");
    assert.equal(live.priceLamports, PRICE * 2n, "The new price was not stored");
    assert.equal(live.revision, 3, "revision must rise on every set_offer");
    return `${signature}; ${offerKey} repriced to ${PRICE * 2n} lamports, revision 3`;
  });
  await once("stale-revision-buy-refused", async () =>
    // Both halves of the quote are stale: the old price and revision 1. The offer checks run
    // before issuance, so this is refused for the reason it is sent, not because the edition
    // has since sold out.
    send(
      { ...c, payer: ivan },
      [budget, await buyInstruction(priced, ivan.address, 3, PRICE, 1)],
      [ivan],
      /OfferChanged/,
    ),
  );
  await once("priced-edition-state", async () => {
    const raw = await account(c.endpoint, priced.edition);
    assert.ok(raw && raw.owner === c.program.address, "The priced edition changed owner");
    const state = readEdition(raw.bytes);
    // The point of a separate Offer account: three price changes and a sale, and the sealed
    // commitment is byte for byte what `publish` wrote.
    assert.equal(state.supply, priced.supply);
    assert.equal(state.minted, 3, "Creator #1, a bought #2 and a free #3");
    assert.equal(state.uri, journal["metadata-offer"]);
    assert.equal(state.metadataHash, journal["metadataHash-offer"]);
    assert.equal(state.imageHash, priced.imageHash);
    assert.equal(state.creator, c.payer.address);
    assert.equal(await hasCollected(c.endpoint, priced, heidi.address), true);
    assert.equal(await hasCollected(c.endpoint, priced, ivan.address), false);
    return "Three price changes and one sale left the edition commitment untouched; 3/3 issued";
  });

  // The album acceptance. Everything above is v1 plus offers; this exercises the album
  // instructions, which seal a collection into a Core group the creator owns.
  //
  // No generated keypair: the album is a program PDA signed with `invoke_signed`, exactly
  // like every other account a publication creates. The wallet is the only signer.
  // Keep the same album after an interrupted acceptance command. `once` may already have
  // confirmed its creation; a new nonce would point later publishes at an empty PDA while
  // skipping creation because the old step is complete.
  const albumNonce = journal["album-nonce"] ?? randomBytes(32).toString("hex");
  const create = await createAlbumInstruction({
    program: c.program.address,
    creator: c.payer.address,
    nonce: albumNonce,
    name: "DEVNET weekend album",
  });
  const groupAddress = String(create.accounts![1].address);
  journal["album-nonce"] = albumNonce;
  journal["album-group"] = groupAddress;
  save();
  await once("create-album", async () => send(c, [budget, create]));
  const members = [byKey.get("album-a")!, byKey.get("album-b")!];
  for (const [item, key] of [
    [members[0], "album-a"],
    [members[1], "album-b"],
  ] as const) {
    assert.ok(item, "Album member metadata was not prepared");
    assert.ok(journal[`metadata-${key}`], "Album member upload is missing");
    await once(`publish-${key}-in-album`, async () =>
      send(c, [budget, await publish(item, key, groupAddress)]),
    );
  }
  await once("album-lists-two-free-moments", async () => {
    const read = await readAlbum(c.endpoint, groupAddress, "devnet");
    assert.equal(read.authority, c.payer.address, "The creator keeps the album authority");
    assert.equal(read.publicUrl, albumUrl(groupAddress, "devnet"));
    assert.equal(read.conforming, true, read.reason ?? "The album does not conform");
    const raw = await account(c.endpoint, groupAddress);
    assert.ok(raw && raw.owner === MPL_CORE, "The album is not a Core group");
    const group = verifyAlbumGroup(raw.bytes);
    assert.deepEqual(
      [...group.collections].sort(),
      members.map((m) => m.collection).sort(),
      "The album does not list exactly its two members",
    );
    for (const member of members) {
      const state = readEdition((await account(c.endpoint, member.edition))!.bytes);
      assert.equal(state.supply, 2);
      assert.equal(state.minted, 1, "The publisher's own print #1 is live");
      const collectionRaw = await account(c.endpoint, member.collection);
      assert.ok(collectionRaw, "An album member has no Core collection");
      // The app's reader requires evidence from the group account, not just the collection's
      // Groups plugin. Pass the membership we read and compared above; missing evidence fails.
      assert.throws(() => verifyEditionCollection(collectionRaw.bytes, state, member.edition),
        /album that does not list it/);
      verifyEditionCollection(collectionRaw.bytes, state, member.edition,
        { group: read.group, collections: group.collections });
    }
    return `Album ${groupAddress} lists two free editions, both readable`;
  });

  // ------------------------------------------------------------------ Seeker Genesis Token
  // The sealed publish. The devnet program build carries this acceptance's test authority in
  // place of Solana Mobile's, and the fixture mints what that authority would have: a member
  // mint with an SGT's three properties, held frozen by the publisher. The program must refuse a
  // mint without those properties, another wallet's account, an empty account of the publisher's
  // own and a mint handed over without its account, and when the accounts are right it must seal
  // the mint into the collection's locked attributes, where the app's reader finds it.
  const keys = await devnetGenesisKeys();
  const member = c.genesisMember;
  assert.ok(member, "The Genesis Token member mint was not generated with the test metadata");
  const sealed = byKey.get("genesis")!;
  assert.equal(sealed.genesisMint, member.address, "The sealed edition's document names another mint");
  c.genesisEmpty ??= await generateKeyPairSigner();
  const empty = c.genesisEmpty;
  journal["genesis-authority"] = keys.authority.address;
  journal["genesis-group"] = keys.group.address;
  journal["genesis-mint"] = member.address;
  save();
  await once("genesis-group-mint", async () => {
    const instructions = await groupInstructions(c, keys);
    if (!instructions.length) return `${keys.group.address} already exists on devnet`;
    return send(c, instructions, [c.payer, keys.group, keys.authority]);
  });
  await once("genesis-member-mint", async () =>
    send(c, await memberInstructions(c, keys, member), [c.payer, member, keys.authority]),
  );
  await once("genesis-foil-accounts", async () =>
    send(
      c,
      await foilInstructions(c, keys, member.address, bob.address, empty),
      [c.payer, empty, keys.authority],
    ),
  );
  await once("genesis-member-reads-as-the-stand-in", async () => {
    await assertMemberDecodes(c, member.address);
    return "The client's decoder accepts the member mint under the devnet addresses and refuses it under Solana Mobile's";
  });
  const held = await genesisTokenAccount(c.payer.address, member.address);
  const theirs = await genesisTokenAccount(bob.address, member.address);
  journal["genesis-token-account"] = held;
  save();
  // `publish` with its last two accounts replaced: the refusals the client itself never builds.
  const withGenesis = async (mint: string, token: string | null) => {
    const template = await publish(sealed, "genesis");
    const readonly = (a: string) => ({ address: address(a), role: AccountRole.READONLY });
    return {
      ...template,
      accounts: [...template.accounts!.slice(0, -2), readonly(mint), readonly(token ?? c.program.address)],
    };
  };
  await once("genesis-foreign-mint-refused", async () =>
    send(c, [budget, await withGenesis(keys.group.address, held)], [c.payer], /InvalidGenesisToken/),
  );
  await once("genesis-other-wallets-account-refused", async () =>
    send(c, [budget, await withGenesis(member.address, theirs)], [c.payer], /InvalidGenesisToken/),
  );
  await once("genesis-empty-account-refused", async () =>
    send(c, [budget, await withGenesis(member.address, empty.address)], [c.payer], /InvalidGenesisToken/),
  );
  await once("genesis-mint-without-account-refused", async () =>
    send(c, [budget, await withGenesis(member.address, null)], [c.payer], /InvalidGenesisToken/),
  );
  await once("publish-sealed-genesis", async () =>
    send(c, [
      budget,
      await instruction(
        sealed, c.payer.address, 1, journal["metadata-genesis"], journal["metadataHash-genesis"],
        undefined, { mint: member.address, token: held },
      ),
    ]),
  );
  await once("sealed-genesis-attribute", async () => {
    const state = readEdition((await account(c.endpoint, sealed.edition))!.bytes);
    const collectionRaw = await account(c.endpoint, sealed.collection);
    assert.ok(collectionRaw && collectionRaw.owner === MPL_CORE, "The sealed edition has no Core collection");
    const collection = verifyEditionCollection(collectionRaw.bytes, state, sealed.edition);
    assert.equal(sealedGenesisMint(collection), member.address, "The collection does not seal the member mint");
    const attributes = decodeCollection(collectionRaw.bytes).plugins.find((p) => p.type === "Attributes");
    assert.ok(attributes && attributes.type === "Attributes", "No Attributes plugin");
    assert.equal(attributes.attributes.length, 6, "The sealed collection carries the five attributes plus one");
    assert.deepEqual(attributes.attributes[5], { key: GENESIS_ATTRIBUTE, value: member.address });
    // The editions published without the accounts seal nothing, and read that way.
    const plainState = readEdition((await account(c.endpoint, e.edition))!.bytes);
    const plain = verifyEditionCollection((await account(c.endpoint, e.collection))!.bytes, plainState, e.edition);
    assert.equal(sealedGenesisMint(plain), null, "A plain edition must seal no Genesis Token");
    const publication = await readPublication(c.endpoint, c.program.address, sealed.edition);
    assert.equal(publication?.sealedGenesis, member.address, "readPublication does not report the seal");
    assert.equal(state.minted, 1);
    return `${sealed.collection} seals ${GENESIS_ATTRIBUTE} = ${member.address}; the plain editions seal none`;
  });
  save();
  console.log("DEVNET LIFECYCLE COMPLETE");
}
