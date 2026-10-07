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
    afterRestore: (context) => {
      // 清理已废弃的配置项
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
      if (state.tableBehavior?.DownloadHistory?.sortBy) {
        const sortBy = state.tableBehavior.DownloadHistory.sortBy;
        // 过滤掉基于 id 字段的排序项
        const filteredSortBy = sortBy.filter((sort: any) => sort.key !== "id");

        // 如果过滤后数组长度发生变化，说明移除了基于 id 的排序项
        if (filteredSortBy.length !== sortBy.length) {
          // 如果过滤后没有任何排序项，使用默认的 downloadAt 排序
          if (filteredSortBy.length === 0) {
            state.tableBehavior.DownloadHistory.sortBy = [{ key: "downloadAt", order: "desc" }];
          } else {
            // 否则保留其他有效的排序项
            state.tableBehavior.DownloadHistory.sortBy = filteredSortBy;
          }
          needsSave = true;
        }
      }

      if (needsSave) {
        context.store.$save();
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
