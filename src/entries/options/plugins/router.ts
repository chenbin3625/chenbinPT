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
  StarOutlined,
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
        path: "/my-collection",
        name: "MyCollection",
        meta: { icon: StarOutlined },
        component: () => import("../views/Overview/MyCollection/Index.vue"),
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

/**
 * 主区滚动位置记忆（供 scrollBehavior 在前进/后退时恢复）。
 *
 * 页面实际的滚动容器是 `#ptd-main`（见 style.css：固定视口高度 + overflow:auto，
 * 也是表头 sticky 的前提），window 不再滚动。于是 vue-router 自带的 `savedPosition`
 * 永远是从 `window.scrollY` 采到的 `{left:0, top:0}` —— 既不能恢复位置，值得关心的只有
 * 「它是不是一次前进/后退」这个信号。
 *
 * 因此这里在离开路由前，把当前 `#ptd-main.scrollTop` 记在「离开时的路由」上：
 * `beforeEach` 执行时旧视图尚未卸载，读到的就是用户实际停留的位置。
 */
const mainScrollTopByPath = new Map<string, number>();

/**
 * 记录某个路由当前的主区滚动位置（由下面的全局守卫在离开路由前调用）。
 *
 * 单独导出而不是内联进守卫：守卫只能由真实导航触发，单测要构造「曾经滚到某处」的场景
 * 成本很高；这里把「读 DOM、记位置」这一步拆成可独立调用的最小函数。
 */
export function saveMainScrollTop(path: string | undefined) {
  if (!path) return;
  const main = document.getElementById("ptd-main");
  if (main) mainScrollTopByPath.set(path, main.scrollTop);
}

/**
 * 本次导航是否由浏览器前进/后退触发。
 *
 * 不能只看 `savedPosition`：vue-router 在 popstate 分支里先查自己的 `scrollPositions`
 * （离开该路由时从 `window.scrollY` 采到，本项目里恒为 0），取不到时还可能回落到
 * `history.state.scroll`（同样恒为 0），两者都可能给出 `null`。SetBase 页签之间恰好还有
 * 「切换即复位」的规则，于是「后退回上一个页签」会被误判成普通页签切换、位置被清掉。
 * 自己在 popstate 上打标记最直接：vue-router 的导航处理是异步的，标记一定先于
 * scrollBehavior 执行。
 */
let pendingPopNavigation = false;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    pendingPopNavigation = true;
  });
}

/**
 * 把主区滚到指定位置；返回 `false` 是告诉 vue-router「已经自己处理了滚动」。
 *
 * 为什么要等帧：scrollBehavior 在导航确认后立刻执行，懒加载的路由 chunk 此时可能还没挂载，
 * 内容高度不足时浏览器会把刚写入的 scrollTop 夹回 0。这里最多重试 10 帧，
 * 等 `scrollHeight` 足够容纳目标位置后再写。
 */
async function scrollMainTo(top: number): Promise<false> {
  const apply = () => {
    const main = document.getElementById("ptd-main");
    if (!main) return false;
    if (top > 0 && main.scrollHeight - main.clientHeight < top) return false;
    main.scrollTop = top;
    return true;
  };

  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (apply()) break;
  }
  return false;
}

export const routerInstance = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior(to, from, savedPosition) {
    const isPopNavigation = pendingPopNavigation || savedPosition !== null;
    pendingPopNavigation = false; // 每次导航只消费一次，避免残留标记影响后续普通跳转

    // 浏览器前进 / 后退：savedPosition 恒为 0（window 不滚动），改用离开该路由时记下的主区位置
    if (isPopNavigation) return scrollMainTo(mainScrollTopByPath.get(to.fullPath) ?? 0);

    // 「常规设置」的页签内容高度差异很大：若保留上一页签的主区滚动位置，
    // 从长页签底部切到短页签时浏览器会把滚动位置夹到新内容底部，看起来像自动跳底。
    const isSetBaseTab = (route: typeof to) => typeof route.name === "string" && setBaseTabNames.has(route.name);
    if (isSetBaseTab(to) && isSetBaseTab(from)) return scrollMainTo(0);

    // 其余导航回到主区顶部（顶栏固定在视口上沿，不在滚动容器内，无需额外偏移）。
    return scrollMainTo(0);
  },
});

// 必须放在 routerInstance 之后：const 声明存在暂时性死区，写在前面会直接抛 ReferenceError
routerInstance.beforeEach((_to, from) => saveMainScrollTop(from.fullPath));
