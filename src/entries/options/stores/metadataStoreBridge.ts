/**
 * config store ↔ metadata store 之间的运行时依赖桥。
 *
 * 背景（见 docs/performance-audit.md P1）：
 * `stores/config.ts` 的 `getUserNames` getter 需要读 `metadata.ts` 的 `lastUserInfo`，
 * 而 `metadata.ts` 又需要读 `config.ts`（`getEnabledDownloadersBySite`）。
 * 两者互相静态 import 构成 ESM 循环依赖：getter 首次被调用的时机取决于模块求值顺序，
 * 一旦求值顺序变化（或其中一方在模块顶层调用对方）就会出现 `useXxxStore` 处于 TDZ
 * 或拿到未完成初始化的 store，属于脆弱点且难以定位。
 *
 * 这里把「config → metadata」这条边从**运行时静态 import** 改为一次性注册的访问器：
 * - `metadata.ts` 在自身模块求值结束时调用 `registerMetadataStoreAccessor(useMetadataStore)`；
 * - `config.ts` 只 import 本模块（`config → bridge`，无环），在 getter 里调用 `getMetadataStoreLazily()`。
 *
 * 等价性说明：访问器为 null 只可能发生在「`metadata.ts` 模块从未被求值」时，
 * 而那种情况下也根本不存在 metadata store 实例、`lastUserInfo` 必然为空——
 * 因此调用方按空数据降级与真实情况完全一致，不会改变对外行为。
 */
import type { useMetadataStore } from "./metadata.ts";

type TMetadataStore = ReturnType<typeof useMetadataStore>;

let metadataStoreAccessor: (() => TMetadataStore) | null = null;

/** 由 `metadata.ts` 在模块求值时注册（见文件头注释）。 */
export function registerMetadataStoreAccessor(accessor: () => TMetadataStore): void {
  metadataStoreAccessor = accessor;
}

/**
 * 惰性获取 metadata store（供 config store 的 getter 使用）。
 * 未注册时返回 null，交由调用方按「无 metadata 数据」降级处理。
 */
export function getMetadataStoreLazily(): TMetadataStore | null {
  return metadataStoreAccessor ? metadataStoreAccessor() : null;
}
