/**
 * 此处放置一些其他数据，这些数据一般具有以下特征：
 * 1. 不需要persist
 * 2. 不需要跨tab共享的
 * 3. 可以在不同component中共享的
 *
 * 持久化说明（见 docs/performance-audit.md P0-1）：
 * 该 store 需要把搜索结果保留在 sessionStorage 中（刷新页面后结果还在），
 * 但早期实现用的是 pinia-plugin-state-persistence 的默认行为：
 *   `$subscribe(persistState, { flush: "sync" })` + pinia 默认 `deep: true`
 * → **每次 mutation** 都会深遍历整个 state 并 `JSON.stringify` + 同步写 sessionStorage。
 * 搜索期间每个站点会产生 5~6 次 mutation（进度字段）外加一次结果批量 push，
 * 媒体服务器搜索更是逐条 push，写入量累计为 O(站点数 × 结果数)（实测 5 万项 ≈ 300ms/次），
 * 主线程成片阻塞；超出 sessionStorage 配额后还会静默丢弃持久化。
 *
 * 现在改为自行持久化：
 * - 不再使用插件的 persist（避免 deep + sync 全量序列化）；
 * - 通过 `$subscribe` 只做「标记需要保存」，真正的序列化与写入按 500ms 节流合并；
 * - 页面卸载前（pagehide/visibilitychange）立即 flush，降低丢失窗口；
 * - 配额不足时降级为「不保存两个 searchResult」，而不是完全丢失；
 * - 内容脚本实例退化为**纯内存**：内容脚本与宿主页面共享同一个 window.sessionStorage，
 *   既不该把扩展数据暴露给页面，也不该信任页面预置的内容（见 B-19 与 isHostPageStorage）。
 */

import { defineStore } from "pinia";
import { message } from "ant-design-vue";
import type { EResultParseStatus } from "@ptd/site";
import type { IRuntimePiniaStorageSchema, ISearchData, SnackbarMessageOptions } from "@/shared/types.ts";

const RUNTIME_STORE_KEY = "__ptd_runtime_store"; // 内容脚本侧退化为纯内存（见下方 B-19 说明），该 key 只用于扩展页面
const PERSIST_DELAY = 500;

const initialSearchData: () => ISearchData = () => ({
  isSearching: false,
  startAt: 0,
  endAt: 0,
  searchKey: "",
  searchPlanKey: "default",
  searchPlan: {},
  searchResult: [],
});

const initialMediaServerSearchData = (): IRuntimePiniaStorageSchema["mediaServerSearch"] => ({
  isSearching: false,
  searchKey: "",
  searchStatus: {},
  searchResult: [],
});

/**
 * B-19：判断当前的 `sessionStorage` 是否属于**宿主页面**。
 *
 * `useRuntimeStore` 不只在选项页注册 —— content-script（content-script/app/App.vue、app/utils.ts）
 * 也会用到它，而内容脚本里的 `sessionStorage` 与宿主页面是**同一个**：
 * 1. 页面脚本可以读到扩展持久化的内容（例如 `search.searchKey`，其值来自解析出的种子标题并会流入
 *    下载器的保存路径/标签替换）；
 * 2. 页面可以在内容脚本加载前预置 `__ptd_runtime_store`，向 store 注入任意 JSON。
 * 因此只有当前文档属于扩展自身（地址前缀是 `chrome.runtime.getURL("")`）时才读写持久化；
 * 扩展页面的 `location.href` 与扩展 URL 前缀匹配，内容脚本的则是宿主页面地址，二者可据此区分。
 * 宿主没有完整扩展 API（本地预览页 / 单测）时无法判断，保持修复前的行为以便本地调试。
 */
