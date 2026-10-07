/**
 * webExtPersistence 插件行为测试（见 docs/performance-audit.md P0-3 / P1-5）。
 *
 * 这个插件是 options 页所有 store（metadata / config）的持久化通道，本轮改了两处：
 * 1. `onChanged`：不再 `store.$patch(整份 newValue)`（整体替换 state 会让所有依赖
 *    `Object.entries(sites)` 的 effect 全部重算），改为**只下发真正变化的字段**；
 * 2. `$save`：写入进行中到达的多次调用合并成一次尾部写入（N 次调用 → 最多 2 次落盘），
 *    同时保持 `await $save()` 返回时数据已落盘的语义。
 *
 * 同时验证 `persistent()` 走的是解代理（toSerializable）而不是 JSON 往返：
 * 写进 storage 的必须是普通对象，不能带 Vue 的 `__v_raw`。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, defineStore } from "pinia";
import { createApp, h, reactive, ref } from "vue";

type StorageChange = Record<string, { oldValue?: unknown; newValue?: unknown }>;

const backing = new Map<string, unknown>();
const changeListeners: Array<(changes: StorageChange, areaName: string) => void> = [];
let setCallCount = 0;

function emitChanges(changes: StorageChange) {
  for (const listener of changeListeners) {
    listener(changes, "local");
  }
}

const storageLocal = {
  get: (key: string) => Promise.resolve(backing.has(key) ? { [key]: backing.get(key) } : {}),
  set: (items: Record<string, unknown>) => {
    setCallCount++;
    const changes: StorageChange = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = { oldValue: backing.get(key), newValue: value };
      backing.set(key, value);
    }
    emitChanges(changes);
    return Promise.resolve();
  },
  remove: (key: string) => {
    backing.delete(key);
    emitChanges({ [key]: { oldValue: undefined, newValue: undefined } });
    return Promise.resolve();
  },
  onChanged: {
    addListener: (fn: (changes: StorageChange, areaName: string) => void) => changeListeners.push(fn),
    removeListener: (fn: (changes: StorageChange, areaName: string) => void) => {
      const index = changeListeners.indexOf(fn);
      if (index >= 0) changeListeners.splice(index, 1);
    },
  },
};

vi.stubGlobal("chrome", {
  storage: { local: storageLocal, onChanged: storageLocal.onChanged },
});

const { piniaWebExtPersistencePlugin, persistent } = await import("~/extends/pinia/webExtPersistence.ts");

const STORE_KEY = "testMetadata";

function createTestStore() {
  const pinia = createPinia();
  pinia.use(piniaWebExtPersistencePlugin);
  // 注意：Pinia v4 中，pinia 未安装到 app 之前 `use()` 只是把插件放进 toBeInstalled，
  // 只有 app.use(pinia) 之后插件才会进入 _p 并在 store 创建时执行。
  createApp({ render: () => h("div") }).use(pinia);

  const useStore = defineStore("testMetadata", {
    persistWebExt: true,
    state: () => ({
      sites: {
        siteA: { name: "A", sortIndex: 1 },
        siteB: { name: "B", sortIndex: 2 },
      },
      lastUserInfoAutoFlushAt: 0,
    }),
  });
  return useStore(pinia);
}

describe("webExtPersistence：最小字段 patch（P0-3）", () => {
  beforeEach(() => {
    backing.clear();
    changeListeners.length = 0;
    setCallCount = 0;
  });

  it("外部变更只 patch 变化的子项，未变化子项保持对象身份（不触发整体替换）", async () => {
    const store = createTestStore();
    await store.$onReady();

    const sitesBefore = store.sites;
    const siteBBefore = store.sites.siteB;
    const mutationTypes: string[] = [];
    store.$subscribe((mutation) => mutationTypes.push(mutation.type), { detached: true });

    // 模拟另一个上下文（offscreen 用户信息刷新）写回 metadata：只有 siteA 变了
    await storageLocal.set({
      [STORE_KEY]: {
        sites: { siteA: { name: "A-updated", sortIndex: 1 }, siteB: { name: "B", sortIndex: 2 } },
        lastUserInfoAutoFlushAt: 123,
      },
    });

    expect(store.sites.siteA.name).toBe("A-updated");
    expect(store.lastUserInfoAutoFlushAt).toBe(123);
    // 容器对象身份保持：说明不是整店替换（否则 Topbar/SetSite 的全量 effect 会被重算）
    expect(store.sites).toBe(sitesBefore);
    expect(store.sites.siteB).toBe(siteBBefore);
  });

  it("外部写入到达时保留本地尚未保存的修改，同时应用不冲突的外部字段", async () => {
    const store = createTestStore();
    await store.$onReady();

    store.sites.siteA.name = "local-unsaved";
    await storageLocal.set({
      [STORE_KEY]: {
        ...(backing.get(STORE_KEY) as any),
        lastUserInfoAutoFlushAt: 987,
      },
    });

    expect(store.sites.siteA.name).toBe("local-unsaved");
    expect(store.lastUserInfoAutoFlushAt).toBe(987);
  });

  it("自身回声比较不依赖对象键的插入顺序", async () => {
    const store = createTestStore();
    await store.$onReady();
    store.sites.siteA.name = "changed";
    await store.$save();

    const mutationCount = { count: 0 };
    store.$subscribe(() => (mutationCount.count += 1), { detached: true });
    const stored = backing.get(STORE_KEY) as any;
    const reordered = {
      lastUserInfoAutoFlushAt: stored.lastUserInfoAutoFlushAt,
      sites: {
        siteB: stored.sites.siteB,
        siteA: stored.sites.siteA,
      },
    };

    await storageLocal.set({ [STORE_KEY]: reordered });

    expect(mutationCount.count).toBe(0);
  });

  it("自身写入的回声被抑制：$save 后 onChanged 回传不会再次 patch（避免级联重算）", async () => {
    const store = createTestStore();
    await store.$onReady();

    store.sites.siteA.name = "changed";
    await store.$save();

    const mutationCount = { count: 0 };
    store.$subscribe(() => (mutationCount.count += 1), { detached: true });

    // 模拟 chrome.storage 把刚写入的内容原样回传（反序列化后是新对象，引用比较无法识别）
    await storageLocal.set({ [STORE_KEY]: JSON.parse(JSON.stringify(store.$state)) });

    expect(mutationCount.count).toBe(0);
    expect(store.sites.siteA.name).toBe("changed");
  });

  it("回声窗口内：与自身刚写入内容一致的 onChanged 被抑制（对照用例，见下一条 TESTS-6）", async () => {
    vi.useFakeTimers();
    try {
      const store = createTestStore();
      await store.$onReady();
      store.sites.siteA.name = "self-v1";
      await store.$save();
      // 落盘后本地又改了（未落盘）；此时外部把「旧的自身写入内容」写回 storage
      const selfWritten = JSON.parse(JSON.stringify(backing.get(STORE_KEY)));
      store.sites.siteA.name = "local-edit";

      await storageLocal.set({ [STORE_KEY]: selfWritten });

      // 仍在 SELF_WRITE_ECHO_WINDOW 内且内容与刚写入的快照逐字节一致 → 判定为自身回声，不下发
      expect(store.sites.siteA.name).toBe("local-edit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("回声窗口过期后同样的变更必须被应用（窗口不能一直吞掉外部更新）", async () => {
    // TESTS-6：原用例全程没有调用 $save()，selfWriteUntil 恒为 0（窗口从未建立），
    // 把 SELF_WRITE_ECHO_WINDOW 改成 Infinity 或让 isWithinSelfWriteEchoWindow() 恒为 true
    // 都照样通过。这里先真正建立窗口，再用受控假时钟越过它。
    vi.useFakeTimers();
    try {
      const store = createTestStore();
      await store.$onReady();
      store.sites.siteA.name = "self-v1";
      await store.$save(); // 登记自身写入快照 + 打开回声窗口

      const selfWritten = JSON.parse(JSON.stringify(backing.get(STORE_KEY)));
      store.sites.siteA.name = "local-edit";

      // 越过 500ms 的自身写入窗口（与上一条只差这一步）
      vi.advanceTimersByTime(1000);

      await storageLocal.set({ [STORE_KEY]: selfWritten });

      // 窗口已过期：不能再当作回声吞掉，外部写入必须落到本地
      expect(store.sites.siteA.name).toBe("self-v1");
      expect((backing.get(STORE_KEY) as any).sites.siteA.name).toBe("self-v1");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("webExtPersistence：写入合并（P1-5）", () => {
  beforeEach(() => {
    backing.clear();
    changeListeners.length = 0;
    setCallCount = 0;
  });

  it("紧急保存可以跳过落盘前的 storage.get", async () => {
    const store = createTestStore();
    await store.$onReady();
    store.sites.siteA.name = "pagehide-edit";

    const originalGet = storageLocal.get;
    const setSpy = vi.spyOn(storageLocal, "set");
    let getResolved = false;
    storageLocal.get = vi.fn(
      () =>
        new Promise((resolve) => {
          void resolve;
        }),
    ) as typeof storageLocal.get;

    try {
      await (store.$save as any)(undefined, { skipMerge: true });

      expect(getResolved).toBe(false);
      expect(setSpy).toHaveBeenCalled();
    } finally {
      storageLocal.get = originalGet;
      setSpy.mockRestore();
    }
  });

  it("并发 $save 被合并：N 次调用最多落盘 2 次，且每个 await 都在落盘之后 resolve", async () => {
    const store = createTestStore();
    await store.$onReady();
    setCallCount = 0;

    store.sites.siteA.name = "first";
    const first = store.$save();
    store.sites.siteA.name = "second";
    const second = store.$save();
    store.sites.siteA.name = "third";
    const third = store.$save();

    await Promise.all([first, second, third]);

    // 第一次立即写 + 期间到达的两次合并成一次尾部写 = 2 次
    expect(setCallCount).toBe(2);
    const stored = backing.get(STORE_KEY) as any;
    expect(stored.sites.siteA.name).toBe("third");
  });

  it("首个保存失败时拒绝首个等待者，排队的最新状态仍可成功落盘", async () => {
    const store = createTestStore();
    await store.$onReady();
    const setSpy = vi.spyOn(storageLocal, "set");
    let rejectFirst!: (error: Error) => void;
    setSpy.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );

    try {
      store.sites.siteA.name = "first";
      const first = store.$save();
      store.sites.siteA.name = "second";
      const second = store.$save();
      await vi.waitFor(() => expect(rejectFirst).toBeTypeOf("function"));
      rejectFirst(new Error("quota exceeded"));

      await expect(first).rejects.toThrow("quota exceeded");
      await expect(second).resolves.toBeUndefined();
      expect((backing.get(STORE_KEY) as any).sites.siteA.name).toBe("second");
    } finally {
      setSpy.mockRestore();
    }
  });

  it("persistent() 写入的是解代理后的普通对象（不含 __v_raw）", async () => {
    const state = reactive({ sites: { siteA: { name: "A" } }, count: 1 });
    await persistent("reactiveKey", state);

    const stored = backing.get("reactiveKey") as any;
    expect(JSON.stringify(stored)).toBe(JSON.stringify({ sites: { siteA: { name: "A" } }, count: 1 }));
    expect(stored.sites.__v_raw).toBeUndefined();

    // Vue ref 也会被解成其 value
    await persistent("refKey", { value: ref(42) } as any);
    const storedRef = backing.get("refKey") as any;
    expect(storedRef.value).toBe(42);
  });
});
