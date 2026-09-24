/**
 * One-at-a-time per key, within this process.
 *
 * For a check-then-act sequence whose check and act are separate queries — "is
 * a project registered here? no: create one" — where two concurrent callers
 * would otherwise both see "no" and both act. Callers with different keys never
 * wait on each other; callers with the same key run in arrival order.
 *
 * In-process on purpose: the API runs as one process against its database, so
 * this is the smallest guard that closes the race. Running several API
 * processes against one database would need a database-level lock instead.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // A failure of the previous holder is its caller's to handle, not ours.
    const result = previous.catch(() => undefined).then(fn);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);

    try {
      return await result;
    } finally {
      // Only the last in line clears the entry, so the map does not grow with
      // every key ever seen.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
