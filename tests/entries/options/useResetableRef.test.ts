/**
 * useResetableRef 行为测试。
 *
 * 该 composable 用于「可重置的局部草稿状态」：默认创建深 ref，`{ shallow: true }` 创建浅 ref；
 * 初始值支持 MaybeRefOrGetter；`reset()` 恢复初始值，也支持 reset(newValue | ref | getter)。
 */
import { describe, expect, it } from "vitest";
import { isReactive, isRef, isShallow, ref } from "vue";

import { useResetableRef } from "@/options/directives/useResetableRef.ts";

describe("useResetableRef：ref 的深浅性", () => {
  it("默认创建深 ref，对象值会被转为响应式代理", () => {
    const initial = { nested: { count: 0 } };
    const { ref: value } = useResetableRef(initial);

    expect(isRef(value)).toBe(true);
    expect(isShallow(value)).toBe(false);
    expect(isReactive(value.value)).toBe(true);
    expect(value.value).not.toBe(initial);
  });

  it("shallow: true 创建浅 ref，不包装对象值", () => {
    const initial = { nested: { count: 0 } };
    const { ref: value } = useResetableRef(initial, { shallow: true });

    expect(isRef(value)).toBe(true);
    expect(isShallow(value)).toBe(true);
    expect(isReactive(value.value)).toBe(false);
    expect(value.value).toBe(initial);
  });
});

describe("useResetableRef：初始值形态", () => {
  it("支持普通值", () => {
    const { ref: value } = useResetableRef(1);

    expect(value.value).toBe(1);
  });

  it("支持 ref（创建时取其当前值）", () => {
    const source = ref("initial");
    const { ref: value } = useResetableRef(source);

    expect(value.value).toBe("initial");
  });

  it("支持 getter（创建时求值一次）", () => {
    let evaluations = 0;
    const { ref: value } = useResetableRef(() => {
      evaluations += 1;
      return { run: evaluations };
    });

    expect(value.value).toEqual({ run: 1 });
    expect(evaluations).toBe(1);
  });
});

describe("useResetableRef：reset()", () => {
  it("恢复普通初始值", () => {
    const { ref: value, reset } = useResetableRef({ count: 1 });

    value.value = { count: 2 };
    reset();

    expect(value.value).toEqual({ count: 1 });
  });

  it("初始值为 ref 时，reset() 恢复该 ref 的初始值", () => {
    const source = ref(10);
    const { ref: value, reset } = useResetableRef(source);

    value.value = 20;
    reset();

    expect(value.value).toBe(10);
  });

  it("初始值为 getter 时，每次 reset() 都重新求值（而不是复用创建时的快照）", () => {
    let evaluations = 0;
    const { ref: value, reset } = useResetableRef(() => {
      evaluations += 1;
      return { run: evaluations };
    });

    expect(value.value).toEqual({ run: 1 });

    reset();
    expect(value.value).toEqual({ run: 2 });

    reset();
    expect(value.value).toEqual({ run: 3 });
    expect(evaluations).toBe(3);
  });

  it("reset(newValue) 更新为新的普通值", () => {
    const { ref: value, reset } = useResetableRef(0);

    reset(42);

    expect(value.value).toBe(42);
  });

  it("reset(ref) 解包 ref 并更新", () => {
    const { ref: value, reset } = useResetableRef<number>(0);

    reset(ref(7));

    expect(value.value).toBe(7);
  });

  it("reset(getter) 在调用时求值并更新", () => {
    let current = 1;
    const { ref: value, reset } = useResetableRef(0);

    reset(() => current);
    expect(value.value).toBe(1);

    current = 2;
    reset(() => current);
    expect(value.value).toBe(2);
  });

  it("reset() 之后仍可继续写入，ref 本身不是只读的", () => {
    const { ref: value, reset } = useResetableRef("origin");

    value.value = "changed";
    reset();
    expect(value.value).toBe("origin");

    value.value = "changed-again";
    expect(value.value).toBe("changed-again");
  });
});
