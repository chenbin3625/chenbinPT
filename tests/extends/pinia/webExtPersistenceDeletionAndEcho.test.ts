/**
 * webExtPersistence 的「外部删除同步」与「回声窗口精度」测试。
 *
 * 覆盖本轮两处修复（见 docs/performance-audit.md P0-3）：
 * 1. `applyMinimalPatch` 的嵌套对象分支补上「prev 中存在、next 中已消失的子 key」的删除，
 *    使 sites / downloaders / lastUserInfo 这类集合的外部删除能同步到本地 store
 *    （修复前只遍历 `Object.keys(next)`，删除永远丢，之后 $save 还会把过期 state 整份写回复活它）；
 * 2. 自身写入回声由"时间窗口内一律忽略"改成"内容一致才忽略"，
 *    修复前落在 500ms 窗口里的真实外部写入会被静默丢弃。
 *
 * 测试刻意与 webExtPersistence.test.ts 分开成一个文件，避免与其它并行改动冲突。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, defineStore } from "pinia";
import { createApp, h } from "vue";

type StorageChange = Record<string, { oldValue?: unknown; newValue?: unknown }>;

const backing = new Map<string, unknown>();
const changeListeners: Array<(changes: StorageChange, areaName: string) => void> = [];
/** 每次 set 的 payload，用于回放"其它上下文把同样内容再写一遍"（回声） */
const writes: Array<Record<string, unknown>> = [];

function emitChanges(changes: StorageChange) {
  for (const listener of changeListeners) {
    listener(changes, "local");
  }
}

