import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";
import {
  ApiOutlined,
  AppstoreOutlined,
  BgColorsOutlined,
  CameraOutlined,
  CloudDownloadOutlined,
  DashboardOutlined,
  GlobalOutlined,
  HistoryOutlined,
  MergeCellsOutlined,
  NodeIndexOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  UserOutlined,
} from "@ant-design/icons-vue";

export const setBaseChildren: RouteRecordRaw[] = [
  {
    path: "",
    alias: "ui",
    name: "SetBaseUi",
    meta: { icon: BgColorsOutlined },
    component: () => import("../views/Settings/SetBase/UiWindow.vue"),
  },
  {
    path: "search-entity",
    name: "SetBaseSearchEntity",
    meta: { icon: SearchOutlined },
    component: () => import("../views/Settings/SetBase/SearchEntityWindow.vue"),
  },
  {
    path: "download",
    name: "SetBaseDownload",
    meta: { icon: CloudDownloadOutlined },
    component: () => import("../views/Settings/SetBase/DownloadWindow.vue"),
  },
  {
    path: "user-info",
    name: "SetBaseUserInfo",
    meta: { icon: UserOutlined },
    component: () => import("../views/Settings/SetBase/UserInfoWindow.vue"),
  },
  {
    path: "native-bridge",
    name: "SetBaseNativeBridge",
    meta: { icon: ApiOutlined, usesGlobalSave: false },
    component: () => import("../views/Settings/SetBase/NativeBridgeWindow.vue"),
  },
  {
    path: "backup",
    name: "SetBaseBackup",
    meta: { icon: HistoryOutlined },
    component: () => import("../views/Settings/SetBase/BackupWindow.vue"),
  },
  {
    path: "social-information",
    name: "SetBaseSocialInformation",
    meta: { icon: PictureOutlined },
    component: () => import("../views/Settings/SetBase/SocialInformationWindow.vue"),
  },
  {
    // 插件重置 / 清空数据（原 Devtools/Debugger.vue 的 7 项重置操作入口，见 functional-audit SH-01）
    // 各项操作即时生效、无需保存，故不显示底部的全局保存按钮
    path: "reset",
    name: "SetBaseReset",
    meta: { icon: ReloadOutlined, usesGlobalSave: false },
    component: () => import("../views/Settings/SetBase/ResetWindow.vue"),
  },
] as const;

export const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "Overview",
    meta: { isMainMenu: true },
    children: [
      {
        path: "/my-data",
        name: "MyData",
        alias: "",
        meta: { icon: DashboardOutlined },
        component: () => import("../views/Overview/MyData/Index.vue"),
      },
      {
        path: "/search-entity",
        name: "SearchEntity",
        meta: { icon: SearchOutlined },
        component: () => import("../views/Overview/SearchEntity/Index.vue"),
      },
      {
        path: "/search-result-snapshot",
        name: "SearchResultSnapshot",
        meta: { icon: CameraOutlined },
        component: () => import("../views/Overview/SearchResultSnapshot/Index.vue"),
      },
      {
        path: "/media-server-entity",
        name: "MediaServerEntity",
        meta: { icon: PlayCircleOutlined },
        component: () => import("../views/Overview/MediaServerEntity/Index.vue"),
      },
      {
        path: "/my-client",
        name: "MyClient",
        meta: { icon: CloudDownloadOutlined },
        component: () => import("../views/Overview/MyClient/Index.vue"),
      },
      {
        path: "/download-history",
        name: "DownloadHistory",
        meta: { icon: HistoryOutlined },
        component: () => import("../views/Overview/DownloadHistory/Index.vue"),
      },
      {
        path: "/keep-upload-task",
        name: "KeepUploadTask",
        meta: { icon: MergeCellsOutlined },
        component: () => import("../views/Overview/KeepUploadTask/Index.vue"),
      },
    ],
  },
  {
    path: "/settings",
    name: "Settings",
    redirect: "/set-base",
    meta: { isMainMenu: true },
    children: [
      {
        path: "/set-base",
        name: "SetBase",
        redirect: { name: "SetBaseUi" },
        meta: { icon: SettingOutlined },
        component: () => import("../views/Settings/SetBase/Index.vue"),
        children: setBaseChildren,
      },
      {
        path: "/set-site",
        name: "SetSite",
        meta: { icon: GlobalOutlined },
        component: () => import("../views/Settings/SetSite/Index.vue"),
      },
      {
        path: "/set-search-solution",
        name: "SetSearchSolution",
        meta: { icon: AppstoreOutlined },
        component: () => import("../views/Settings/SetSearchSolution/Index.vue"),
      },
      {
        path: "/set-downloader",
        name: "SetDownloader",
        meta: { icon: CloudDownloadOutlined },
        component: () => import("../views/Settings/SetDownloader/Index.vue"),
      },
      {
        path: "/set-media-server",
        name: "SetMediaServer",
        meta: { icon: NodeIndexOutlined },
        component: () => import("../views/Settings/SetMediaServer/Index.vue"),
      },
      {
        path: "/set-backup",
        name: "SetBackup",
        meta: { icon: HistoryOutlined },
        component: () => import("../views/Settings/SetBackup/Index.vue"),
      },
    ],
  },
  {
    path: "/user-data-timeline",
    name: "UserDataTimeline",
    meta: { isMainMenu: false },
    component: () => import("../views/Overview/MyData/UserDataTimeline/Index.vue"),
  },

  {
    path: "/user-data-statistic",
    name: "UserDataStatistic",
    meta: { isMainMenu: false },
    component: () => import("../views/Overview/MyData/UserDataStatistic/Index.vue"),
  },

  {
    path: "/link-push",
    name: "ContextMenuLinkPush",
    meta: { isMainMenu: false },
    component: () => import("../views/ContextMenuLinkPush.vue"),
  },

  { path: "/:pathMatch(.*)*", name: "NotFound", redirect: "/" },
];

/** 「常规设置」各页签的路由名（同属 SetBase 一个页面的子路由） */
const setBaseTabNames = new Set(setBaseChildren.map((child) => String(child.name)));

export const routerInstance = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior(to, from, savedPosition) {
    // 浏览器前进 / 后退：恢复历史滚动位置
    if (savedPosition) return savedPosition;

    // 「常规设置」的页签内容高度差异很大：若保留上一页签的 window.scrollY，
    // 从长页签底部切到短页签时浏览器会把滚动位置夹到新内容底部，看起来像自动跳底。
    const isSetBaseTab = (route: typeof to) => typeof route.name === "string" && setBaseTabNames.has(route.name);
    if (isSetBaseTab(to) && isSetBaseTab(from)) return { top: 0 };

    return { el: "#ptd-main", top: 0 };
  },
});
