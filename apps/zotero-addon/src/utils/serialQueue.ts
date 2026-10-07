/**
 * Serializes async writes against one file-backed store.
 *
 * Every operation waits for the previous one to settle, so two callers never
 * interleave a read-modify-write over the same JSON tree. A failed operation
 * does not poison the queue: its rejection reaches only its own caller, and the
 * next operation still runs.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  /** Run exclusively, after everything already queued. */
  public async run<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;
    const next = this.tail
      .catch(() => undefined)
      .then(async () => {
        result = await operation();
      });
    this.tail = next;
    await next;
    return result;
  }

  /** Wait for queued writes without taking a turn. Readers use this. */
  public async settled(): Promise<void> {
    await this.tail.catch(() => undefined);
  }
}
