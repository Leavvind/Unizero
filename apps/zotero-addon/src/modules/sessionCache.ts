/** Bounded fallback for relation results, including when disk caching is disabled. */
export const SESSION_CACHE_CAPACITY = 32;

export class SessionCache<T> {
  private readonly entries = new Map<string, T>();
  private disposed = false;

  get size(): number { return this.entries.size; }

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    if (this.disposed) { return; }
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > SESSION_CACHE_CAPACITY) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  dispose(): void { this.disposed = true; this.entries.clear(); }
}
