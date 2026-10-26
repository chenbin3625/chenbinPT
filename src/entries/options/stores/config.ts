/**
 * 所有和 ui 相关的选项均在本 store 管理
 */
import { defineStore } from "pinia";
import { has, unset } from "es-toolkit/compat";
import { usePreferredDark } from "@vueuse/core";

import type { IConfigPiniaStorageSchema, supportThemeType } from "@/shared/types.ts";
import { sendMessage } from "@/messages.ts";

// 注意：不要在这里 import "./metadata.ts" —— 会与 metadata.ts → config.ts 形成运行时循环依赖。
// metadata store 通过 metadataStoreBridge 惰性获取（对外 API getUserNames 保持不变）。
import { getMetadataStoreLazily } from "./metadataStoreBridge.ts";

const deprecatedConfigKeys = [
  "myDataTableControl.tableFontSize", // v0.0.4.961 废弃
  "myDataTableControl.joinTimeWeekOnly", // 已废弃，使用 joinTimeFormat 替代
  "showReleaseNoteOnVersionChange", // 已废弃，发布说明/欢迎弹窗已移除
  "version", // 已废弃，仅旧版本的发布说明弹窗使用
];

export const defaultTimelineBackgroundColor = "#455A64";
export const defaultTimelineUserNameColor = "#FFFFFF";
export const defaultTimelineTextColor = "#FFFFFF";

/**
 * `usePreferredDark()` 每次调用都会新建一个 ref 并注册一个 matchMedia 监听，
 * 之前它写在 `uiTheme` getter 里，而该 getter 会被多个 computed 反复求值
 * （themeVars / themeConfig / 组件模板），导致 auto 主题下不断泄漏监听。
 * 这里收成模块级单例：应用生命周期内只需要一个。
 */
const preferredDark = usePreferredDark();

function isContentScriptStorageContext(): boolean {
  try {
    const runtimeId = globalThis.chrome?.runtime?.id;
    const href = globalThis.location?.href;
    if (!runtimeId || typeof href !== "string") {
      return false;
    }
    const extensionBase = globalThis.chrome?.runtime?.getURL?.("");
    if (extensionBase && href.startsWith(extensionBase)) {
      return false;
    }
    return /^(https?|file):/.test(globalThis.location?.protocol ?? "");
  } catch {
    return false;
  }
}

