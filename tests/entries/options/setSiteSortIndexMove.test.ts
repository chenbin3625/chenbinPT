/**
 * 设置 → 站点：操作列的优先级快捷排序（移植自上游 7ff11363）。
 *
 * - store：`moveSiteSortIndex` 相对「按优先级降序排列的列表」移动站点；优先级重复 / 缺失时先按当前顺序重新分配
 *   互不相同的值（返回 true），否则 up/down 交换数值、top/bottom 只改被移动站点；已在边界时不做任何修改；
 * - 按钮：短按移动一位、长按移至最前 / 最后，长按松开后不会再补一次「移动一位」；键盘激活也能移动一位；
 *   禁用时不响应。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createApp, h, nextTick } from "vue";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(async () => undefined), onMessage: vi.fn() }));

import { piniaWebExtPersistencePlugin } from "~/extends/pinia/webExtPersistence.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { mountOptionsView } from "../../helpers/optionsView.ts";
import SortIndexMoveButton from "@/options/views/Settings/SetSite/SortIndexMoveButton.vue";

async function createMetadataStore(sites: Record<string, { sortIndex?: number }>) {
  const pinia = createPinia();
  pinia.use(piniaWebExtPersistencePlugin);
  createApp({ render: () => h("div") }).use(pinia);
  setActivePinia(pinia);

  const store = useMetadataStore(pinia);
  await store.$onReady();
  store.sites = sites as any;
  return store;
}

const order = (store: ReturnType<typeof useMetadataStore>) => store.getSortedAddedSites.map((site) => site.id);

describe("metadataStore.moveSiteSortIndex", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("优先级互不相同：up / down 与相邻站点交换数值，不重新分配", async () => {
    const store = await createMetadataStore({ a: { sortIndex: 30 }, b: { sortIndex: 20 }, c: { sortIndex: 10 } });

    await expect(store.moveSiteSortIndex("c", "up")).resolves.toBe(false);
    expect(order(store)).toEqual(["a", "c", "b"]);
    expect(store.sites.c.sortIndex).toBe(20);
    expect(store.sites.b.sortIndex).toBe(10);

    await expect(store.moveSiteSortIndex("a", "down")).resolves.toBe(false);
    expect(order(store)).toEqual(["c", "a", "b"]);
  });

  it("优先级互不相同：top / bottom 只改被移动站点，其它站点数值不变", async () => {
    const store = await createMetadataStore({ a: { sortIndex: 30 }, b: { sortIndex: 20 }, c: { sortIndex: 10 } });

    await store.moveSiteSortIndex("c", "top");
    expect(order(store)).toEqual(["c", "a", "b"]);
    expect(store.sites.c.sortIndex).toBe(31);
    expect([store.sites.a.sortIndex, store.sites.b.sortIndex]).toEqual([30, 20]);

    await store.moveSiteSortIndex("a", "bottom");
    expect(order(store)).toEqual(["c", "b", "a"]);
    expect(store.sites.a.sortIndex).toBe(19);
  });

  it("优先级重复或缺失：按当前顺序重新分配为 N..1 再移动，一次只移动一位", async () => {
    // 默认优先级都是 100：直接交换不会有任何变化
    const store = await createMetadataStore({ a: { sortIndex: 100 }, b: { sortIndex: 100 }, c: {} });
    expect(order(store)).toEqual(["a", "b", "c"]);

    await expect(store.moveSiteSortIndex("c", "up")).resolves.toBe(true);
    expect(order(store)).toEqual(["a", "c", "b"]);
    expect([store.sites.a.sortIndex, store.sites.c.sortIndex, store.sites.b.sortIndex]).toEqual([3, 2, 1]);
  });

  it("已在边界或站点不存在时返回 false 且不修改任何数值", async () => {
    const store = await createMetadataStore({ a: { sortIndex: 100 }, b: { sortIndex: 100 } });

    await expect(store.moveSiteSortIndex("a", "up")).resolves.toBe(false);
    await expect(store.moveSiteSortIndex("a", "top")).resolves.toBe(false);
    await expect(store.moveSiteSortIndex("b", "bottom")).resolves.toBe(false);
    await expect(store.moveSiteSortIndex("missing", "up")).resolves.toBe(false);
    expect([store.sites.a.sortIndex, store.sites.b.sortIndex]).toEqual([100, 100]);
  });
});

/**
 * 只伪造 setTimeout：vueuse 的 onLongPress 用 `event.timeStamp` 判断「是否有按下」，
 * 全量 fake timers 会连 performance 一起冻结，使 timeStamp 恒为 0 而被当成未按下。
 */
function useTimeoutFakeTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

describe("SortIndexMoveButton", () => {
  function pointer(type: string) {
    return new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
  }

  /** onLongPress 通过 watcher 在挂载后的下一个 tick 才绑定 pointer 监听，dispatch 前要等它 */
  async function mountButton(props: Record<string, unknown>) {
    const moves: string[] = [];
    const view = mountOptionsView(SortIndexMoveButton, {
      props: { title: "move", ...props, onMove: (position: string) => moves.push(position) },
    });
    await nextTick();
    const button = view.$<HTMLButtonElement>("button")!;
    return { view, button, moves };
  }

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("短按移动一位；长按移至最前，且松开时不会再补一次「移动一位」", async () => {
    useTimeoutFakeTimers();
    const { view, button, moves } = await mountButton({ direction: "up" });

    button.dispatchEvent(pointer("pointerdown"));
    vi.advanceTimersByTime(100);
    button.dispatchEvent(pointer("pointerup"));
    expect(moves).toEqual(["up"]);

    button.dispatchEvent(pointer("pointerdown"));
    vi.advanceTimersByTime(700);
    expect(moves).toEqual(["up", "top"]);
    button.dispatchEvent(pointer("pointerup"));
    expect(moves).toEqual(["up", "top"]);
    view.unmount();
  });

  it("下移方向：长按移至最后；键盘激活（click.detail === 0）移动一位，指针点击的 click 不重复触发", async () => {
    useTimeoutFakeTimers();
    const { view, button, moves } = await mountButton({ direction: "down" });

    button.dispatchEvent(pointer("pointerdown"));
    vi.advanceTimersByTime(700);
    button.dispatchEvent(pointer("pointerup"));
    expect(moves).toEqual(["bottom"]);

    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(moves).toEqual(["bottom"]);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(moves).toEqual(["bottom", "down"]);
    view.unmount();
  });

  it("禁用时短按 / 长按都不触发", async () => {
    useTimeoutFakeTimers();
    const { view, button, moves } = await mountButton({ direction: "up", disabled: true });

    expect(button.disabled).toBe(true);
    button.dispatchEvent(pointer("pointerdown"));
    vi.advanceTimersByTime(700);
    button.dispatchEvent(pointer("pointerup"));
    expect(moves).toEqual([]);
    view.unmount();
  });
});
