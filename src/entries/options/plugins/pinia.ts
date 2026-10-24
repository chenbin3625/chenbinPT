import { createPinia } from "pinia";

import { piniaWebExtPersistencePlugin } from "~/extends/pinia/webExtPersistence.ts";
import { setupRuntimeStorePersistence, useRuntimeStore } from "@/options/stores/runtime.ts";

export const piniaInstance = createPinia();

piniaInstance.use(piniaWebExtPersistencePlugin);
// J（REVIEW-FINDINGS stores-5）：早期注册的 `pinia-plugin-state-persistence` 已移除（依赖也已从 package.json 删除）。
// - 需要落盘的 store（config / metadata …）用 `persistWebExt` + 本插件的 webExtPersistence；
// - runtime store 显式 `persistWebExt: false`，由下方 `setupRuntimeStorePersistence` 以 500ms 节流
//   自行写 sessionStorage（旧插件的 deep + sync 全量序列化会在每次 mutation 卡主线程，见 P0-1）。

setupRuntimeStorePersistence(useRuntimeStore(piniaInstance));
