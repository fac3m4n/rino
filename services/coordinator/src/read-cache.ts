/** Request-driven cache: generations revoke successful data, never failure cooldowns. */
export class ReadCache<T> {
  private generation = 0;
  private success?: { value: T; until: number };
  private failure?: { value?: T; error?: unknown; until: number };
  private active?: { generation: number; promise: Promise<T>; fresh: boolean };
  private now: () => number;
  constructor(
    private ttlMs: number,
    private load: (options: { fresh?: boolean }) => Promise<T>,
    private options: {
      now?: () => number;
      failed?: (value: T) => boolean;
    } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }
  read(options: { fresh?: boolean } = {}): Promise<T> {
    if (this.failure && this.now() < this.failure.until)
      return "error" in this.failure
        ? Promise.reject(this.failure.error)
        : Promise.resolve(this.failure.value as T);
    if (this.active?.generation === this.generation) {
      if (options.fresh === false || this.active.fresh)
        return this.active.promise;
      // A financial read must revalidate even if an older display load is still upstream.
      this.invalidate();
    }
    if (
      options.fresh === false &&
      this.success &&
      this.now() < this.success.until
    )
      return Promise.resolve(this.success.value);
    const generation = this.generation;
    // Call immediately so synchronous callers share the same transport start.
    const promise = this.load(options)
      .then((value) => {
        if (this.options.failed?.(value)) {
          this.failure = { value, until: this.now() + 30000 };
          this.success = undefined;
        } else if (generation === this.generation) {
          this.success = { value, until: this.now() + this.ttlMs };
          if (this.failure && this.now() >= this.failure.until)
            this.failure = undefined;
        }
        return value;
      })
      .catch((error) => {
        this.success = undefined;
        this.failure = { error, until: this.now() + 30000 };
        throw error;
      })
      .finally(() => {
        if (this.active?.promise === promise) this.active = undefined;
      });
    this.active = { generation, promise, fresh: options.fresh !== false };
    return promise;
  }
  invalidate(): void {
    this.generation++;
    this.success = undefined;
    this.active = undefined;
  }
}
