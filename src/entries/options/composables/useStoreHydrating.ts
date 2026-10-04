import { computed, isRef, type ComputedRef } from "vue";

/**
 * 判定一个 pinia store 是否已完成持久化状态的水合。
 *
 * 背景：options 页面的 `metadata` / `config` store 通过 `persistWebExt` 从
 * `chrome.storage` **异步**恢复状态（见 `extends/pinia/webExtPersistence.ts`），
 * 恢复完成前 store 里只有初始值（例如 `sites = {}`），页面若直接渲染就会出现
 * 「先闪一下暂无数据、再蹦出数据」的抖动。
 *
 * 该插件在 store 上注入了 `$ready`。注意它注入的是一个 ref：pinia 的 store 是
 * `reactive()` 代理，读属性时 ref 会被自动解包成 boolean，因此这里两种形态都要兼容；
 * 未启用持久化的 store（如 runtime）没有 `$ready`，视为已就绪。
 */
export function isPiniaStoreReady(store: { $ready?: unknown }): boolean {
  const ready = store.$ready;
  if (ready === undefined) return true;
  return isRef(ready) ? Boolean(ready.value) : Boolean(ready);
}

/**
 * 任意一个传入的 store 尚未水合完成时返回 true，适合直接绑定到骨架屏 / 表格 `loading`。
 *
 * @example
 * const isStoreHydrating = useStoreHydrating(metadataStore);
 * // <PtdDataTable :loading="isStoreHydrating" ... />
 */
export function useStoreHydrating(...stores: Array<{ $ready?: unknown }>): ComputedRef<boolean> {
  return computed(() => stores.some((store) => !isPiniaStoreReady(store)));
}
