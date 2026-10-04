import { createPinia } from "pinia";
import { createStatePersistence } from "pinia-plugin-state-persistence";

import { piniaWebExtPersistencePlugin } from "~/extends/pinia/webExtPersistence.ts";
import { setupRuntimeStorePersistence, useRuntimeStore } from "@/options/stores/runtime.ts";

export const piniaInstance = createPinia();

piniaInstance.use(piniaWebExtPersistencePlugin);
// 注意：runtime store 不再使用 createStatePersistence 的 persist（其 deep + sync 行为
// 会在每次 mutation 时全量序列化整个 state，见 docs/performance-audit.md P0-1），
// 改为在 store 内部按 500ms 节流自行写入 sessionStorage。
piniaInstance.use(createStatePersistence());

setupRuntimeStorePersistence(useRuntimeStore(piniaInstance));
