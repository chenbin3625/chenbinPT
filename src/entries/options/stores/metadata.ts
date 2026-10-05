import { nanoid } from "nanoid";
import { defineStore } from "pinia";
import { isEmpty, set } from "es-toolkit/compat";
import { i18n } from "@/options/plugins/i18n.ts";
import {
  getHostFromUrl,
  getDefinedSiteMetadata,
  type ISearchCategories,
  type ISearchEntryRequestConfig,
  type ISiteMetadata,
  type ISiteUserConfig,
  type TSiteHost,
  type TSiteID,
} from "@ptd/site";

import {
  IBackupServerMetadata,
  IDownloaderMetadata,
  IMediaServerMetadata,
  IMetadataPiniaStorageSchema,
  ISearchSolution,
  TDownloaderKey,
  TMediaServerKey,
  TSearchSnapshotKey,
  TSolutionKey,
  ISearchSolutionMetadata,
} from "@/shared/types.ts";
import { sendMessage } from "@/messages.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { registerMetadataStoreAccessor } from "./metadataStoreBridge.ts";

type TSimplePatchFieldKey = keyof Pick<
  IMetadataPiniaStorageSchema,
  "sites" | "solutions" | "snapshots" | "downloaders" | "mediaServers" | "backupServers"
>;

/** 去抖写入只需要插件的 `$save()`，不依赖 pinia 的内部结构（也便于在单测里替换） */
type TSaveableStore = { $save: () => Promise<void> };

/**
 * V-8：metadata 写入的短去抖合并（对照 runtime.ts 的 sessionStorage 500ms 节流）。
 *
 * 设置页每点一个开关都会走 `simplePatch` → `$save()`，而 `$save()` 会
 * `toWriteSnapshot(整份 state)` 全量序列化（含所有站点配置与 lastUserInfo）并把整个
 * `"metadata"` key 写回 —— runtime.ts 早已因为同样的原因专门脱离了这条路径。
 * 这里在调用方侧加一层 500ms 合并窗口 + pagehide/visibilitychange flush：
 * - 窗口内的多次保存只落盘一次（连续开关、批量导入/删除都合并成一次写入）；
 * - **刻意不返回 Promise**：像 runtime.ts 的 schedulePersist 一样是「登记待保存」，
 *   调用方不会被去抖窗口阻塞（否则逐个 await addSite 的批量导入会变成每个站点 500ms）；
 *   需要「返回即已落盘」的场景继续直接用 `metadataStore.$save()`（插件语义未变）。
 * - webExtPersistence 自身的回声抑制与「单飞 + 尾部合并」保持不变，这里只减少调用次数。
 *
 * 按 store 实例分别记录（而不是模块级单例），这样多个 pinia 实例（如单测）也不会互相顶掉写入。
 */
const SAVE_MERGE_DELAY = 500;

const pendingSaveTimers = new Map<TSaveableStore, ReturnType<typeof setTimeout>>();

function flushMetadataSave(store: TSaveableStore): void {
  const timer = pendingSaveTimers.get(store);
  if (timer === undefined) {
    return;
  }
  // 先摘除再写盘：写盘期间新到的调用会重新排一次窗口，不会被本次 flush 吞掉
  pendingSaveTimers.delete(store);
  clearTimeout(timer);

  // 写盘失败由 webExtPersistence 记录（doWrite 内部 catch），这里无需等待结果
  void store.$save();
}

/** 立即落盘所有待保存的 store（页面卸载/隐藏时调用） */
function flushAllMetadataSaves(): void {
  [...pendingSaveTimers.keys()].forEach((store) => flushMetadataSave(store));
}

function scheduleMetadataSave(store: TSaveableStore): void {
  if (pendingSaveTimers.has(store)) {
    return; // 已在本轮合并窗口内，等窗口结束时会写入最新 state
  }

  const timer = setTimeout(() => {
    flushMetadataSave(store);
  }, SAVE_MERGE_DELAY);
  pendingSaveTimers.set(store, timer);
}

// 页面被关闭/切到后台时立即落盘，避免去抖窗口内的改动丢失（与 runtime.ts 的做法一致）
try {
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", flushAllMetadataSaves);
    document?.addEventListener?.("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushAllMetadataSaves();
      }
    });
  }
} catch {
  // ignore
}