function isHostPageStorage(): boolean {
  try {
    if (typeof chrome === "undefined" || typeof chrome.runtime?.getURL !== "function") {
      return false;
    }
    const extensionUrl = chrome.runtime.getURL("");
    const href = globalThis.location?.href;
    if (!extensionUrl || typeof href !== "string") {
      return false;
    }
    return !href.startsWith(extensionUrl);
  } catch {
    // 宿主用 getter 抛错代替返回值（例如扩展被重载后的「Extension context invalidated」）
    return false;
  }
}

/** 内容脚本实例：纯内存运行，既不读也不写宿主页面的 sessionStorage */
const memoryOnly = isHostPageStorage();

function getSessionStorage(): Storage | null {
  if (memoryOnly) {
    return null;
  }
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 复制一层普通对象的自有可枚举字段，跳过 `__proto__` 这类原型污染键 */
function copySafeRecord(raw: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of Object.keys(raw)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    result[key] = raw[key];
  }
  return result;
}

/**
 * D2-High-01：恢复时「收尾」那些不可能还有对应任务的 in-flight 标记。
 *
 * 搜索队列（PQueue）、用户信息刷新任务都只活在内存里：页面刷新 / 换上下文后，
 * 持久化到 sessionStorage 的 `isSearching`、`searchPlan[*].status = waiting|working`、
 * `userInfo.flushPlan[site] = true` 都成了「永远等不到结果」的僵尸状态
 * （顶栏搜索按钮被禁用、状态弹窗里计划永远停在 waiting、MyData 顶部显示「取消刷新」）。
 *
 * 这里在恢复阶段直接把它们改写成终态：
 * - `isSearching` 一律置 false（恢复出来的搜索结果仍然保留，见 runtimeStorePersistence 用例）；
 * - `searchPlan` 里 waiting/working 的计划改写为 passParse + `i18n.userCancel`（与
 *   `SearchEntity/utils/search.ts` 的 `cancelSearchQueue()` 收尾语义一致）；
 * - `flushPlan` 一律置 false。
 *
 * 用字面量而不是从 `@ptd/site` import 枚举：runtime store 会被 content-script 引用，而
 * runtimeStore*.test.ts 不加载站点包的构建期常量；类型上仍以 `EResultParseStatus` 约束，
 * 枚举顺序变化会在类型检查阶段报错。
 */
const SEARCH_PLAN_STATUS_WAITING: EResultParseStatus.waiting = 1;
const SEARCH_PLAN_STATUS_WORKING: EResultParseStatus.working = 2;
const SEARCH_PLAN_STATUS_PASS_PARSE: EResultParseStatus.passParse = 5;

/** 本次恢复是否把某些「进行中」状态收尾了（供 UI/测试判断要不要提示用户） */
export interface IRuntimeRestoreInterruptions {
  search: boolean;
  mediaServerSearch: boolean;
  userInfo: boolean;
}

const restoreInterruptions: IRuntimeRestoreInterruptions = {
  search: false,
  mediaServerSearch: false,
  userInfo: false,
};

export function getRuntimeRestoreInterruptions(): IRuntimeRestoreInterruptions {
  return { ...restoreInterruptions };
}

/**
 * OUI-2：取走某一类「恢复时被收尾」的中断标记（消费后置 false，同一会话只提示一次）。
 *
 * 背景：`sanitizeSearchData` / `sanitizeUserInfo` 会在页面加载时把恢复出来的 in-flight 状态
 * 收尾为终态，并在这里记下「发生过中断」。此前生产代码没有任何调用者，用户刷新页面后看到的是
 * 「部分结果 + 共找到 N 条」，不知道上次搜索其实被中断了。
 *
 * 返回本次消费前是否处于「中断」状态；调用方据此决定是否给一次可见提示。
 */
export function consumeRuntimeRestoreInterruption(kind: keyof IRuntimeRestoreInterruptions): boolean {
  if (!restoreInterruptions[kind]) return false;
  restoreInterruptions[kind] = false;
  return true;
}

