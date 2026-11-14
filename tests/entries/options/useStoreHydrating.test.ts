/**
 * useStoreHydrating / isPiniaStoreReady 行为测试。
 *
 * 背景：持久化插件在 store 上注入 `$ready`（一个 ref）。pinia store 是 `reactive()` 代理，
 * 读取属性时 ref 会被自动解包成 boolean，因此被测函数必须同时兼容「ref」和「普通 boolean」
 * 两种形态；没有 `$ready` 的 store（如 runtime）视为已就绪。
 */
import { describe, expect, it } from "vitest";
import { computed, createApp, isRef, reactive, ref } from "vue";
import { createPinia, defineStore, setActivePinia } from "pinia";

import { isPiniaStoreReady, useStoreHydrating } from "@/options/composables/useStoreHydrating.ts";

describe("isPiniaStoreReady", () => {
  it("没有 $ready 的 store 视为已就绪", () => {
    expect(isPiniaStoreReady({})).toBe(true);
    expect(isPiniaStoreReady({ $ready: undefined })).toBe(true);
  });

  it("兼容 $ready 为 ref 的形态（ref(false) / ref(true)）", () => {
    expect(isPiniaStoreReady({ $ready: ref(false) })).toBe(false);
    expect(isPiniaStoreReady({ $ready: ref(true) })).toBe(true);
  });

  it("兼容 $ready 为普通 boolean 的形态（已由 reactive/pinia 解包）", () => {
    expect(isPiniaStoreReady({ $ready: false })).toBe(false);
    expect(isPiniaStoreReady({ $ready: true })).toBe(true);
  });

  it("reactive 对象中的 ref 会被自动解包，仍能正确判定", () => {
    const store = reactive({ $ready: ref(false) });
    // 与 pinia store 一致：经代理读取到的是普通 boolean
    expect(isRef(store.$ready)).toBe(false);
    expect(isPiniaStoreReady(store)).toBe(false);

    store.$ready = true;
    expect(isPiniaStoreReady(store)).toBe(true);
  });

  it("真实 pinia store 注入 ref 后自动解包，并能响应 ref 变化", () => {
    const pinia = createPinia();
    // pinia 只有被 app.use() 之后才会真正安装插件，因此先装到一个一次性 app 上。
    createApp({ render: () => null }).use(pinia);
    setActivePinia(pinia);

    const ready = ref(false);
    pinia.use(({ store }) => {
      (store as any).$ready = ready;
    });

    const useTestStore = defineStore("storeHydratingTest", { state: () => ({ value: 1 }) });
    const store = useTestStore();

    expect(isRef((store as any).$ready)).toBe(false);
    expect(isPiniaStoreReady(store as unknown as { $ready?: unknown })).toBe(false);

    ready.value = true;
    expect(isPiniaStoreReady(store as unknown as { $ready?: unknown })).toBe(true);
  });
});

describe("useStoreHydrating", () => {
  it("没有传入 store 时视为全部就绪（不处于水合中）", () => {
    expect(useStoreHydrating().value).toBe(false);
  });

  it("单个已就绪的 store 返回 false", () => {
    expect(useStoreHydrating({ $ready: ref(true) }).value).toBe(false);
  });

  it("单个未就绪的 store 返回 true", () => {
    expect(useStoreHydrating({ $ready: ref(false) }).value).toBe(true);
  });

  it("多 store 时任一未就绪即为 true", () => {
    const hydrating = useStoreHydrating({ $ready: ref(true) }, { $ready: false }, {});

    expect(hydrating.value).toBe(true);
  });

  it("多 store 全部就绪时为 false", () => {
    const hydrating = useStoreHydrating({}, { $ready: true }, { $ready: ref(true) });

    expect(hydrating.value).toBe(false);
  });

  it("返回响应式 computed：$ready 变化后结果随之更新", () => {
    const metadataReady = ref(false);
    const hydrating = useStoreHydrating({ $ready: metadataReady });

    expect(computed(() => hydrating.value).value).toBe(true);

    metadataReady.value = true;
    expect(hydrating.value).toBe(false);

    metadataReady.value = false;
    expect(hydrating.value).toBe(true);
  });

  it("多 store 中某个 $ready 变化时 computed 重新求值", () => {
    const a = ref(true);
    const b = ref(false);
    const hydrating = useStoreHydrating({ $ready: a }, { $ready: b });

    expect(hydrating.value).toBe(true);

    b.value = true;
    expect(hydrating.value).toBe(false);

    a.value = false;
    expect(hydrating.value).toBe(true);
  });

  it("普通 boolean 形态变化同样触发重新求值（reactive store）", () => {
    const store = reactive<{ $ready: boolean }>({ $ready: true });
    const hydrating = useStoreHydrating(store);

    expect(hydrating.value).toBe(false);

    store.$ready = false;
    expect(hydrating.value).toBe(true);
  });
});
