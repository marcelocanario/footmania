const locks = new Map<number, Promise<unknown>>();

export function withSaveLock<T>(saveId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(saveId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    saveId,
    next.catch(() => {})
  );
  return next;
}
