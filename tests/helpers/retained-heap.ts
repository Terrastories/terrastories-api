/** Sample live JS heap only after pending callbacks and garbage collection. */
export async function retainedHeapUsed(): Promise<number> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Retained-heap tests require a fork with --expose-gc');
  }

  // Injection/filesystem cleanup can finish on the next event-loop turn.
  await new Promise<void>((resolve) => setImmediate(resolve));
  globalThis.gc();
  await new Promise<void>((resolve) => setImmediate(resolve));
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}