export const useConfigStore = defineStore("config", {
  persistWebExt: {
    /**
     * F1-03：水合后的清理**绝不能抛错**。
     *
     * 插件把 `afterRestore` 放在 `restore().then(...)` 里、并在它之前就把 `$ready` 置为 true
     * （见 `extends/pinia/webExtPersistence.ts`）。一旦这里抛出（例如 storage 里的
     * `tableBehavior.DownloadHistory.sortBy` 被备份/手工改成了非数组，`.filter` 直接 TypeError），
     * `restorePromise` 会 reject → `$onReady()` 变成永久 rejected 的 Promise →
     * 所有 `await configStore.$onReady()` 的页面（MyClient 等）初始化静默中断，且每次刷新都重现。
     *
     * 因此：① 所有对持久化数据的结构假设都先做形状校验；② 整个清理过程包在 try/catch 里，
     * 失败只告警、保留恢复出来的状态（用户仍可通过「设置 → 插件重置」自救），不影响水合成功语义。
     */
    afterRestore: (context) => {
      try {
        const state = context.store.$state as any;
        let needsSave = false;

        // 清理已废弃的配置项
        for (const key of deprecatedConfigKeys) {
          if (has(state, key)) {
            unset(state, key);
            needsSave = true;
          }
        }

        // 清理基于 id 字段的 DownloadHistory 排序配置
        // （形状校验：非对象/非数组一律跳过清理，而不是让整个水合失败）
        const downloadHistoryBehavior = state.tableBehavior?.DownloadHistory;
        const sortBy = downloadHistoryBehavior?.sortBy;
        if (Array.isArray(sortBy)) {
          // 过滤掉基于 id 字段的排序项；顺带过滤形状不对的项（无 key / 非对象），
          // 避免表格排序读到半截数据后抛错
          const filteredSortBy = sortBy.filter(
            (sort: any) =>
              sort !== null && typeof sort === "object" && typeof sort.key === "string" && sort.key !== "id",
          );

          // 如果过滤后数组长度发生变化，说明移除了基于 id 的排序项
          if (filteredSortBy.length !== sortBy.length) {
            // 如果过滤后没有任何排序项，使用默认的 downloadAt 排序
            if (filteredSortBy.length === 0) {
              downloadHistoryBehavior.sortBy = [{ key: "downloadAt", order: "desc" }];
            } else {
              // 否则保留其他有效的排序项
              downloadHistoryBehavior.sortBy = filteredSortBy;
            }
            needsSave = true;
          }
        }

        if (needsSave) {
          // `$save()` 自己已经记录失败并返回 rejected Promise；这里再兜一次，避免 afterRestore 产生 unhandled rejection
          void context.store.$save().catch(() => undefined);
        }
      } catch {
        // 保留恢复出来的状态（不阻断水合）。这里刻意**不**记 console：本文件受 no-console 门禁约束，
        // 且该分支只可能来自被改坏的持久化数据；需要诊断时可在 devtools 里观察 $ready / 手工检查 config key。
        // 详见 docs/review-2026-10-23/fix-reports/f1-options-stores.md 的「需要 G 跟进」一节。
      }
    },
  },
  state: (): IConfigPiniaStorageSchema => ({
    lang: "zh_CN",
    theme: "light",
    isNavBarOpen: true,
    autoToggleNavBarOnDisplayChange: true,

    ignoreWrongPixelRatio: false,

    saveTableBehavior: true,
    enableTableMultiSort: false,

    contextMenus: {
      enabled: true,
      allowSelectionTextSearch: true,
      allowSocialLinkSearch: true,
      allowLinkDownloadPush: true,
    },

    contentScript: {
      enabled: true,
      enabledAtSocialSite: true,
      allowExceptionSites: false,

      position: { x: 0, y: 0 },

      applyTheme: false,
      defaultOpenSpeedDial: false,
      stackedButtons: false,
      fadeEnterStyle: false,

      doubleConfirmAction: true,
      dragLinkOnSpeedDial: true,

      socialSiteSearchBy: "chosen",
    },

    tableBehavior: {
      MyData: {
        itemsPerPage: 20,
        columns: [
          "siteUserConfig.sortIndex",
          "name",
          "levelName",
          "uploaded",
          "ratio",
          "uploads",
          "seeding",
          "seedingSize",
          "bonus",
          "joinTime",
          "updateAt",
          "action",
        ],
        sortBy: [{ key: "siteUserConfig.sortIndex", order: "desc" }],
      },
      SearchEntity: {
        itemsPerPage: 50,
        columns: [
          "site",
          "title",
          "category",
          "size",
          "seeders",
          "leechers",
          "completed",
          "comments",
          "time",
          "action",
        ],
        sortBy: [{ key: "time", order: "desc" }],
      },
      DownloadHistory: {
        itemsPerPage: 10,
        sortBy: [{ key: "downloadAt", order: "desc" }],
      },
      SearchResultSnapshot: {
        itemsPerPage: 25,
        sortBy: [{ key: "createdAt", order: "desc" }],
      },
      SetDownloader: {
        itemsPerPage: 10,
        sortBy: [{ key: "enabled", order: "desc" }],
      },
      MyClient: {
        itemsPerPage: 25,
        columns: [
          "clientId",
          "name",
          "totalSize",
          "progress",
          "state",
          "ratio",
          "uploadSpeed",
          "downloadSpeed",
          "dateAdded",
          "action",
        ],
        sortBy: [{ key: "dateAdded", order: "desc" }],
      },
      SetSearchSolution: {
        itemsPerPage: 10,
      },
      SetSite: {
        // 默认分页而非 -1（全部）：站点数可达数百，一次渲染整表会明显卡顿
        // （见 docs/performance-audit.md P2-5）；视图侧对历史遗留的非正数也做了兜底。
        itemsPerPage: 25,
        sortBy: [{ key: "userConfig.sortIndex", order: "desc" }],
      },
    },

    userName: "",

    myDataTableControl: {
      showSiteName: true,
      showUnreadMessage: true,
      showUserName: true,
      normalizeLevelName: true,
      showLevelRequirement: true,
      onlyShowUserLevelRequirement: true,
      showNextLevelInTable: false,
      showNextLevelInDialog: true,
      showHnR: true,
      showSeedingBonus: true,
      //joinTimeWeekOnly: false,
      joinTimeFormat: "added",
      updateAtFormatAsAlive: false,
      showIntervalAsDate: false,
      simplifyBonusNumbers: false,
      showBonusNeededInterval: true,
    },

    userDataTimelineControl: {
      title: "",
      showField: {
        uploads: true,
        uploaded: true,
        downloaded: true,
        seeding: true,
        seedingSize: true,
        bonus: true,
        bonusPerHour: true,
        ratio: true,
      },
      showPerSiteField: {
        siteName: false,
        name: true,
        level: true,
        uid: true,
      },
      showTop: true,
      showTimeline: true,
      backgroundColor: defaultTimelineBackgroundColor,
      userNameColor: defaultTimelineUserNameColor,
      textColor: defaultTimelineTextColor,
      dateFormat: "time_added",
      faviconBlue: 3,
      selectedSites: [],
    },

    userStatisticControl: {
      showChart: {
        totalSiteBase: true,
        totalSiteSeeding: true,
        perSiteKuploaded: true,
        perSiteKuploadedIncr: true,
        perSiteKdownloaded: true,
        perSiteKdownloadedIncr: true,
        perSiteKseeding: true,
        perSiteKseedingIncr: true,
        perSiteKseedingSize: true,
        perSiteKseedingSizeIncr: true,
        perSiteKbonus: true,
        perSiteKbonusIncr: true,
        perSiteKseedingBonus: false,
        perSiteKseedingBonusIncr: false,
      },
      dateRange: 30,
      hidePerSitePrecentThreshold: 1,
      selectedSites: [],
    },

    searchEntifyControl: {
      showSiteName: true,
      showTorrentTag: true,
      showTorrentSubtitle: true,
      showSocialInformation: true,
      socialInformationSearchOnNewTab: true,
      uploadAtFormatAsAlive: false,
      limitTorrentTitleTdWidth: true,
      highlightSameSizeTorrent: false,
      maxTagCountBeforeGroup: 0,
      hiddenTagNames: [],
      tagClickToFilter: true,
    },

    userInfo: {
      queueConcurrency: 5,
      autoReflush: {
        enabled: true,
        interval: 3, // hours
        afterTime: "00:00",
        retry: {
          max: 3,
          interval: 5, // minutes
        },
      },
      alwaysPickLastUserInfo: true,
      showDeadSiteInOverview: false,
      showPassedSiteInOverview: false,
    },

    download: {
      saveDownloadHistory: true,
      allowDownloaderFilterForSite: false,
      initDownloaderTorrentOnEnter: true,
      saveLastDownloader: false,
      allowDirectSendToClient: false,
      localDownloadMethod: "browser",
      ignoreSiteDownloadIntervalWhenLocalDownload: true,
      useQuickSendToClient: true,
    },

    searchEntity: {
      queueConcurrency: 8,

      allowSingleSiteSearch: false,
      treatTTQueryAsImdbSearch: true,

      saveLastFilter: true,
      forceImdbIdMatchFilter: true,
      autoDetectOfficialGroupFromTitle: false,

      showHotRecommendations: true,
    },

    mediaServerEntity: {
      queueConcurrency: 5,
      searchLimit: 50,
      autoSearchWhenMount: true,
      autoSearchMoreWhenScroll: true,
    },

    backup: {
      encryptionKey: "",
      enabledAutoBackup: false,
    },

    socialSiteInformation: {
      preferPtGen: true,
      timeout: 10e3,
      cacheDay: 7,
      socialSite: {
        anidb: {},
        bangumi: {},
        douban: {},
        imdb: {},
        tmdb: {},
        tvmaze: {},
      },
    },

    autoExtendCookies: {
      enabled: false,
      triggerThreshold: 2,
      extensionDuration: 3,
    },
  }),
  getters: {
    uiTheme(): Exclude<supportThemeType, "auto"> {
      if (this.theme === "auto") {
        return preferredDark.value ? "dark" : "light";
      }
      return this.theme;
    },

    isLightUiTheme(): boolean {
      return this.uiTheme === "light";
    },

    getUserName(): string {
      if (this.userName === "") {
        return this.getUserNames.perfName;
      } else {
        return this.userName;
      }
    },

    getUserNames(state) {
      // 这里只读 metadata store 的 lastUserInfo，通过 bridge 惰性获取以避免循环依赖。
      // bridge 未注册（metadata.ts 从未被求值）时 lastUserInfo 必然为空，返回空结果即可，
      // 与真实情况一致，因此对调用方而言 getUserNames 的语义/用法完全不变。
      const metadataStore = getMetadataStoreLazily();

      const userNames = {
        perfName: "",
        names: {} as Record<string, number>,
      };

      const allNames = Object.values(metadataStore?.lastUserInfo ?? {})
        .map((userInfo) => userInfo.name)
        .filter(Boolean) as string[];

      for (const name of allNames) {
        if (!userNames.names[name]) {
          userNames.names[name] = 0;
        }
        userNames.names[name]++;

        if (name !== userNames.perfName && userNames.names[name] > (userNames.names[userNames.perfName] ?? 0)) {
          userNames.perfName = name;
        }
      }

      return userNames;
    },
  },
  actions: {
    updateTableBehavior(table: string, key: string, data: any) {
      // @ts-expect-error table 为运行时动态表名，无法与 state.tableBehavior 的已知 key 对齐
      this.tableBehavior[table][key] = data;
      if (this.saveTableBehavior) {
        this.$save();
      }
    },

    updateContentScriptPosition(x: number, y: number) {
      this.contentScript.position.x = x;
      this.contentScript.position.y = y;
      if (isContentScriptStorageContext()) {
        void sendMessage("patchExtStoragePath", {
          key: "config",
          path: "contentScript.position",
          value: { x, y },
        });
        return;
      }
      this.$save();
    },
  },
});
