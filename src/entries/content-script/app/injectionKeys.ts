import { inject, type InjectionKey } from "vue";

import type { IRemoteDownloadDialogData } from "./types.ts";
import type { IPtdData } from "./utils.ts";

/**
 * 由 init.ts 在 `app.provide` 阶段注入的页面上下文数据（站点 id / social site 等）。
 * 使用 InjectionKey 而非字符串 key，避免提供方与使用方拼写漂移。
 */
export const PTD_DATA_KEY: InjectionKey<IPtdData> = Symbol("ptd_data");

/**
 * 由 init.ts 在 `app.provide` 阶段注入的就绪 Promise，在 config / metadata store 水合并完成 patch 后 resolve。
 */
export const PTD_DATA_READY_KEY: InjectionKey<Promise<void>> = Symbol("ptd_data_ready");

/**
 * App.vue 提供的「远程发送到下载器」弹窗共享状态（shallowReactive），
 * 供 App 内部的页面 / 组件读写，避免逐层 props 传递。
 */
export const REMOTE_DOWNLOAD_DIALOG_DATA_KEY: InjectionKey<IRemoteDownloadDialogData> =
  Symbol("remoteDownloadDialogData");

/** 读取页面上下文数据；数据由 init.ts 提供，缺失时回落到空对象（保持原有行为） */
export function usePtdData(): IPtdData {
  return inject(PTD_DATA_KEY, {});
}

/** 读取 bootstrap 数据就绪 Promise；缺失时返回 undefined */
export function usePtdDataReady(): Promise<void> | undefined {
  return inject(PTD_DATA_READY_KEY, undefined);
}

/** 读取远程发送弹窗状态；该状态只能由 App.vue 提供，缺失时直接报错以便尽早暴露层级错误 */
export function useRemoteDownloadDialogData(): IRemoteDownloadDialogData {
  const data = inject(REMOTE_DOWNLOAD_DIALOG_DATA_KEY);
  if (!data) {
    throw new Error("[chenbinPT] remoteDownloadDialogData 未提供，应在 App.vue 内部使用该 composable");
  }
  return data;
}
