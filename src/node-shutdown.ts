/** Graceful shutdown for the Node listener (testable without a process). */

/** Track a promise until it settles; the original promise is returned. */
export function trackInFlight<T>(
  set: Set<Promise<void>>,
  work: Promise<T>
): Promise<T> {
  const tracked: Promise<void> = work
    .then(
      () => undefined,
      () => undefined
    )
    .then(() => {
      set.delete(tracked);
    });
  set.add(tracked);
  return work;
}

/** Wrap a fetch handler so shutdown can await requests that outlive their socket. */
export function trackedFetch<A extends unknown[], R>(
  inFlight: Set<Promise<void>>,
  fetch: (...args: A) => R | Promise<R>
): (...args: A) => Promise<R> {
  return (...args) => trackInFlight(inFlight, Promise.resolve(fetch(...args)));
}

export interface ShutdownDeps {
  server: {
    close(callback: () => void): unknown;
    closeAllConnections?(): void;
  };
  /** Request handlers and sweeps still running; awaited before closeDb. */
  inFlight: Set<Promise<void>>;
  closeDb: () => Promise<void>;
  stopTimers: () => void;
  drainMs: number;
  exit: (code: number) => void;
  log: (message: string) => void;
}

/**
 * Stop accepting connections, wait for open connections AND handlers that
 * outlive their socket, then close the database and exit 0. Past drainMs the
 * connections are cut and the exit code is 1.
 */
export function createShutdown(deps: ShutdownDeps): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    deps.stopTimers();
    const deadline = setTimeout(() => {
      deps.log('shutdown: drain deadline exceeded, forcing exit');
      deps.server.closeAllConnections?.();
      deps.exit(1);
    }, deps.drainMs);
    deps.server.close(() => {
      void Promise.allSettled([...deps.inFlight])
        .then(() => deps.closeDb())
        .then(() => {
          clearTimeout(deadline);
          deps.log('shutdown: database closed');
          deps.exit(0);
        })
        .catch(() => deps.exit(1));
    });
  };
}
