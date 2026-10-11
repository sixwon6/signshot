import { useEffect, useState } from "react";
import type { StoragePayment } from "../../publications/storage";
import type { CoreDraft } from "../../publications/types";
import { canPayStorage, quoteStorageTopUp } from "./creator";

/** The storage payment quote while `canPayStorage` holds; null otherwise or until priced. */
export function useStorageTopUp(draft: CoreDraft | null | undefined): StoragePayment | null {
  const key = draft && canPayStorage(draft)
    ? `${draft.edition.edition}:${draft.storageError?.message}:${draft.storageFunding}:${draft.storageTopUp?.signature}`
    : null;
  const [quote, setQuote] = useState<{ key: string; value: StoragePayment | null } | null>(null);

  useEffect(() => {
    if (!draft || !key) return;
    let live = true;
    quoteStorageTopUp(draft).then(
      (value) => {
        if (live) setQuote({ key, value });
      },
      () => {
        if (live) setQuote({ key, value: null });
      },
    );
    return () => {
      live = false;
    };
    // `key` names everything the quote reads; the draft object is re-created on every read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return key && quote?.key === key ? quote.value : null;
}
