/**
 * 以固定并发上限映射一组异步任务，并像 `Promise.allSettled` 一样返回每个任务的结果。
 *
 * 批量复制链接 / 本地下载 / 辅种校验原先一次性 `Promise.allSettled`（或串行 await）：
 * 前者会把几百个请求同时打出去，后者一条失败就中断全部。这里限制在有限并发内，
 * 同时保证结果顺序与输入一致，调用方可以先处理成功项、再汇总失败项。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const workerCount = Math.min(Math.max(1, Math.floor(limit)), items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;

      try {
        results[index] = { status: "fulfilled", value: await mapper(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
