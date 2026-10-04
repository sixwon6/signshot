/** One operation per photo, edition or copy at a time, in this process. */
const running = new Set<string>();
export const operationInProgress = (key: string) => running.has(key);
export async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  if (running.has(key)) throw new Error("This photo already has an operation in progress.");
  running.add(key);
  try {
    return await work();
  } finally {
    running.delete(key);
  }
}
