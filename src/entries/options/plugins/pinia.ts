import { createPinia } from "pinia";

import { piniaWebExtPersistencePlugin } from "~/extends/pinia/webExtPersistence.ts";
import { setupRuntimeStorePersistence, useRuntimeStore } from "@/options/stores/runtime.ts";

export const piniaInstance = createPinia();

piniaInstance.use(piniaWebExtPersistencePlugin);
// J（REVIEW-FINDINGS stores-5）：`pinia-plugin-state-persistence` 的 `createStatePersistence()` 已是空转依赖。
// 全仓没有任何 store 使用该插件的 `persist` 选项：
// - 需要落盘的 store（config / metadata …）用 `persistWebExt` + 本插件的 webExtPersistence；
// - runtime store 显式 `persistWebExt: false`，由下方 `setupRuntimeStorePersistence` 以 500ms 节流
//   自行写 sessionStorage（插件的 deep + sync 全量序列化会在每次 mutation 卡主线程，见 P0-1）。
// 因此不再注册该插件（保留 package.json 依赖供后续清理，避免影响 lockfile）。

setupRuntimeStorePersistence(useRuntimeStore(piniaInstance));
