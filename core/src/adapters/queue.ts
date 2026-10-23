// Cola asíncrona de un solo consumidor: puente entre callbacks (canUseTool, send) y `for await`.

export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;
  /** Se llama una vez cuando el consumidor abandona el bucle (`break`/`return`). */
  onReturn?: () => void;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  /** Cierra la cola: lo ya encolado se sigue entregando, después termina. */
  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async return(): Promise<IteratorResult<T>> {
    const wasOpen = !this.closed;
    this.end();
    if (wasOpen) this.onReturn?.();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}
