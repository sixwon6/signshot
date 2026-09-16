/** Disposable devnet-only session. Private keys exist only in this process. */
import { generateKeyPairSigner } from "@solana/kit";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { request } from "../rpc";
import {
  FAUCET_MAX,
  WALLET_WORK,
  balanceOf,
  guard,
  sessionBudget,
  walletFunding,
  type Context,
} from "./work";

const endpoint = "https://api.devnet.solana.com";
const payer = await generateKeyPairSigner();
const program = await generateKeyPairSigner();
const buffer = await generateKeyPairSigner();
// One disposable collector wallet per row of WALLET_WORK: the five of the free acceptance
// (one publisher plus four friends, and the wallet that is only ever refused) and the three the
// paid case added — the buyer, the wallet that collects free once the price is cleared, and the
// wallet whose stale quote is refused.
const collectors = await Promise.all(
  WALLET_WORK.map(() => generateKeyPairSigner()),
);
const reportRoot = resolve(".expo", "devnet", program.address);
mkdirSync(reportRoot, { recursive: true });
const context: Context = {
  endpoint,
  payer,
  program,
  buffer,
  collectors,
  reportRoot,
  sendJournal: {},
};
const isolatedRoot = resolve(
  tmpdir(),
  `seedshot-devnet-editions-${program.address}`,
);
let faucetRequested = false;
writeFileSync(
  ".expo/devnet-session-public.json",
  JSON.stringify(
    {
      cluster: "devnet",
      payer: payer.address,
      program: program.address,
      buffer: buffer.address,
      collectors: collectors.map((s, index) => ({
        role: WALLET_WORK[index].name,
        address: s.address,
        funding: walletFunding(index),
      })),
      reportRoot,
      isolatedRoot,
      privateKeys: "Process memory only; stopping loses test upgrade authority",
    },
    null,
    2,
  ),
);
console.log("DEVNET SESSION", payer.address, "program", program.address);
console.log(
  "Reports:",
  reportRoot,
  "\nCommands: prepare, fund, balance, deploy, test, exit",
);
const lines = createInterface({ input: process.stdin, terminal: false });
for await (const command of lines) {
  try {
    if (command === "fund") {
      await guard(context);
      assert.ok(
        !faucetRequested,
        "This session already requested its one faucet allocation; check balance instead",
      );
      // Compute the faucet target from this session's ELF and live rent; a remembered amount
      // cannot account for changes in either the program size or the cluster's rent schedule.
      assert.ok(
        context.artifact,
        "Run prepare first: the amount to ask for depends on the size of the built program",
      );
      const budget = await sessionBudget(context, context.artifact.bytes);
      const balance = await balanceOf(context, payer.address);
      assert.ok(balance < budget.total, "This session is already funded for the whole run");
      faucetRequested = true; // A lost response must not trigger another allocation.
      const intent = {
        requestedAt: new Date().toISOString(),
        budget,
        balance,
        requestedLamports: Math.min(budget.total - balance, FAUCET_MAX),
      };
      writeFileSync(
        join(reportRoot, "faucet.json"),
        JSON.stringify(intent, null, 2),
      );
      let signature: string;
      try {
        signature = await request<string>(endpoint, "requestAirdrop", [
          payer.address,
          intent.requestedLamports,
        ]);
      } catch (error) {
        writeFileSync(
          join(reportRoot, "faucet.json"),
          JSON.stringify(
            {
              ...intent,
              error: String(error),
              allocation:
                "Unknown; check balance without making another request",
            },
            null,
            2,
          ),
        );
        throw error;
      }
      writeFileSync(
        join(reportRoot, "faucet.json"),
        JSON.stringify({ ...intent, signature }, null, 2),
      );
      console.log("Faucet:", signature, "for", intent.requestedLamports, "lamports");
      console.log(
        "This run needs",
        budget.total,
        "lamports in total; use `balance` and, if it is short, fund",
        payer.address,
        "from EXISTING DEVNET SOL. Never substitute mainnet funds.",
      );
    } else if (command === "prepare") {
      assert.ok(
        !context.artifact && !context.initialized,
        "This session already has a prepared build",
      );
      const child = spawn(
        "pwsh",
        [
          "-NoProfile",
          "-File",
          resolve("programs/editions/scripts/prepare-devnet-windows.ps1"),
          "-ProgramAddress",
          program.address,
          "-OutputRoot",
          isolatedRoot,
        ],
        { stdio: ["ignore", "inherit", "inherit"], windowsHide: true },
      );
      const code = await new Promise<number | null>((accept, reject) => {
        child.once("error", reject);
        child.once("exit", accept);
      });
      assert.equal(
        code,
        0,
        "Isolated preparation failed; no artifact accepted",
      );
      const prepared = JSON.parse(
        readFileSync(join(isolatedRoot, "prepared.json"), "utf8"),
      );
      assert.equal(prepared.program, program.address);
      assert.equal(prepared.cluster, "devnet");
      // The isolated copy is the only thing this session may deploy or publish: a manifest
      // pointing back at the shared source tree, or missing its own evidence, is refused.
      for (const key of ["sourcePath", "binaryPath", "imagePath"] as const)
        assert.ok(
          resolve(prepared[key]).startsWith(isolatedRoot + sep),
          `prepared.json ${key} is outside the isolated build`,
        );
      assert.match(prepared.binaryPath, /era_editions\.so$/);
      for (const key of ["sha256", "imageHash", "sharedSourceSha256"] as const)
        assert.match(prepared[key], /^[a-f0-9]{64}$/, `prepared.json ${key} is not a digest`);
      for (const key of ["bytes", "imageBytes"] as const)
        assert.ok(
          Number.isSafeInteger(prepared[key]) && prepared[key] > 0,
          `prepared.json ${key} is not a byte count`,
        );
      context.artifact = prepared;
      writeFileSync(
        join(reportRoot, "prepared.json"),
        JSON.stringify(prepared, null, 2),
      );
      console.log("ELF:", prepared.bytes, "bytes; SHA-256", prepared.sha256);
    } else if (command === "balance") {
      const balance = await balanceOf(context, payer.address);
      console.log("Balance:", balance, "lamports");
      if (context.artifact) {
        const budget = await sessionBudget(context, context.artifact.bytes);
        console.log("Needed: ", JSON.stringify(budget));
        console.log(
          context.deployed
            ? "Program deployed. This balance is remaining test funds; do not fund the original deployment budget again."
            : context.initialized
            ? "Program rent is already held in the upload buffer. Resume deploy; do not fund the original budget again."
            : balance >= budget.total
            ? "Funded: deploy and test both fit."
            : `Short by ${budget.total - balance} lamports; fund ${payer.address} from existing devnet SOL.`,
        );
      }
    } else if (command === "deploy" || command === "test") {
      const module = await import(`./work.ts?run=${Date.now()}`);
      await module[command](context);
    } else if (command === "exit") break;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
}
lines.close();
// The interactive stdin handle can otherwise keep a Windows process (and its
// disposable keys) alive after the command loop ends. All work was awaited.
process.exit(0);
