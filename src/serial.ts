/** Independent FIFO queue; a failed operation rejects its caller without blocking later work. */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}
