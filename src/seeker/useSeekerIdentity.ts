import { useCallback, useEffect, useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createSerialQueue } from "../serial";
import type { Address } from "@solana/kit";
import { useMobileWallet } from "@wallet-ui/react-native-kit";

import { getMainnetReadRpc } from "../solana/cluster";
import { rpcWithTimeout } from "../../publications/rpc";
import { findSeekerGenesisToken } from "./genesisToken";
import { resolveSkrName } from "./skrName";
import { safeErrorText } from "../ui/errorText";

/**
 * The connected wallet's Seeker facts (SGT, `.skr` name) in one app-wide store, cached for a day
 * because the public RPC throttles `getProgramAccounts`. A failed half keeps its last value and is
 * never recorded as "none" (`undefined` = unknown). Disconnect clears this cache.
 *
 * Both facts exist on mainnet only, so they are always read from mainnet (`getMainnetReadRpc`),
 * whatever cluster this build publishes on: the wallet address is the same keypair on every
 * cluster, so no wallet interaction is involved. Display only. A failure here is a line in
 * Settings and never reaches the camera, publishing or collecting.
 */

interface SeekerIdentity {
  /** The wallet these facts are about, or null when no wallet is connected. */
  wallet: string | null;
  /** SGT mint held by `wallet`; null = checked, none; undefined = not successfully checked. */
  sgtMint: string | null | undefined;
  /** `.skr` name of `wallet`; null = checked, none; undefined = not successfully checked. */
  skrName: string | null | undefined;
  /** A lookup for `wallet` is running right now. */
  checking: boolean;
  /** Last lookup error for `wallet`, display-ready; null after a fully successful lookup. */
  error: string | null;
  refresh(): Promise<void>;
}

interface CacheEntry {
  wallet: string;
  sgtMint?: string | null;
  sgtCheckedAtMs?: number;
  skrName?: string | null;
  skrCheckedAtMs?: number;
}

const CACHE_KEY = "seeker.identity.v2";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UNAVAILABLE = "SEEKER DETAILS UNAVAILABLE — TRY AGAIN";

// ---- store ---------------------------------------------------------------------------------

interface State {
  wallet: string | null;
  entry: CacheEntry | null;
  error: string | null;
}

let state: State = { wallet: null, entry: null, error: null };
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<void>>();
/** Serializes AsyncStorage traffic for the one cache key. */
const withCache = createSerialQueue();

function emit(): void {
  for (const l of listeners) l();
}

function setState(patch: Partial<State>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): State {
  return state;
}

async function readCache(): Promise<CacheEntry | null> {
  return withCache(async () => {
    try {
      const raw = await AsyncStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as Partial<CacheEntry>;
      if (typeof p.wallet !== "string") return null;
      const out: CacheEntry = { wallet: p.wallet };
      if (typeof p.sgtCheckedAtMs === "number" && (p.sgtMint === null || typeof p.sgtMint === "string")) {
        out.sgtMint = p.sgtMint;
        out.sgtCheckedAtMs = p.sgtCheckedAtMs;
      }
      if (typeof p.skrCheckedAtMs === "number" && (p.skrName === null || typeof p.skrName === "string")) {
        out.skrName = p.skrName;
        out.skrCheckedAtMs = p.skrCheckedAtMs;
      }
      return out;
    } catch {
      return null;
    }
  });
}

function writeCache(entry: CacheEntry): Promise<void> {
  return withCache(() => AsyncStorage.setItem(CACHE_KEY, JSON.stringify(entry))).catch(() => {});
}

function clearCache(): Promise<void> {
  return withCache(() => AsyncStorage.removeItem(CACHE_KEY)).catch(() => {});
}

function messageOf(e: unknown): string {
  // Through the filter first: this line renders in Settings, and an RPC failure quotes the
  // endpoint URL, which on a keyed provider carries the key.
  const t = safeErrorText(e, "LOOKUP FAILED");
  if (/429|Too Many Requests|rate/i.test(t)) return "RPC RATE LIMITED — TRY AGAIN IN A MINUTE";
  // Offline, DNS, TLS, a blocked IP (403) or the 20 s deadline: mainnet could not be asked.
  if (/network request failed|fetch failed|did not answer in time|abort|HTTP error|403/i.test(t))
    return UNAVAILABLE;
  return t.toUpperCase().slice(0, 96);
}

