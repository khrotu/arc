export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private closed = false;
  private waiters = new Set<() => void>();
  push(event: T): void {
    if (this.closed) return;
    this.queue.push(event);
    this.wake();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }
  get isClosed(): boolean {
    return this.closed;
  }
  private wake(): void {
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const r of pending) r();
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          const waiter = (): void => {
            this.waiters.delete(waiter);
            if (this.queue.length) {
              resolve({ value: this.queue.shift()!, done: false });
            } else if (this.closed) {
              resolve({ value: undefined as unknown as T, done: true });
            } else {
              this.waiters.add(waiter);
            }
          };
          this.waiters.add(waiter);
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.closed = true;
        this.queue = [];
        this.wake();
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      },
    };
  }
}
export function readableToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      reader.releaseLock();
    } catch {}
  };
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          try {
            const r = await reader.read();
            if (r.done) {
              release();
              const rest = decoder.decode();
              if (rest) return { value: rest, done: false };
              return { value: undefined as unknown as string, done: true };
            }
            return { value: decoder.decode(r.value, { stream: true }), done: false };
          } catch (e) {
            release();
            throw e;
          }
        },
        async return() {
          try { await reader.cancel(); } catch {  }
          release();
          return { value: undefined as unknown as string, done: true };
        },
      };
    },
  };
}