/**
 * V-7：站点映射重建的合并状态。
 *
 * `addSite`/`removeSite` 每次都会重建整张站点映射：`buildSiteNameMap` 对每个站点调用
 * `getSiteName`（动态 import + cloneDeep 站点定义），`buildSiteHostMap` 再遍历一次；
 * 而 `components/DeleteDialog.vue` 用 `Promise.allSettled` 并发调用 `removeSite` ——
 * 删 50 个站点就是 50 轮 O(N) 全量重建（外加 50 次整状态写入，已由上面的去抖合并）。
 *
 * 这里按 store 实例记录「站点变更版本号」，让并发调用共享同一轮重建，并在重建期间仍有
 * 变更时补跑一轮：50 次并发删除最多重建 2 轮，且每个调用返回时映射已覆盖自己的变更。
 * 用 WeakMap 而不是 pinia state —— 其中包含 Promise，既不该响应式追踪也不该被持久化。
 */
interface ISiteMapRebuildState {
  version: number; // 最近一次站点变更（addSite/removeSite）的版本号
  builtVersion: number; // 最近一次完成的重建所覆盖的版本号
  inFlight: Promise<void> | null; // 正在进行的重建
}

const siteMapRebuildStates = new WeakMap<object, ISiteMapRebuildState>();

function getSiteMapRebuildState(store: object): ISiteMapRebuildState {
  let state = siteMapRebuildStates.get(store);
  if (!state) {
    // builtVersion 从 -1 开始：首次调用必定重建一次（与修复前的行为一致）
    state = { version: 0, builtVersion: -1, inFlight: null };
    siteMapRebuildStates.set(store, state);
  }
  return state;
}

