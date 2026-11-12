import type { State } from "@proofcredit/coordinator/api";
/** Automatic reads only. Action authority lives in SnapshotLane and the App. */
export class ReadPoller {
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private active = false;
  private disposed = false;
  private failures = 0;
  private retryAt = 0;
  constructor(
    private options: {
      read: () => Promise<boolean | undefined>;
      mode: () => "public" | "local";
      pending: () => boolean;
      available: () => boolean;
      subscribe: (wake: () => void) => () => void;
    },
  ) {}
  start(): void {
    if (this.unsubscribe || this.disposed) return;
    this.unsubscribe = this.options.subscribe(() => this.wake());
    // Defer the initial task so effect cleanup can cancel a StrictMode probe.
    queueMicrotask(() => this.wake());
  }
  delivered(ready: boolean): void {
    this.failures = ready ? 0 : this.failures + 1;
    this.retryAt = ready
      ? 0
      : Date.now() +
        Math.min(15000 * 2 ** Math.min(this.failures - 1, 3), 120000);
    if (!this.active) this.schedule();
  }
  changed(): void {
    this.schedule();
  }
  private delay(): number {
    if (this.failures) return Math.max(0, this.retryAt - Date.now());
    return this.options.mode() === "local"
      ? 2500
      : this.options.pending()
        ? 5000
        : 30000;
  }
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.disposed || this.active || !this.options.available()) return;
    this.timer = setTimeout(() => void this.poll(), this.delay());
  }
  private wake(): void {
    clearTimeout(this.timer);
    if (this.disposed || this.active || !this.options.available()) return;
    if (Date.now() < this.retryAt) this.schedule();
    else void this.poll();
  }
  private async poll(): Promise<void> {
    if (this.disposed || this.active || !this.options.available()) return;
    this.active = true;
    try {
      const ready = await this.options.read();
      if (ready !== undefined) this.delivered(ready);
    } catch {
      this.delivered(false);
    } finally {
      this.active = false;
      this.schedule();
    }
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

export function pollingPending(
  state: State | undefined,
  pending: boolean,
  uncertain: boolean,
): boolean {
  return !!(
    pending ||
    uncertain ||
    state?.busy ||
    state?.settlement?.pending ||
    state?.proofStatus?.endsWith("Pending") ||
    state?.proofStatus === "Deriving"
  );
}
