import PQueue from "p-queue";

/**
 * L3：可中止的富化队列。
 *
 * 背景：`RecommendationMenu` 在面板关闭时原本只调用 `PQueue.clear()` 丢弃尚未开始的任务。
 * p-queue 对被 `clear()` 丢弃的任务**不会** settle 它的 `add()` promise，于是
 * `await Promise.all(items.map(item => queue.add(...)))` 会永久挂起（只有内存泄漏，后续阶段
 * 也不再执行）。
 *
 * 这里用一个 AbortController 额外把队列停下：取消后 `add()` 的 promise 以 AbortError reject，
 * 本模块统一吞掉（对调用方呈现为「任务已结束」），并暴露 `onIdle()` 让调用方等待全部任务 settle。
 */
export interface IRecommendationEnrichmentQueue {
  /** 入队一个任务；返回的 promise 一定会 settle（成功 / 失败 / 被 stop 取消） */
  add(task: () => Promise<void>): Promise<void>;
  /** 停止队列：取消尚未开始的任务，并让它们的 promise 立即 settle */
  stop(): void;
  /** 等待已入队的全部任务 settle */
  onIdle(): Promise<void>;
}

export function createRecommendationEnrichmentQueue(concurrency: number): IRecommendationEnrichmentQueue {
  const queue = new PQueue({ concurrency });
  const abortController = new AbortController();
  const settledPromises: Promise<void>[] = [];
  let stopped = false;

  return {
    add(task) {
      // stop() 之后到达的任务直接视为已结束（不再执行）
      if (stopped) return Promise.resolve();
      const settled = queue.add(task, { signal: abortController.signal }).then(
        () => undefined,
        () => undefined, // AbortError / 任务本身失败：都视为「已结束」
      );
      settledPromises.push(settled);
      return settled;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      abortController.abort();
      queue.clear();
    },
    async onIdle() {
      await Promise.all(settledPromises);
    },
  };
}
