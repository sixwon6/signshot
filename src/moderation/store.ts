/**
 * The app's side of `core.ts`: the terms agreement and the block list in AsyncStorage, and the
 * moderation list read over the network, held in one module-level store so a Block on the
 * Collect sheet is already in force on the Wallet screen behind it.
 *
 * Both stored values are per phone, not per wallet: the agreement is the person's, and a block
 * is about whose pictures this phone shows. Neither ever leaves the phone.
 */
import { useEffect, useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  MODERATION_TTL_MS,
  MODERATION_URL,
  TERMS_VERSION,
  fetchModerationList,
  readBlockList,
  termsAgreed,
  veilOf,
  withBlocked,
  type ModerationList,
  type Veil,
} from "./core";

const TERMS_KEY = "es.terms-agreed";
const BLOCKED_KEY = "es.blocked-creators.v1";

type State = {
  /** `null` until storage has answered. */
  terms: boolean | null;
  blocked: ReadonlySet<string>;
  /** The last list that parsed; `null` shows everything. */
  list: ModerationList | null;
};
let state: State = { terms: null, blocked: new Set(), list: null };
const listeners = new Set<() => void>();
function update(next: Partial<State>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// Read once, at import, so the first sheet opened already knows the answer. An unreadable store
// asks for the terms again and blocks nobody.
const stored = Promise.all([
  AsyncStorage.getItem(TERMS_KEY).catch(() => null),
  AsyncStorage.getItem(BLOCKED_KEY).catch(() => null),
]).then(([terms, blocked]) =>
  update({
    terms: state.terms === true || termsAgreed(terms),
    blocked: new Set(readBlockList(blocked)),
  }),
);

let listReadAt = 0;
let listReading = false;
/** Re-read the list when it is older than its TTL. A failed read keeps the last good one. */
function refreshList() {
  if (listReading || Date.now() - listReadAt < MODERATION_TTL_MS) return;
  listReading = true;
  void fetchModerationList(MODERATION_URL).then((list) => {
    listReadAt = Date.now();
    listReading = false;
    if (list) update({ list });
  });
}

async function agree() {
  update({ terms: true });
  await AsyncStorage.setItem(TERMS_KEY, String(TERMS_VERSION)).catch(() => {});
}

/** Block or unblock a publisher. In force at once; stored best effort. */
async function setBlocked(creator: string, blocked: boolean) {
  await stored;
  const next = withBlocked(state.blocked, creator, blocked);
  update({ blocked: new Set(next) });
  await AsyncStorage.setItem(BLOCKED_KEY, JSON.stringify(next)).catch(() => {});
}

/** `agreed` is `null` while storage is being read. */
export function useTermsAgreement(): { agreed: boolean | null; agree(): Promise<void> } {
  const agreed = useSyncExternalStore(subscribe, () => state.terms);
  return { agreed, agree };
}

export function useModeration(): {
  /** What stands in for this publication. `viewer`'s own publications are never veiled. */
  veil(edition: string, creator: string, viewer?: string | null): Veil;
  isBlocked(creator: string): boolean;
  setBlocked(creator: string, blocked: boolean): Promise<void>;
} {
  const { blocked, list } = useSyncExternalStore(subscribe, () => state);
  useEffect(refreshList, []);
  return {
    veil: (edition, creator, viewer) =>
      viewer && viewer === creator ? null : veilOf(edition, creator, list, blocked),
    isBlocked: (creator) => blocked.has(creator),
    setBlocked,
  };
}
