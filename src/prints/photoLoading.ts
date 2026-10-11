/** Results in library order, with at most 3 reads in flight. */
export async function loadPhotoEntries<T, R>(
  records: readonly T[],
  read: (record: T) => Promise<R>,
  isCurrent: () => boolean,
): Promise<R[]> {
  const entries = new Array<R>(records.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, records.length) }, async () => {
    while (cursor < records.length) {
      if (!isCurrent()) throw new Error("Photo load cancelled.");
      const index = cursor++;
      entries[index] = await read(records[index]);
    }
  }));
  return entries;
}

/** Show all local records first, then deliver each refreshed status as it arrives. */
export async function loadPhotosInStages<T, R>(options: {
  records: readonly T[];
  readLocal(record: T): Promise<R>;
  showLocal(entries: R[]): void;
  refresh(entry: R): Promise<R>;
  showFresh(entry: R): void;
  isCurrent(): boolean;
}): Promise<void> {
  const local = await loadPhotoEntries(options.records, options.readLocal, options.isCurrent);
  if (!options.isCurrent()) return;
  options.showLocal(local);
  await loadPhotoEntries(local, async (entry) => {
    const fresh = await options.refresh(entry);
    if (options.isCurrent()) options.showFresh(fresh);
    return fresh;
  }, options.isCurrent);
}
