/**
 * Image generation is the only thing worth running wide: the provider is
 * remote and slow, and 16 in flight is as much as it will take without
 * throttling us.
 */
export const IMAGE_CONCURRENCY = 16;

/**
 * Runs `fn` over `items` with at most `limit` in flight, keeping results in
 * input order. Workers are started synchronously, so the pool is full before
 * the first call resolves.
 */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
