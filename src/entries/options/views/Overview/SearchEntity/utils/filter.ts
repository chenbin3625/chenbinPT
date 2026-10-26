import { computed, toRaw, watch, type Ref } from "vue";
import { ITorrentTag } from "@ptd/site";

import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useTableCustomFilter, type ITextValue } from "@/options/directives/useAdvanceFilter.ts";

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
 * `tableFilterRef` 是 `refDebounced(tableWaitFilterRef, 500)` 的返回值，VueUse 在其外层包了
 * `shallowReadonly` —— 直接给 `tableFilterRef.value` 赋值会被当作只读写入静默丢弃。
 * 点击标签需要立刻生效、不能等 500ms 防抖，因此用 toRaw 取回内部那个可写 ref 直接写入。
 */
const writableTableFilterRef = toRaw(tableCustomFilter.tableFilterRef) as Ref<string>;

export function updateTableFilterNow() {
  tableCustomFilter.updateTableFilterValueFn();
  writableTableFilterRef.value = tableCustomFilter.tableWaitFilterRef.value;
}

/**
 * 当前处于「必选」状态的标签名（供视图高亮已激活的标签）。
 * 返回拷贝：调用方是 computed，不能让外部拿到字典里那个可变数组的引用。
 */
export function getActiveTagFilterNames(): string[] {
  const tagsState = tableCustomFilter.advanceFilterDictRef.value.tags as ITextValue | undefined;
  return [...(tagsState?.required ?? [])];
}

/**
 * 切换某个标签的「必选」筛选状态（点击标签一键筛选），返回切换后是否处于必选。
 *
 * 刻意与 SearchFilterBar 共用同一个 `advanceFilterDictRef`：标签筛选条里的「标签」勾选框与
 * 标题列里的标签点击是同一份状态，从任一处修改，另一处与筛选串都必须同步，否则界面会自相矛盾。
 *
 * 注意 `tableFilterRef` 是 `tableWaitFilterRef` 的 500ms 防抖副本：点击标签是离散操作，
 * 用户期望立刻看到结果，不能等防抖；所以重建筛选串后直接把防抖 ref 同步成新值。这样写是安全的，
 * 随后防抖回调写回的也是同一个串，不会把状态改回去。
 */
export function toggleTagFilter(tagName: string): boolean {
  const { advanceFilterDictRef } = tableCustomFilter;

  // 显式标注类型：advanceFilterDictRef 的值是 Record<string, any>，不标注会让
  // `tagsState.exclude.filter((name) => ...)` 的 name 退回隐式 any（vue-tsc TS7006）。
  const tagsState: ITextValue = (advanceFilterDictRef.value.tags ??= { required: [], exclude: [] });
  tagsState.required ??= [];
  tagsState.exclude ??= [];

  const index = tagsState.required.indexOf(tagName);
  const active = index === -1;
  if (active) {
    tagsState.required.push(tagName);
    // 同一个标签不能既必选又排除：加入必选时顺手从排除项里摘掉
    tagsState.exclude = tagsState.exclude.filter((name) => name !== tagName);
  } else {
    tagsState.required.splice(index, 1);
  }

  updateTableFilterNow();

  return active;
}

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
