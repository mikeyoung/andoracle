/**
 * Grants at most one asynchronous operation lease at a time.
 *
 * A generation-bearing lease keeps an old `finally` continuation from
 * releasing a newer operation after component teardown or another explicit
 * invalidation.
 */
export class ExclusiveOperationGuard {
  private generation = 0;
  private activeLease: number | null = null;

  acquire(): number | null {
    if (this.activeLease !== null) return null;
    this.generation += 1;
    this.activeLease = this.generation;
    return this.activeLease;
  }

  release(lease: number): boolean {
    if (this.activeLease !== lease) return false;
    this.activeLease = null;
    return true;
  }

  invalidate(): void {
    this.generation += 1;
    this.activeLease = null;
  }

  get isActive(): boolean {
    return this.activeLease !== null;
  }
}
