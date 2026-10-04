import { computed, watch } from "vue";
import { ITorrentTag } from "@ptd/site";

import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useTableCustomFilter } from "@/options/directives/useAdvanceFilter.ts";

const runtimeStore = useRuntimeStore();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();

export const tableCustomFilter = useTableCustomFilter({
  parseOptions: {
    keywords: ["site", "tags", "status"],
    ranges: ["time", "size", "seeders", "leechers", "completed"],
  },
  titleFields: ["title", "subTitle"],
  // V-5：initialSearchValue 必须是「store 恢复完成之后」的值，因此这里不再在模块求值期读取
  // `metadataStore.lastSearchFilter`，改由下面的 $onReady 回调灌入（见那里的说明）。
  initialSearchValue: "",
  initialItems: computed(() => runtimeStore.search.searchResult),
  format: {
    tags: {
      parse: (value: ITorrentTag | string) => ((value ?? {}) as ITorrentTag).name ?? value,
    },
    time: "date",
    size: "size",
  },
});

/**
 * V-5：等 metadata store 从 storage 恢复完成后再恢复「上次筛选」。
 *
 * 本文件是 SearchEntity 懒加载路由的 chunk，模块求值发生在首次导航时
 * （包括右键菜单深链 `#/search-entity?search=…&plan=…&flush=1`）；此刻 `useMetadataStore()`
 * 才刚创建 store，而插件的水合（`chrome.storage.local.get`）还是异步的 —— 在模块顶层读
 * `metadataStore.lastSearchFilter` 只会拿到 state 的初始值 `""`，于是「记住上次筛选」永远失效。
 * 对照写法见 `views/Overview/MyData/utils/lastUserData.ts`（那里同样 `await $onReady()`）。
 */
void metadataStore.$onReady(() => {
  // 开关关闭时不恢复旧值（此时 lastSearchFilter 是历史残留），也不回写
  if (!configStore.searchEntity.saveLastFilter) return;

  const lastSearchFilter = metadataStore.lastSearchFilter?.trim();
  // 输入框已有内容（例如本轮 flush 搜索刚重置出的筛选串）时不覆盖
  if (!lastSearchFilter || tableCustomFilter.tableWaitFilterRef.value) return;

  // 顺序：先构建高级筛选字典（对话框勾选状态），再写入输入框。
  // 赋值是程序化的，不会触发 a-input 的 @update:value，因此字典只能由这里显式构建。
  tableCustomFilter.buildFilterDictFn(lastSearchFilter);
  tableCustomFilter.tableWaitFilterRef.value = lastSearchFilter;
});

watch(tableCustomFilter.tableFilterRef, (newValue) => {
  if (configStore.searchEntity.saveLastFilter) {
    // 上面的恢复会触发一次 watcher（值等于持久化值）：此时无需回写 ——
    // setLastSearchFilter 会剥掉 `site:` 前缀，回写只会多出一次整状态写入。
    if (newValue === metadataStore.lastSearchFilter) return;

    // noinspection JSIgnoredPromiseFromCall
    metadataStore.setLastSearchFilter(newValue);
  }
});