export const useMetadataStore = defineStore("metadata", {
  persistWebExt: true,
  state: (): IMetadataPiniaStorageSchema => ({
    sites: {},
    solutions: {},
    snapshots: {},
    downloaders: {},
    mediaServers: {},
    backupServers: {},

    defaultSolutionId: "default",
    defaultDownloader: {},

    lastSearchFilter: "",
    lastUserInfo: {},
    lastDownloader: {},
    lastKeepUpload: {},
    lastUserInfoAutoFlushAt: 0,

    siteHostMap: {},
    siteNameMap: {},
  }),

  getters: {
    getAddedSiteIds(state) {
      return Object.keys(state.sites);
    },

    getAddedSites(state) {
      return Object.entries(state.sites).map(([siteId, metadata]) => {
        return { ...metadata, id: siteId };
      });
    },

    getSortedAddedSites(state): Array<ISiteUserConfig & { id: string }> {
      return this.getAddedSites.sort((a, b) => {
        return (b.sortIndex ?? 0) - (a.sortIndex ?? 0);
      });
    },

    getSitesGroupData(state) {
      const sitesGroupData: Record<string, TSiteID[]> = {};
      for (const siteId in state.sites) {
        const site = state.sites[siteId];
        if (site.groups) {
          for (const group of site.groups) {
            sitesGroupData[group] ??= [];
            sitesGroupData[group].push(siteId);
          }
        }
      }
      return sitesGroupData;
    },

    getSiteMetadata(state) {
      return async (siteId: TSiteID): Promise<ISiteMetadata> => {
        return await getDefinedSiteMetadata(siteId);
      };
    },

    getSiteUserConfig(state) {
      return async (siteId: TSiteID, flush: boolean = false): Promise<ISiteUserConfig> => {
        const siteUserConfig = state.sites[siteId] ?? {};
        if (flush || isEmpty(siteUserConfig)) {
          return await sendMessage("getSiteUserConfig", { siteId, flush });
        }
        return siteUserConfig;
      };
    },

    getSiteMergedMetadata(state) {
      return async <T extends keyof ISiteMetadata>(
        siteId: TSiteID,
        field: T,
        defaultValue?: ISiteMetadata[T],
      ): Promise<ISiteMetadata[T]> => {
        const siteConfig = await this.getSiteUserConfig(siteId);
        if (siteConfig.merge?.[field]) {
          return siteConfig.merge[field];
        }
        const siteMetadata = await this.getSiteMetadata(siteId);
        return siteMetadata[field] ?? (defaultValue as ISiteMetadata[T]);
      };
    },

    getSiteName(state) {
      return async (siteId: TSiteID): Promise<string> => {
        return await this.getSiteMergedMetadata(siteId, "name", siteId);
      };
    },

    getSiteUrl(state) {
      return async (siteId: TSiteID): Promise<string> => {
        const siteConfig = await this.getSiteUserConfig(siteId);
        if (siteConfig.url) {
          return siteConfig.url;
        }
        const siteMetadata = await this.getSiteMetadata(siteId);
        return siteMetadata.urls?.[0] ?? "#";
      };
    },

    getSiteCategory(state) {
      return async (siteId: TSiteID, categoryKey?: string): Promise<ISearchCategories | ISearchCategories[]> => {
        const siteMetadataCategory = await this.getSiteMergedMetadata(siteId, "category", []);
        if (categoryKey) {
          return siteMetadataCategory?.find((x) => x.key === categoryKey) as ISearchCategories;
        }
        return siteMetadataCategory as ISearchCategories[];
      };
    },

    getSiteCategoryName(state) {
      return async (siteId: TSiteID, categoryKey: string): Promise<string> => {
        const siteMetadataCategory = (await this.getSiteCategory(siteId, categoryKey)) as ISearchCategories;
        return siteMetadataCategory?.name ?? categoryKey;
      };
    },

    getSiteCategoryOptionName(state) {
      return async (
        siteId: TSiteID,
        categoryKey: string,
        optionKey: string | number | (string | number)[],
      ): Promise<string> => {
        const siteMetadataCategory = (await this.getSiteCategory(siteId, categoryKey)) as ISearchCategories;
        const options = siteMetadataCategory?.options ?? [];
        if (Array.isArray(optionKey)) {
          return optionKey.map((v) => options.find((o) => o.value === v)?.name ?? v).join(", ");
        } else {
          return options.find((o) => o.value === optionKey)?.name ?? (optionKey as string);
        }
      };
    },

    getSearchSolutionIds(state) {
      return Object.keys(state.solutions);
    },

    getSearchSolutions(state) {
      return Object.values(state.solutions);
    },

    getSiteDefaultSearchSolution(state) {
      // 如果站点 isDead 或者 isOffline 则不返回搜索方案（ undefined ），调用该方法的地方需要额外判断
      return async (siteId: TSiteID): Promise<Record<string, ISearchEntryRequestConfig> | undefined> => {
        // B-13：站点配置可能不存在 —— 方案里引用的站点已被 removeSite 删除，或方案来自导入/备份/
        // URL 深链（site:xxx）指向了未添加的站点。修复前这里是裸解引用，而下面的
        // getDefinedSiteMetadata 对不在构建产物里的站点 id 会抛 TypeError → 整次搜索中断。
        const siteUserConfig = state.sites[siteId];
        if (!siteUserConfig) {
          return;
        }
        const siteMetadata = await getDefinedSiteMetadata(siteId);

        if (siteUserConfig.isOffline || siteMetadata.isDead) {
          return;
        }

        let searchEntries = siteMetadata.searchEntry ?? { default: {} };
        for (const [key, value] of Object.entries(siteUserConfig?.merge?.searchEntry ?? {})) {
          if (searchEntries[key] && typeof value.enabled === "boolean") {
            /**
             * 由于我们需要通过 sendMessage 向 offscreen 发送搜索方案，然而 sendMessage 不支持 Function 等复杂类型，
             * 所以我们这里只传递 id, name, enabled，其他的搜索方案的内容在 站点实例里面组合
             */
            searchEntries[key] = { id: key, name: searchEntries[key].name, enabled: value.enabled };
          }
        }
        return searchEntries;
      };
    },

    getSearchSolution(state) {
      return async (
        solutionId: TSolutionKey | `site:${string}` | "default" | "all",
      ): Promise<ISearchSolutionMetadata | undefined> => {
        // 首先判断是否是约定的 "all"  "default"  "site:xxx,xxx" 站点搜索方案
        if (
          // 全部站点
          solutionId === "all" ||
          (solutionId === "default" && state.defaultSolutionId === "default") ||
          // 特定站点
          solutionId.startsWith("site:")
        ) {
          const solutions: ISearchSolution[] = [];

          let addedSiteIds = Object.keys(state.sites);
          if (solutionId.startsWith("site:")) {
            addedSiteIds = solutionId
              .slice(5) //  /^site:/
              .split(",")
              .map((id) => id.trim());
          }

          for (const siteId of addedSiteIds) {
            const searchEntries = await this.getSiteDefaultSearchSolution(siteId);
            if (searchEntries) {
              solutions.push({ id: "default", siteId, searchEntries });
            }
          }

          return {
            name: "all",
            id: solutionId.startsWith("site:") ? (solutionId as `site:${string}`) : "all",
            sort: 0,
            enabled: true,
            isDefault: true,
            createdAt: 0,
            solutions,
          };
        } else if (solutionId === "default") {
          // 如果 solutionId 是 "default"，则使用默认的搜索方案 ID
          solutionId = state.defaultSolutionId;
        }

        // B-13：方案不存在时返回 undefined，而不是抛 TypeError。
        // 调用方本来就处理了这种情况（SearchEntity/utils/search.ts 的「搜索方案不存在」提示、
        // SetSearchSolution/Index.vue 的 `if (!toCopy) return`），修复前它们是不可达的死代码。
        const solution = state.solutions[solutionId];
        if (!solution) {
          return undefined;
        }

        // 对于已经存在的搜索方案，其中如果有 id === "default" 的特殊情况，将其动态解开。
        //
        // B-8：getter 内**绝不改写** state.solutions —— 修复前这里把截断后的数组写回 `solution.solutions`
        // （state 活引用），而 getSiteDefaultSearchSolution 在站点 isOffline/isDead/已删除时返回 undefined，
        // 于是「取不到就整条丢弃」会永久删除用户方案里的站点（该函数在每次搜索开始时都会被调用，
        // 随后任意 $save() 就会把删减结果落盘）。这里只构造本地数组并返回浅拷贝。
        const solutionItems: ISearchSolution[] = [];
        for (const solutionItem of solution.solutions) {
          if (solutionItem.id === "default") {
            const searchEntries = await this.getSiteDefaultSearchSolution(solutionItem.siteId);
            if (searchEntries) {
              solutionItems.push({ ...solutionItem, searchEntries });
            }
          } else {
            solutionItems.push({ ...solutionItem });
          }
        }

        return { ...solution, solutions: solutionItems };
      };
    },

    getSearchSolutionName(state) {
      return (solutionId: TSolutionKey): string => {
        if (solutionId === "all") {
          return "全站"; // FIXME i18n
        }

        return state.solutions[solutionId]?.name ?? solutionId;
      };
    },

    getSearchSnapshotList(state) {
      return Object.values(state.snapshots);
    },

    getSearchSnapshotData(state) {
      return async (id: TSearchSnapshotKey) => {
        const snapshotInfo = state.snapshots[id];
        if (snapshotInfo?.id) {
          return await sendMessage("getSearchResultSnapshotData", id);
        } else {
          const runtimeStorage = useRuntimeStore();
          runtimeStorage.showSnakebar(i18n.t("SearchResultSnapshot.notFound"), { color: "error" });
          return;
        }
      };
    },

    getDownloaderIds(state) {
      return Object.keys(state.downloaders);
    },

    getDownloaders(state) {
      return Object.values(state.downloaders);
    },

    getEnabledDownloaders(state) {
      return Object.values(state.downloaders).filter((downloader) => downloader.enabled);
    },

    getSortedEnabledDownloaders(state): Array<IDownloaderMetadata> {
      return this.getEnabledDownloaders.sort((a, b) => {
        return (b.sortIndex ?? 0) - (a.sortIndex ?? 0);
      });
    },

    getEnabledDownloadersBySite(state) {
      return (siteId: string): IDownloaderMetadata[] => {
        const configStore = useConfigStore();
        if (!configStore.download.allowDownloaderFilterForSite) {
          return this.getEnabledDownloaders;
        }
        return this.getEnabledDownloaders.filter((d) => !d.excludedSites?.includes(siteId));
      };
    },

    getSortedEnabledDownloadersBySite(state) {
      return (siteId: string): IDownloaderMetadata[] => {
        return [...this.getEnabledDownloadersBySite(siteId)].sort((a, b) => {
          return (b.sortIndex ?? 0) - (a.sortIndex ?? 0);
        });
      };
    },

    getMediaServerIds(state) {
      return Object.keys(state.mediaServers);
    },

    getMediaServers(state) {
      return Object.values(state.mediaServers);
    },

    getEnabledMediaServers(state) {
      return Object.values(state.mediaServers).filter((mediaServer) => mediaServer.enabled);
    },

    getBackupServerIds(state) {
      return Object.keys(state.backupServers);
    },

    getBackupServers(state) {
      return Object.values(state.backupServers);
    },
  },
  actions: {
    async simplePatch<
      Field extends TSimplePatchFieldKey,
      Id extends keyof IMetadataPiniaStorageSchema[Field],
      Key extends keyof IMetadataPiniaStorageSchema[Field][Id],
      Value extends IMetadataPiniaStorageSchema[Field][Id][Key],
    >(schemaKey: Field, id: Id, key: Key | string, value: Value | any) {
      // V-6：目标不存在时 `set()` 是静默 no-op（典型场景：另一个标签页已删除该行，本页仍在编辑），
      // 而修复前仍会执行一次 `$save()`：修改被丢弃，却付出一次整状态序列化 + 整 key 写入。
      // 这里提前判断并告知用户，不再落盘。
      const target = this[schemaKey][id];
      if (!target) {
        useRuntimeStore().showSnakebar(
          i18n.t("SearchResultSnapshot.updateNotSaved", {
            schema: String(schemaKey),
            id: String(id),
          }),
          { color: "error" },
        );
        return;
      }

      set(target, key, value);
      scheduleMetadataSave(this);
    },

    async addSite(siteId: TSiteID, siteConfig: ISiteUserConfig, options?: { reBuildMap?: boolean }) {
      const { reBuildMap = true } = options ?? {};

      delete siteConfig.valid;
      this.sites[siteId] = siteConfig;
      // V-7：无条件登记站点变更版本 —— 即使本次不重建（批量导入的中间态），
      // 之后的 buildSiteMapCache() 也能据此补上重建。
      getSiteMapRebuildState(this).version++;

      if (reBuildMap) {
        await this.buildSiteMapCache(false);
      }

      scheduleMetadataSave(this);
    },

    async removeSite(siteId: TSiteID, options?: { reBuildMap?: boolean }) {
      const { reBuildMap = true } = options ?? {};

      delete this.sites[siteId];
      getSiteMapRebuildState(this).version++; // V-7：见 addSite

      // B-13：级联清理对已删除站点的引用。
      // 修复前只做 `delete this.sites[siteId]`，于是方案里保留着指向该站点的条目
      // （运行方案时会走到 getSiteDefaultSearchSolution 的裸解引用 / 抛错），
      // lastUserInfo 也会留下永不更新的孤儿记录。
      for (const solution of Object.values(this.solutions)) {
        solution.solutions = solution.solutions.filter((solutionItem) => solutionItem.siteId !== siteId);
      }
      delete this.lastUserInfo[siteId];

      if (reBuildMap) {
        await this.buildSiteMapCache(false);
      }

      scheduleMetadataSave(this);
    },

    /**
     * 在添加、编辑站点时调用，重新生成 host 对站点的映射，
     * 便于 content-script 等其他地方通过 (await extStorage.getItem('metadata')).siteHostMap[host] 获取站点 ID
     */
    async buildSiteHostMap() {
      const siteHostMap: Record<TSiteHost, TSiteID> = {};
      for (const siteId in this.sites) {
        const site = this.sites[siteId];
        if (site.url) {
          siteHostMap[getHostFromUrl(site.url)] = siteId;
        }
        const urls = await this.getSiteMergedMetadata(siteId, "urls", []);
        if (urls.length > 0) {
          for (const url of urls) {
            siteHostMap[getHostFromUrl(url)] = siteId;
          }
        }
        const legacyUrls = (await this.getSiteMergedMetadata(siteId, "legacyUrls", []))!;
        if (legacyUrls.length > 0) {
          for (const url of legacyUrls) {
            siteHostMap[getHostFromUrl(url)] = siteId;
          }
        }
      }
      this.siteHostMap = siteHostMap;
      await this.syncSiteIndex();
    },

    async buildSiteNameMap() {
      const siteNameMap: Record<TSiteID, string> = {};
      for (const siteId in this.sites) {
        siteNameMap[siteId] = await this.getSiteName(siteId);
      }
      this.siteNameMap = siteNameMap;
      await this.syncSiteIndex();
    },

    /**
     * 把 host/name 索引同步到独立的 siteIndex key（见 docs/performance-audit.md P2-17）。
     * metadata 可能很大且会被高频写入反复失效，content script / 右键菜单只需要这个小表。
     */
    async syncSiteIndex() {
      await sendMessage("setExtStorage", {
        key: "siteIndex",
        value: { siteHostMap: this.siteHostMap, siteNameMap: this.siteNameMap },
      });
    },

    async buildSiteMapCache(save: boolean = false) {
      // V-7：把并发调用合并到同一轮重建；重建期间又有站点变更时补跑一轮，
      // 保证每个调用返回时映射已覆盖自己这次的变更（见 ISiteMapRebuildState 的注释）。
      const rebuildState = getSiteMapRebuildState(this);

      while (rebuildState.builtVersion < rebuildState.version) {
        if (rebuildState.inFlight) {
          await rebuildState.inFlight;
          continue;
        }

        const targetVersion = rebuildState.version;
        const flight = (async () => {
          await this.buildSiteNameMap();
          await this.buildSiteHostMap();
        })().then(() => {
          // 只记录「开始重建时」的版本：期间的变更由外层 while 再补跑一轮
          rebuildState.builtVersion = targetVersion;
        });

        rebuildState.inFlight = flight.finally(() => {
          rebuildState.inFlight = null;
        });
        await rebuildState.inFlight;
      }

      if (save) {
        scheduleMetadataSave(this);
      }
    },

    async addSearchSolution(solution: ISearchSolutionMetadata) {
      this.solutions[solution.id] = solution;
      scheduleMetadataSave(this);
    },

    async removeSearchSolution(solutionId: TSolutionKey) {
      delete this.solutions[solutionId];

      if (this.defaultSolutionId === solutionId) {
        this.defaultSolutionId = "default";
      }

      scheduleMetadataSave(this);
    },

    async saveSearchSnapshotData(name: string) {
      const runtimeStorage = useRuntimeStore();
      const searchSnapshotData = runtimeStorage.search;

      if (searchSnapshotData.isSearching) {
        runtimeStorage.showSnakebar(i18n.t("SearchResultSnapshot.cannotSaveWhileSearching"), { color: "error" });
        return;
      }

      const snapshotId = nanoid();
      this.snapshots[snapshotId] = {
        id: snapshotId,
        name,
        createdAt: Date.now(),
        recordCount: searchSnapshotData.searchResult.length,
      };

      // 保存搜索快照数据
      await sendMessage("saveSearchResultSnapshotData", { snapshotId, data: searchSnapshotData });

      scheduleMetadataSave(this);
    },

    async editSearchSnapshotDataName(id: TSearchSnapshotKey, name: string) {
      this.snapshots[id].name = name;
      scheduleMetadataSave(this);
    },

    async removeSearchSnapshotData(id: TSearchSnapshotKey) {
      delete this.snapshots[id]; // 删除搜索快照元数据
      await sendMessage("removeSearchResultSnapshotData", id); // 删除搜索快照数据
      scheduleMetadataSave(this);
    },

    async addDownloader(downloaderConfig: IDownloaderMetadata) {
      delete downloaderConfig.valid;
      this.downloaders[downloaderConfig.id] = downloaderConfig;
      scheduleMetadataSave(this);
    },

    async removeDownloader(downloaderId: TDownloaderKey) {
      delete this.downloaders[downloaderId];
      scheduleMetadataSave(this);
    },

    async setLastSearchFilter(filter: string) {
      this.lastSearchFilter = (filter ?? "").replace(/\s*site:\S+/g, "").trim();
      scheduleMetadataSave(this);
    },

    async setLastDownloader(downloader: IMetadataPiniaStorageSchema["lastDownloader"]) {
      this.lastDownloader = downloader;
      scheduleMetadataSave(this);
    },

    async addMediaServer(mediaServerConfig: IMediaServerMetadata) {
      this.mediaServers[mediaServerConfig.id] = mediaServerConfig;
      scheduleMetadataSave(this);
    },

    async removeMediaServer(mediaServerId: TMediaServerKey) {
      delete this.mediaServers[mediaServerId];
      scheduleMetadataSave(this);
    },

    async addBackupServer(backupServerConfig: IBackupServerMetadata) {
      this.backupServers[backupServerConfig.id] = backupServerConfig;
      scheduleMetadataSave(this);
    },

    async removeBackupServer(backupServerId: string) {
      delete this.backupServers[backupServerId];
      scheduleMetadataSave(this);
    },
  },
});

// 注册给 config store 的惰性访问器（见 metadataStoreBridge.ts）：
// config.ts 需要读 metadata 的 lastUserInfo，但直接 import 会形成循环依赖，
// 因此由本模块在求值完成时把 store 工厂登记到 bridge 里。
registerMetadataStoreAccessor(useMetadataStore);
