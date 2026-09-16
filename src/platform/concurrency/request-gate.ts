export class AsyncRequestGate {
  private readonly maximumConcurrent: number;
  private readonly minimumStartIntervalMs: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private nextStartMs = 0;

  constructor(maximumConcurrent: number, requestsPerSecond: number) {
    if (!Number.isSafeInteger(maximumConcurrent) || maximumConcurrent <= 0) {
      throw new Error("Request gate concurrency must be a positive integer");
    }
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
      throw new Error("Request gate rate must be positive and finite");
    }
    this.maximumConcurrent = maximumConcurrent;
    this.minimumStartIntervalMs = 1000 / requestsPerSecond;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      await this.pace();
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maximumConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }

  private async pace(): Promise<void> {
    const now = performance.now();
    const start = Math.max(now, this.nextStartMs);
    this.nextStartMs = start + this.minimumStartIntervalMs;
    const delayMs = start - now;
    if (delayMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}
