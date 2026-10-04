/**
 * 此处为 @pkg/site 提供一些与平台相关的工具函数和适配器，
 *
 * 在 pkg/site 中，难免使用一些与平台有关的工具，比如 使用 axios 进行网络请求，获取cookies
 * 此处为这些操作提供统一的出口
 * 来尽可能实现 pkg/site 的 schemas 和 definitions 实现与浏览器平台能解耦
 * （其他地方只要修改此处的实现即可）
 *
 */

import axiosRaw from "axios";

import { sendMessage } from "@/messages.ts";
import { setupReplaceUnsafeHeader } from "~/extends/axios/replaceUnsafeHeader.ts";
import { setupRetryWhenCloudflareBlock } from "~/extends/axios/retryWhenCloudflareBlock.ts";

export { isCloudflareBlocked } from "~/extends/axios/retryWhenCloudflareBlock.ts";
export { sleep } from "~/helper.ts";

import type { ISiteUserConfig } from "../types";
import type { IExtensionStorageSchema } from "@/storage.ts";
import type { ILoggerItem } from "@/shared/types.ts";

// 默认允许 pkg/site 中的 axios 请求替换 unsafeHeader
export const axios = setupRetryWhenCloudflareBlock(setupReplaceUnsafeHeader(axiosRaw));

/**
 * 存储数据到 metadata.site[siteId].runtimeSettings[key] 中，
 * 这样对应站点实例可以使用 this.userConfig?.runtimeSettings?.[key] 或者 this.retrieveRuntimeSettings(key) 来获取
 *
 * 性能说明（见 docs/performance-audit.md P0-2/P2-17）：这里只读写目标路径，
 * 不再把整份 metadata 拉到 offscreen 改一个字段后再整份写回。
 * 注意 `field`/`key` 是代码内常量（不是用户输入），因此直接拼接路径是安全的。
 */
export async function store(
  siteId: string,
  key: string,
  value: any,
  field: keyof ISiteUserConfig = "runtimeSettings",
): Promise<void> {
  await sendMessage("patchExtStoragePath", {
    key: "metadata",
    path: ["sites", siteId, field as string, key],
    value,
  });
}

export async function retrieve<T extends any>(
  siteId: string,
  key: string,
  field: keyof ISiteUserConfig = "runtimeSettings",
): Promise<T | null> {
  const value = await sendMessage("getExtStoragePath", {
    key: "metadata",
    path: ["sites", siteId, field as string, key],
    defaultValue: null,
  });
  return (value ?? null) as T | null;
}

export async function retrieveStore(store: keyof IExtensionStorageSchema, keyPath: string): Promise<any> {
  return await sendMessage("getExtStoragePath", { key: store, path: keyPath, defaultValue: null });
}

/**
 * 允许调用来获取获取单个 cookie 信息
 */
export async function cookie(detail: chrome.cookies.CookieDetails): Promise<chrome.cookies.Cookie | null> {
  return await sendMessage("getCookie", detail);
}

/**
 * 统一的日志出口：转发到 offscreen 的 `logger` 消息通道（内存环形缓冲 + 节流落盘）。
 *
 * 修复 P1-2「生产环境零可观测」：packages 层此前的错误只写在 `import.meta.env.DEV` 守卫下，
 * 生产环境没有任何记录。这里复用项目已有的 logger 通道，用户可在运行时日志中查看并导出。
 *
 * 注意：`.catch` 必须带处理函数；裸 `.catch()` 会把 rejection 继续抛到全局（unhandled rejection）。
 *
 * @param msg  日志正文（应为简短、可读、不含敏感信息的描述）
 * @param data 附加结构化数据（需可结构化克隆，避免传入 DOM/循环引用对象）
 * @param level 日志级别，默认 debug；站点解析失败等真实错误使用 warn/error
 * @param module 产生日志的模块名，其他 packages 复用本出口时传入自身名称
 */
export function logMessage(
  msg: string,
  data?: any,
  level: ILoggerItem["level"] = "debug",
  module: string = "pkg/site",
): void {
  sendMessage("logger", { module, level, msg, data }).catch(() => {});
}