/**
 * 把**单个**搜索计划收尾（waiting/working → passParse + `i18n.userCancel`）。
 * 就地把传入对象改到终态，返回是否真的改写过。
 *
 * 恢复阶段（`normalizeRestoredSearchPlan`，操作的是从 JSON 解析出来的普通对象）与
 * UI 侧协作 API（`reconcileRuntimeInFlightState`，操作的是 store 里的响应式对象）共用这一份规则。
 */
function markSearchPlanInterrupted(item: Record<string, any>): boolean {
  if (!isPlainRecord(item)) return false;
  if (item.status !== SEARCH_PLAN_STATUS_WAITING && item.status !== SEARCH_PLAN_STATUS_WORKING) return false;

  item.status = SEARCH_PLAN_STATUS_PASS_PARSE;
  item.statusMsg = typeof item.statusMsg === "string" && item.statusMsg ? item.statusMsg : "i18n.userCancel";
  if (!(typeof item.endAt === "number" && item.endAt > 0)) {
    item.endAt = Date.now();
  }
  return true;
}

/**
 * 把 searchPlan 里的 waiting/working 计划改写为「已取消」终态。
 * 返回是否真的改写过（用于决定要不要提示用户「上次搜索已被中断」）。
 */
function normalizeRestoredSearchPlan(rawPlan: Record<string, any>): {
  plan: Record<string, any>;
  interrupted: boolean;
} {
  const plan = copySafeRecord(rawPlan);
  let interrupted = false;

  for (const [key, item] of Object.entries(plan)) {
    if (!isPlainRecord(item)) continue;
    const nextItem = { ...item };
    if (markSearchPlanInterrupted(nextItem)) {
      interrupted = true;
      plan[key] = nextItem;
    }
  }

  return { plan, interrupted };
}

/**
 * B-19：恢复前做形状校验。
 *
 * 修复前只判断 `typeof parsed === "object"`，于是宿主页面预置的任意 JSON（字段类型完全不对、
 * 甚至带原型污染键）都会被直接塞进 store。这里只接受类型正确的已知字段：
 * 关键字段（searchKey / searchResult）类型不对就整体视为无效，回落到初始值。
 *
 * D2-High-01：`isSearching` **不再**按持久化值恢复 —— 搜索队列是纯内存对象，
 * 恢复出来的 true 没有任何任务会把它改回 false（见 normalizeRestoredSearchPlan 的说明）。
 */
function sanitizeSearchData(raw: unknown): ISearchData | undefined {
  if (!isPlainRecord(raw)) return undefined;
  if (typeof raw.searchKey !== "string" || !Array.isArray(raw.searchResult)) return undefined;

  const data = initialSearchData();
  data.searchKey = raw.searchKey;
  data.searchResult = raw.searchResult;
  if (typeof raw.snapshot === "string") data.snapshot = raw.snapshot;
  if (typeof raw.startAt === "number") data.startAt = raw.startAt;
  if (typeof raw.endAt === "number") data.endAt = raw.endAt;
  if (typeof raw.searchPlanKey === "string") data.searchPlanKey = raw.searchPlanKey;
  if (isPlainRecord(raw.searchPlan)) {
    const { plan, interrupted } = normalizeRestoredSearchPlan(raw.searchPlan);
    data.searchPlan = plan;
    restoreInterruptions.search = interrupted;
  }
  // 无论持久化值是什么，恢复后都没有在跑的搜索任务
  data.isSearching = false;
  return data;
}

function sanitizeMediaServerSearchData(raw: unknown): IRuntimePiniaStorageSchema["mediaServerSearch"] | undefined {
  if (!isPlainRecord(raw)) return undefined;
  if (typeof raw.searchKey !== "string" || !Array.isArray(raw.searchResult)) return undefined;

  const data = initialMediaServerSearchData();
  data.searchKey = raw.searchKey;
  data.searchResult = raw.searchResult;
  // D2-High-01 孪生：媒体服务器搜索同样是纯内存队列
  if (raw.isSearching === true) {
    restoreInterruptions.mediaServerSearch = true;
  }
  data.isSearching = false;
  if (isPlainRecord(raw.searchStatus)) {
    data.searchStatus = copySafeRecord(raw.searchStatus);
  }
  return data;
}

