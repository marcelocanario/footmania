const locks = new Map<number, Promise<unknown>>();
let globalLock: Promise<unknown> = Promise.resolve();

export function withSaveLock<T>(saveId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(saveId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    saveId,
    next.catch(() => {})
  );
  return next;
}

/** Serialize all global-world mutations through one lock. */
export function withGlobalLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = globalLock.then(fn, fn);
  globalLock = next.catch(() => {});
  return next;
}
