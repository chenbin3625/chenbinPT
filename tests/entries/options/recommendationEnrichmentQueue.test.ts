/**
 * L3（复检 Low）：RecommendationMenu 关闭时 `PQueue.clear()` 丢弃的任务其 `add()` promise
 * 永不 settle，`await Promise.all(...)` 永久挂起。
 *
 * 修复后改用可中止的队列封装：stop() 通过 AbortSignal 让所有 add promise settle，
 * `onIdle()` 一定能等到全部任务结束。本用例直接验证这层契约（面板本身的行为依赖它）。
 */
import { describe, expect, it } from "vitest";

import { createRecommendationEnrichmentQueue } from "@/options/views/Layout/recommendationEnrichmentQueue.ts";

const timeout = (ms: number, fallback: string) =>
  new Promise<string>((resolve) => setTimeout(() => resolve(fallback), ms));

describe("L3：可中止的富化队列", () => {
  it("stop() 后 onIdle() 必须在有限时间内 settle（不得因 PQueue.clear 永久挂起）", async () => {
    const queue = createRecommendationEnrichmentQueue(1);
    let secondTaskRan = false;

    // 第一个任务永不完成（模拟请求悬挂）；第二个任务排队，stop 后不应执行
    const first = queue.add(() => new Promise<void>(() => {}));
    const second = queue.add(async () => {
      secondTaskRan = true;
    });

    queue.stop();

    const result = await Promise.race([queue.onIdle().then(() => "idle"), timeout(500, "timeout")]);

    expect(result, "stop() 之后 onIdle 必须 settle，否则调用方 await Promise.all 永久挂起").toBe("idle");
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(secondTaskRan, "已被 stop 的任务不应再执行").toBe(false);
  });

  it("未 stop 时 onIdle 等所有任务真正完成", async () => {
    const queue = createRecommendationEnrichmentQueue(2);
    const finished: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    queue.add(async () => {
      await gate;
      finished.push(1);
    });
    queue.add(async () => {
      finished.push(2);
    });

    let settled = false;
    const onIdle = queue.onIdle().then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled, "仍有任务未完成时 onIdle 不应 resolve").toBe(false);

    release();
    await onIdle;
    expect(finished.sort()).toEqual([1, 2]);
  });

  it("stop() 之后新加入的任务直接视为已结束（不再发请求）", async () => {
    const queue = createRecommendationEnrichmentQueue(1);
    queue.stop();
    let ran = false;
    await expect(
      queue.add(async () => {
        ran = true;
      }),
    ).resolves.toBeUndefined();
    expect(ran).toBe(false);
  });
});