function sanitizeUserInfo(raw: unknown): IRuntimePiniaStorageSchema["userInfo"] | undefined {
  if (!isPlainRecord(raw) || !isPlainRecord(raw.flushPlan)) return undefined;

  const flushPlan: Record<string, boolean> = {};
  for (const [siteId, value] of Object.entries(raw.flushPlan)) {
    if (typeof value === "boolean") {
      // F1-04：刷新任务在内存里，恢复出来的 true 永远等不到 finally 置 false
      if (value) {
        restoreInterruptions.userInfo = true;
      }
      flushPlan[siteId] = false;
    }
  }
  return { flushPlan: copySafeRecord(flushPlan) };
}

function restoreState(): Partial<IRuntimePiniaStorageSchema> {
  try {
    const raw = getSessionStorage()?.getItem(RUNTIME_STORE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainRecord(parsed)) {
      return {};
    }
    return {
      search: sanitizeSearchData(parsed.search),
      userInfo: sanitizeUserInfo(parsed.userInfo),
      mediaServerSearch: sanitizeMediaServerSearchData(parsed.mediaServerSearch),
    };
  } catch {
    return {};
  }
}

const restoredState = restoreState();

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: (() => IRuntimePiniaStorageSchema) | null = null;

function writeState(state: IRuntimePiniaStorageSchema, withResults: boolean): boolean {
  const storage = getSessionStorage();
  if (!storage) {
    return false;
  }

  try {
    storage.setItem(
      RUNTIME_STORE_KEY,
      JSON.stringify({
        ...state,
        search: withResults ? state.search : { ...state.search, searchResult: [] },
        mediaServerSearch: withResults ? state.mediaServerSearch : { ...state.mediaServerSearch, searchResult: [] },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }

  const getState = pendingState;
  pendingState = null;
  if (!getState) {
    return;
  }

  // 内容脚本：纯内存运行，绝不写宿主页面的 sessionStorage（也不该报「配额不足」）
  if (memoryOnly) {
    return;
  }

  const state = getState();
  // 配额不足时降级：保留搜索方案/进度等小数据，丢弃两部分搜索结果（早期实现会整份静默丢失）
  if (!writeState(state, true) && !writeState(state, false)) {
    console.warn("[PTD] runtime store persist failed (sessionStorage quota?)");
  }
}

function schedulePersist(getState: () => IRuntimePiniaStorageSchema) {
  if (memoryOnly) {
    return;
  }

  pendingState = getState;
  if (persistTimer === null) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      flushPersist();
    }, PERSIST_DELAY);
  }
}

// 页面被关闭/切到后台时立即落盘，避免丢失最近的改动
try {
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", flushPersist);
    document?.addEventListener?.("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushPersist();
      }
    });
  }
} catch {
  // ignore
}

export const useRuntimeStore = defineStore("runtime", {
  persistWebExt: false,
  state: (): IRuntimePiniaStorageSchema => ({
    search: restoredState.search ?? initialSearchData(),
    userInfo: restoredState.userInfo ?? {
      flushPlan: {},
    },
    mediaServerSearch: restoredState.mediaServerSearch ?? initialMediaServerSearchData(),
  }),

  getters: {
    searchCostTime(state) {
      const plans = Object.values(state.search.searchPlan).filter((plan) => plan.startAt);

      if (plans.length === 0) {
        return 0;
      }

      const now = Date.now();
      const startTimes = plans.map((plan) => plan.startAt!);
      const endTimes = plans.map((plan) => plan.endAt || (plan.costTime ? plan.startAt! + plan.costTime : now));

      const earliestStart = Math.min(...startTimes);
      const latestEnd = Math.max(...endTimes);

      return latestEnd - earliestStart;
    },

    isUserInfoFlush(state) {
      return Object.values(state.userInfo.flushPlan).some((v) => v);
    },
  },

  actions: {
    resetSearchData() {
      this.search = initialSearchData();
    },

    resetMediaServerSearchData() {
      this.mediaServerSearch = initialMediaServerSearchData();
    },

    showSnakebar(text: string, options: SnackbarMessageOptions = {}) {
      const { color = "info", timeout = 5000 } = options;
      const type = (["success", "error", "warning", "info"] as const).find((x) => x === color) ?? "info";
      message.open({ type, content: text, duration: timeout / 1000 });
    },

    /** 立即把当前状态写入 sessionStorage（默认由节流器在 500ms 后自动触发） */
    persistNow() {
      schedulePersist(() => this.$state as IRuntimePiniaStorageSchema);
      flushPersist();
    },
  },
});