function isFresh(at: number | undefined, now: number): boolean {
  return typeof at === "number" && now - at < MAX_AGE_MS;
}

/** Runs the lookup for `target` unless one is already running. Safe to call often. */
function lookup(target: string, force: boolean): Promise<void> {
  const running = inFlight.get(target);
  if (running) return running;
  const task = (async () => {
    const now = Date.now();
    const previous = (await readCache()) ?? null;
    const base: CacheEntry = previous?.wallet === target ? previous : { wallet: target };
    const needSgt = force || !isFresh(base.sgtCheckedAtMs, now);
    const needSkr = force || !isFresh(base.skrCheckedAtMs, now);
    if (!needSgt && !needSkr) {
      if (state.wallet === target) setState({ entry: base, error: null });
      return;
    }
    const rpc = getMainnetReadRpc();
    // `target` is already a kit `Address`; it only lost the brand in this store's `string` state.
    const owner = target as Address;
    const [sgt, skr] = await Promise.allSettled([
      needSgt
        ? rpcWithTimeout((signal) => findSeekerGenesisToken(rpc, owner, signal))
        : Promise.resolve(undefined),
      needSkr
        ? rpcWithTimeout((signal) => resolveSkrName(rpc, owner, signal))
        : Promise.resolve(undefined),
    ]);
    const next: CacheEntry = { ...base };
    let error: string | null = null;
    if (sgt.status === "fulfilled") {
      if (sgt.value !== undefined) {
        next.sgtMint = sgt.value ?? null;
        next.sgtCheckedAtMs = Date.now();
      }
    } else {
      error = messageOf(sgt.reason);
    }
    if (skr.status === "fulfilled") {
      if (skr.value !== undefined) {
        next.skrName = skr.value;
        next.skrCheckedAtMs = Date.now();
      }
    } else {
      error = error ?? messageOf(skr.reason);
    }
    // State first, disk after: a storage hiccup must not discard a good answer. Both are skipped
    // if the wallet changed meanwhile, so a late lookup cannot undo a disconnect's `clearCache()`.
    if (state.wallet !== target) return;
    setState({ entry: next, error });
    await writeCache(next);
  })().finally(() => {
    inFlight.delete(target);
    emit();
  });
  inFlight.set(target, task);
  emit();
  return task;
}

/** Called when the connected wallet changes. Serves the cache, then refreshes what is stale. */
async function setWallet(wallet: string | null): Promise<void> {
  if (wallet === state.wallet) return;
  if (wallet === null) {
    setState({ wallet: null, entry: null, error: null });
    await clearCache();
    return;
  }
  setState({ wallet, entry: null, error: null });
  const cached = await readCache();
  if (state.wallet !== wallet) return; // switched again while reading
  if (cached?.wallet === wallet) setState({ entry: cached });
  void lookup(wallet, false);
}

// ---- hook ----------------------------------------------------------------------------------

/**
 * @param enabled false: read whatever the store knows, but never start a lookup from this mount.
 */
export function useSeekerIdentity(enabled: boolean = true): SeekerIdentity {
  const { account } = useMobileWallet();
  const wallet: string | null = account?.address ?? null;
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!enabled) return;
    void setWallet(wallet);
  }, [wallet, enabled]);

  const refresh = useCallback(async () => {
    if (wallet !== null) await lookup(wallet, true);
  }, [wallet]);

  // The store may lag one render behind a wallet change; report against the wallet the caller
  // actually has, and never another wallet's facts.
  const known = snap.wallet === wallet && snap.entry !== null && snap.entry.wallet === wallet;
  const entry = known ? snap.entry : null;
  return {
    wallet,
    sgtMint: wallet === null ? null : entry?.sgtMint,
    skrName: wallet === null ? null : entry?.skrName,
    checking: wallet !== null && inFlight.has(wallet),
    error: known ? snap.error : null,
    refresh,
  };
}