const storageLocal = {
  get: (key: string) => Promise.resolve(backing.has(key) ? { [key]: backing.get(key) } : {}),
  set: (items: Record<string, unknown>) => {
    writes.push(items);
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

const { piniaWebExtPersistencePlugin } = await import("~/extends/pinia/webExtPersistence.ts");

const STORE_KEY = "testExternalSync";

function createTestStore() {
  const pinia = createPinia();
  pinia.use(piniaWebExtPersistencePlugin);
  createApp({ render: () => h("div") }).use(pinia);

  const useStore = defineStore("testExternalSync", {
    persistWebExt: true,
    state: () => ({
      // merge.deep 用于覆盖 L-9 的「孙级 / 曾孙级字段删除」
      sites: {
        siteA: { name: "A", sortIndex: 1, merge: { tags: ["a"], custom: 1, deep: { keep: true, drop: true } } },
        siteB: { name: "B", sortIndex: 2 },
      },
      downloaders: { dl1: { name: "DL1" }, dl2: { name: "DL2" } },
      lastUserInfo: { siteA: { ratio: 1 }, siteB: { ratio: 2 } },
      lastUserInfoAutoFlushAt: 0,
      lastSearchFilter: "",
    }),
    getters: {
      // 依赖 `Object.entries(sites)` 的 effect 代表：删除必须能被它感知
      siteIds: (state) => Object.keys(state.sites),
      downloaderIds: (state) => Object.keys(state.downloaders),
    },
  });
  return useStore(pinia);
}

/** 外部上下文（offscreen / 另一个 options 页）整份写回 store 状态 */
function externalWrite(state: Record<string, unknown>) {
  return storageLocal.set({ [STORE_KEY]: state });
}

describe("webExtPersistence：外部删除同步（P0-3 遗留）", () => {
  beforeEach(() => {
    backing.clear();
    changeListeners.length = 0;
    writes.length = 0;
  });

  it("外部删除 sites 子项：本地真正删除（不是赋 undefined），容器与剩余子项身份不变", async () => {
    const store = createTestStore();
    await store.$onReady();

    const sitesBefore = store.sites;
    const siteABefore = store.sites.siteA;
    expect(store.siteIds).toEqual(["siteA", "siteB"]);

    const stored = backing.get(STORE_KEY) as any;
    await externalWrite({ ...stored, sites: { siteA: { name: "A", sortIndex: 1 } } });

    // 真正删除：`in` / hasOwn / Object.keys / 依赖 entries 的 getter 都看不到它
    expect(Object.hasOwn(store.sites, "siteB")).toBe(false);
    expect("siteB" in store.sites).toBe(false);
    expect(Object.keys(store.sites)).toEqual(["siteA"]);
    expect(store.siteIds).toEqual(["siteA"]);
    // 容器与保留子项的对象身份不变（不触发整棵子树重建；删除本身是递归的，见 L-9 用例）
    expect(store.sites).toBe(sitesBefore);
    expect(store.sites.siteA).toBe(siteABefore);
  });

  it("外部删除 downloaders / lastUserInfo 子项同样同步", async () => {
    const store = createTestStore();
    await store.$onReady();

    const downloadersBefore = store.downloaders;
    const lastUserInfoBefore = store.lastUserInfo;
    const lastUserInfoBBefore = store.lastUserInfo.siteB;

    const stored = backing.get(STORE_KEY) as any;
    await externalWrite({
      ...stored,
      downloaders: { dl1: { name: "DL1" } },
      lastUserInfo: { siteB: { ratio: 3 } },
      lastUserInfoAutoFlushAt: 42,
    });

    expect(store.downloaderIds).toEqual(["dl1"]);
    expect(Object.keys(store.lastUserInfo)).toEqual(["siteB"]);
    expect(store.lastUserInfoAutoFlushAt).toBe(42);
    expect(store.downloaders).toBe(downloadersBefore);
    expect(store.lastUserInfo).toBe(lastUserInfoBefore);
    // 子项仍在时保持身份（最小 patch 只改必要字段）
    expect(store.lastUserInfo.siteB).toBe(lastUserInfoBBefore);
    expect(store.lastUserInfo.siteB.ratio).toBe(3);
  });

  it("外部新增 + 修改 + 删除混合：一次外部写入全部正确同步", async () => {
    const store = createTestStore();
    await store.$onReady();

    const stored = backing.get(STORE_KEY) as any;
    await externalWrite({
      ...stored,
      sites: {
        siteB: { name: "B-updated", sortIndex: 2 },
        siteC: { name: "C", sortIndex: 3 },
      },
    });

    expect(Object.keys(store.sites).sort()).toEqual(["siteB", "siteC"]);
    expect(store.sites.siteB.name).toBe("B-updated");
    expect((store.sites as Record<string, any>).siteC).toEqual({ name: "C", sortIndex: 3 });
  });
});

describe("webExtPersistence：自写回声窗口（P0-3 遗留）", () => {
  beforeEach(() => {
    backing.clear();
    changeListeners.length = 0;
    writes.length = 0;
  });

  it("窗口内到达的真实外部写入（内容不同）必须被应用", async () => {
    const store = createTestStore();
    await store.$onReady();
    writes.length = 0;

    store.sites.siteA.name = "local-edit";
    await store.$save();
    expect(writes).toHaveLength(1);

    // 窗口内（写入刚结束）：其它上下文写入不同内容
    const stored = backing.get(STORE_KEY) as any;
    await storageLocal.set({
      [STORE_KEY]: { ...stored, sites: { siteA: { name: "external-edit", sortIndex: 1 }, siteB: stored.sites.siteB } },
    });

    expect(store.sites.siteA.name).toBe("external-edit");
  });

  it("窗口内到达的自身写入回声（内容一致）仍被抑制：不产生任何 patch", async () => {
    const store = createTestStore();
    await store.$onReady();

    store.sites.siteA.name = "changed";
    await store.$save();

    const mutationCount = { count: 0 };
    store.$subscribe(() => (mutationCount.count += 1), { detached: true });

    // 模拟"另一个上下文"把刚写入的内容原样（JSON 往返后）再写一遍
    const stored = backing.get(STORE_KEY) as any;
    await storageLocal.set({ [STORE_KEY]: JSON.parse(JSON.stringify(stored)) });

    expect(mutationCount.count).toBe(0);
    expect(store.sites.siteA.name).toBe("changed");
  });

  it("密集 $save 的多个回声都被抑制，且之后的外部写入仍被应用", async () => {
    const store = createTestStore();
    await store.$onReady();
    writes.length = 0;

    store.sites.siteA.name = "first";
    await store.$save();
    store.sites.siteA.name = "second";
    await store.$save();
    expect(writes).toHaveLength(2);

    const firstEcho = JSON.parse(JSON.stringify(writes[0][STORE_KEY]));
    const secondEcho = JSON.parse(JSON.stringify(writes[1][STORE_KEY]));

    const mutationCount = { count: 0 };
    store.$subscribe(() => (mutationCount.count += 1), { detached: true });

    // 两次自身写入的回声乱序到达（早的那次不能被误判成外部写入而把本地回退到 first）
    await storageLocal.set({ [STORE_KEY]: firstEcho });
    await storageLocal.set({ [STORE_KEY]: secondEcho });
    expect(store.sites.siteA.name).toBe("second");
    expect(mutationCount.count).toBe(0);

    // 回声之后，窗口内真正的外部写入依旧生效
    await storageLocal.set({
      [STORE_KEY]: { ...secondEcho, lastUserInfoAutoFlushAt: 99 },
    });
    expect(store.lastUserInfoAutoFlushAt).toBe(99);
  });
});

describe("webExtPersistence：孙级字段的递归删除（L-9）", () => {
  beforeEach(() => {
    backing.clear();
    changeListeners.length = 0;
    writes.length = 0;
  });

  it("外部写入缺少孙级字段时真正删除，且容器身份不变；下一次 $save 不会把它写回", async () => {
    const store = createTestStore();
    await store.$onReady();
    writes.length = 0;

    const siteABefore = store.sites.siteA;
    const mergeBefore = store.sites.siteA.merge;
    const deepBefore = store.sites.siteA.merge.deep;
    expect(Object.keys(store.sites.siteA.merge)).toEqual(["tags", "custom", "deep"]);

    // 模拟"恢复备份"：备份里的 siteA.merge 只有 tags（本地存在的 custom / deep 都不在备份里）
    const stored = backing.get(STORE_KEY) as any;
    await externalWrite({
      ...stored,
      sites: { ...stored.sites, siteA: { name: "A", sortIndex: 1, merge: { tags: ["a"] } } },
    });

    // 旧实现只删「顶层容器的直接子键」：这里 siteA.merge.custom / siteA.merge.deep 会活下来
    expect(Object.hasOwn(store.sites.siteA.merge, "custom")).toBe(false);
    expect(Object.hasOwn(store.sites.siteA.merge, "deep")).toBe(false);
    expect(Object.keys(store.sites.siteA.merge)).toEqual(["tags"]);
    // 容器身份保持：递归删除也是原地 delete，不重建子树
    expect(store.sites.siteA).toBe(siteABefore);
    expect(store.sites.siteA.merge).toBe(mergeBefore);
    expect(store.sites.siteA.merge.tags).toEqual(["a"]);
    expect(deepBefore.keep).toBe(true); // 被删除的子树对象本身没被改（只是从父容器移除）

    // 关键回归点：下一次 $save() 不得把被删掉的孙级字段写回（旧实现下"恢复"会被自己撤销）
    await store.$save();
    const persisted = backing.get(STORE_KEY) as any;
    expect(Object.hasOwn(persisted.sites.siteA.merge, "custom")).toBe(false);
    expect(Object.hasOwn(persisted.sites.siteA.merge, "deep")).toBe(false);
  });

  it("曾孙级字段（第三层）同样被递归删除，兄弟字段保留", async () => {
    const store = createTestStore();
    await store.$onReady();

    const stored = backing.get(STORE_KEY) as any;
    await externalWrite({
      ...stored,
      sites: {
        ...stored.sites,
        siteA: { name: "A", sortIndex: 1, merge: { tags: ["a"], custom: 1, deep: { keep: true } } },
      },
    });

    expect(store.sites.siteA.merge.deep.keep).toBe(true);
    expect(Object.hasOwn(store.sites.siteA.merge.deep, "drop")).toBe(false);
    expect(Object.keys(store.sites.siteA.merge.deep)).toEqual(["keep"]);
  });

  it("整棵子树被外部删除时不抛错，且删除的是整棵子树（不残留半棵）", async () => {
    const store = createTestStore();
    await store.$onReady();

    const stored = backing.get(STORE_KEY) as any;
    await externalWrite({
      ...stored,
      sites: { ...stored.sites, siteA: { name: "A", sortIndex: 1 } },
    });

    expect(Object.hasOwn(store.sites.siteA, "merge")).toBe(false);
    expect(store.sites.siteA).toEqual({ name: "A", sortIndex: 1 });
  });
});

describe("webExtPersistence：落盘前与 storage 现值合并（B-10 持久化侧）", () => {
  beforeEach(() => {
    backing.clear();
    changeListeners.length = 0;
    writes.length = 0;
  });

  /** 模拟"另一个上下文写进了 storage，但 onChanged 还没送达"（$save 的读改写窗口） */
  function externalWriteWithoutNotification(mutate: (stored: any) => any) {
    backing.set(STORE_KEY, mutate(backing.get(STORE_KEY)));
  }

  it("$save 不再整份覆盖其它上下文刚写入的字段（外部改动不丢）", async () => {
    const store = createTestStore();
    await store.$onReady();
    writes.length = 0;

    store.sites.siteA.name = "local-edit";
    // service worker 侧的用户信息刷新（patchExtStoragePath）落在窗口内
    externalWriteWithoutNotification((stored) => ({ ...stored, lastSearchFilter: "external-refresh" }));

    await store.$save();

    const persisted = backing.get(STORE_KEY) as any;
    expect(persisted.sites.siteA.name).toBe("local-edit"); // 本地改动落盘
    expect(persisted.lastSearchFilter).toBe("external-refresh"); // 修复点：外部改动不再被静默回滚
    expect(writes).toHaveLength(1); // 仍然只写一次（合并后写，不是"先覆盖再补"）

    // 合并结果回灌本地 store：否则下一次 $save 会把外部改动当成"本地删除"再写回去
    expect(store.lastSearchFilter).toBe("external-refresh");
  });

  it("外部新增的站点与本地改动同时存在时都能落盘，且外部新增会同步到本地 store", async () => {
    const store = createTestStore();
    await store.$onReady();

    store.lastSearchFilter = "local-filter";
    externalWriteWithoutNotification((stored) => ({
      ...stored,
      sites: { ...stored.sites, siteC: { name: "C", sortIndex: 3 } },
    }));

    await store.$save();

    const persisted = backing.get(STORE_KEY) as any;
    expect(persisted.lastSearchFilter).toBe("local-filter");
    expect(persisted.sites.siteC).toEqual({ name: "C", sortIndex: 3 });
    // siteC 是外部新增的键：state 字面量类型只推断出 siteA/siteB，这里显式放宽到普通字典再断言
    // （若回灌没生效，取到的就是 undefined，断言照样失败 —— 没有削弱这条防回归断言）
    expect((store.sites as Record<string, unknown>).siteC).toEqual({ name: "C", sortIndex: 3 });
  });

  it("同一路径冲突时以本地改动为准（可预期的取舍，不是静默回滚）", async () => {
    const store = createTestStore();
    await store.$onReady();

    store.sites.siteA.name = "local-wins";
    externalWriteWithoutNotification((stored) => ({
      ...stored,
      sites: { ...stored.sites, siteA: { ...stored.sites.siteA, name: "external-loses" } },
    }));

    await store.$save();

    expect((backing.get(STORE_KEY) as any).sites.siteA.name).toBe("local-wins");
    expect(store.sites.siteA.name).toBe("local-wins");
  });

  it("外部删除与本地改动并发：外部删除不被整份写复活，本地改动照样落盘", async () => {
    const store = createTestStore();
    await store.$onReady();

    store.lastSearchFilter = "local-filter";
    externalWriteWithoutNotification((stored) => ({
      ...stored,
      sites: { siteB: stored.sites.siteB }, // 外部删掉了 siteA
    }));

    await store.$save();

    const persisted = backing.get(STORE_KEY) as any;
    expect(Object.hasOwn(persisted.sites, "siteA")).toBe(false);
    expect(persisted.lastSearchFilter).toBe("local-filter");
    expect(Object.hasOwn(store.sites, "siteA")).toBe(false);
  });

  it("没有并发外部写入时：行为与旧实现一致（一次落盘，内容就是本地 state）", async () => {
    const store = createTestStore();
    await store.$onReady();
    writes.length = 0;

    store.sites.siteA.name = "only-local";
    await store.$save();

    expect(writes).toHaveLength(1);
    const persisted = backing.get(STORE_KEY) as any;
    expect(persisted.sites.siteA.name).toBe("only-local");
    // 逐字段一致（没有引入额外的键或残留）
    expect(Object.keys(persisted).sort()).toEqual(Object.keys(JSON.parse(JSON.stringify(store.$state))).sort());
  });

  it("storage 里的内容被清空时退回整份写（不抛错、不写半个对象）", async () => {
    const store = createTestStore();
    await store.$onReady();

    store.sites.siteA.name = "after-purge";
    backing.delete(STORE_KEY); // 外部把 key 清掉

    await expect(store.$save()).resolves.toBeUndefined();
    expect((backing.get(STORE_KEY) as any).sites.siteA.name).toBe("after-purge");
  });
});