/**
 * 订阅状态变化：这里只做「标记待保存」，真正的序列化由 schedulePersist 节流合并。
 *
 * 注意：必须在 pinia 实例创建后显式调用（见 `plugins/pinia.ts`），
 * 不能在模块顶层调用 `useRuntimeStore()`——那时 pinia 还没有被安装
 * （options 与 content-script 都存在这个问题）。
 */
export function setupRuntimeStorePersistence(store: ReturnType<typeof useRuntimeStore>) {
  store.$subscribe(
    () => {
      schedulePersist(() => store.$state as IRuntimePiniaStorageSchema);
    },
    { detached: true, flush: "post" },
  );
}

/**
 * D2-High-01 / F17 协作 API：把**当前 store 实例**里不可能还有对应任务的 in-flight 标记收尾。
 *
 * 恢复阶段（`sanitizeSearchData` / `sanitizeUserInfo`）已经自动做过一次；这里导出成显式函数，
 * 供 UI（F3 的 SearchEntity 在进入搜索页、或 `$onReady` 之后再调一次）兜底 ——
 * 覆盖「同一页面会话里队列被意外清空 / 其它上下文把状态写回」等恢复阶段之外的情形。
 *
 * 幂等：没有可收尾的状态时返回 `{search:false, mediaServerSearch:false, userInfo:false}`，不产生写入。
 *
 * 收尾语义（与 `SearchEntity/utils/search.ts` 的 `cancelSearchQueue()` 一致）：
 * - `search.isSearching → false`；
 * - `search.searchPlan[*]` 中 waiting/working → `passParse` + `statusMsg: "i18n.userCancel"`，并补 `endAt`；
 * - `mediaServerSearch.isSearching → false`；
 * - `userInfo.flushPlan[*]` 全部 → false。
 *
 * @param runtimeStore 目标 store 实例；省略时取当前 active pinia 的 runtime store。
 * @returns 每一块是否发生了改写（调用方可据此提示「上次搜索/刷新已被中断」）。
 */
export function reconcileRuntimeInFlightState(
  runtimeStore: ReturnType<typeof useRuntimeStore> = useRuntimeStore(),
): IRuntimeRestoreInterruptions {
  const result: IRuntimeRestoreInterruptions = { search: false, mediaServerSearch: false, userInfo: false };

  for (const plan of Object.values(runtimeStore.search.searchPlan ?? {})) {
    if (markSearchPlanInterrupted(plan as Record<string, any>)) {
      result.search = true;
    }
  }
  if (runtimeStore.search.isSearching) {
    runtimeStore.search.isSearching = false;
    result.search = true;
  }

  if (runtimeStore.mediaServerSearch.isSearching) {
    runtimeStore.mediaServerSearch.isSearching = false;
    result.mediaServerSearch = true;
  }

  for (const [siteId, isFlushing] of Object.entries(runtimeStore.userInfo.flushPlan ?? {})) {
    if (isFlushing) {
      runtimeStore.userInfo.flushPlan[siteId] = false;
      result.userInfo = true;
    }
  }

  return result;
}
