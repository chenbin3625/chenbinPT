import { defineExtensionStorage } from "@webext-core/storage";

import {
  IConfigPiniaStorageSchema,
  IMetadataPiniaStorageSchema,
  TUserInfoStorageSchema,
  TSearchResultSnapshotStorageSchema,
  TKeepUploadTaskStorageSchema,
  TTorrentFavoriteStorageSchema,
} from "@/shared/types.ts";

export interface IExtensionStorageSchema {
  // 既可以被 pinia 使用，也可以被其他地方使用
  config: IConfigPiniaStorageSchema;

  metadata: IMetadataPiniaStorageSchema;

  userInfo: TUserInfoStorageSchema; // 用于存储用户信息
  searchResultSnapshot: TSearchResultSnapshotStorageSchema; // 用于存储搜索结果快照
  keepUploadTask: TKeepUploadTaskStorageSchema; // 用于存储辅种任务
  torrentFavorite: TTorrentFavoriteStorageSchema; // 用于存储种子收藏

  /**
   * 站点 host/name 索引（metadata.siteHostMap / siteNameMap 的独立副本）。
   *
   * 见 docs/performance-audit.md P2-17：content script 引导与右键菜单只需要这两个小表，
   * 但 metadata 可能数百 KB ~ MB 级、且会被用户信息刷新等高频写入反复失效，
   * 因此把索引单独存一份小 key，读取时不必反序列化整份 metadata。
   * 读取方在 key 缺失时回落读取 metadata（兼容旧数据/未重建过的用户）。
   */
  siteIndex: {
    siteHostMap: Record<string, string>;
    siteNameMap: Record<string, string>;
  };
}

export type TExtensionStorageKey = keyof IExtensionStorageSchema;

let warnedAboutMissingSetAccessLevel = false;

/**
 * 把 `chrome.storage.local` 收紧到「仅可信扩展上下文可读」。
 *
 * 为什么必须做：`local` 的**默认**访问级别是 `TRUSTED_AND_UNTRUSTED_CONTEXTS`，即内容脚本
 * （运行在任意站点页面渲染进程里）可以直接 `chrome.storage.local.get(null)`。本扩展把站点凭据
 * （`metadata.sites.*.inputSetting/runtimeSettings`）、下载器密码、备份服务器凭据、备份加密密钥
 * 都放在 `local`；若不收紧，A1/A2 那套「内容脚本消息白名单 + 脱敏」等于形同虚设。
 *
 * 为什么在模块加载时执行、并且还在 `runtime.onStartup` 再执行一次（N1）：访问级别
 * **不保证跨浏览器重启保留**（Chrome 各版本行为不一致），而本模块只在可信上下文
 * （SW / offscreen / options）被加载时执行。浏览器启动后到 SW 首次被事件唤醒之间存在窗口：
 * 若此时页面里的内容脚本被攻破，可以直读本地存储。因此要求 service worker 顶层每次启动都设置一次；
 * `onStartup` 是「SW 可能还没被业务事件唤醒」时的兜底。
 *
 * 支持范围（2026-10-24 复检 M3 核实）：`chrome.storage.local.setAccessLevel` 从 **Chrome 140**
 * 起才支持全部 storage area（此前的版本只支持 storage.session）；因此 manifest 的
 * `minimum_chrome_version: "140"` 是该防线成立的前提。
 *
 * **Firefox 目前不支持 `setAccessLevel`**（MDN browser-compat-data: firefox.version_added = false，
 * 见 bugzil.la/1724754）：Firefox 上该防线不存在，只能告警留痕，由威胁模型（内容脚本运行环境
 * 不被攻破；页面主世界 JS 无法直接调用 chrome.storage）兜底。该降级已写入 README 的「安全说明」，
 * 面向用户披露。**内容脚本不能调用 setAccessLevel 把级别改回去**（只有可信上下文可以），
 * 所以该收紧一旦生效就不会被页面侧撤销。
 */
export function restrictStorageLocalAccessToTrustedContexts(): void {
  try {
    const storageLocal = chrome.storage?.local as any;
    if (storageLocal && typeof storageLocal.setAccessLevel === "function") {
      const result = storageLocal.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      if (typeof result?.catch === "function") {
        void result.catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(
            "[PTD] chrome.storage.local.setAccessLevel failed, content scripts may read extension storage:",
            e,
          );
        });
      }
      return;
    }
    if (!warnedAboutMissingSetAccessLevel) {
      warnedAboutMissingSetAccessLevel = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[PTD] chrome.storage.local.setAccessLevel is unavailable in this browser: content scripts can read extension local storage (credential protection degraded). See README.md#安全说明.",
      );
    }
  } catch (e) {
    // 不支持 setAccessLevel 的浏览器（如 Firefox）按原访问级别继续运行，但必须留痕（N1）。
    // eslint-disable-next-line no-console
    console.warn("[PTD] failed to restrict chrome.storage.local access level:", e);
  }
}

restrictStorageLocalAccessToTrustedContexts();

// N1：访问级别不保证跨浏览器重启保留；onStartup 在 SW 未被业务事件唤醒前也能补一次收紧。
if (typeof chrome.runtime?.onStartup?.addListener === "function") {
  chrome.runtime.onStartup.addListener(() => {
    restrictStorageLocalAccessToTrustedContexts();
  });
}

/**
 * 注意 extStore 不能在 offscreen 中使用，如果在 offscreen 中有需要，请使用 sw 提供的 sendMessage('getExtStorage' | 'setExtStorage')
 */
export const extStorage = defineExtensionStorage<IExtensionStorageSchema>(chrome.storage.local);
