import { cloneDeep, isEqual } from "es-toolkit";
import { inject, provide, ref, type InjectionKey, type Ref } from "vue";

import type { IConfigPiniaStorageSchema } from "@/shared/types.ts";
import { useConfigStore } from "@/options/stores/config.ts";

/**
 * SetBase 的「草稿」语义（F2-N1 / 前次 High-01）。
 *
 * 背景：SetBase 的每个页签原先都 `v-model` 直连 `configStore`。于是「保存」按钮只是把**当前内存态**整份落盘，
 * 而任何与 SetBase 无关的 `$save()`（例如表格排序触发的 `updateTableBehavior`）都会把用户还没确认的改动
 * 一起写进 chrome.storage —— 最严重的后果是备份加密密钥：用户点了「随机生成」但没保存，
 * 切到别的页面点一下表头排序，offstage 的自动备份就会改用这把用户并不知道的密钥加密。
 *
 * 修复方式：进入 SetBase 时对「SetBase 可编辑的配置子树」做一份深拷贝草稿，控件只绑定草稿；
 * 点保存时才把**草稿相对初始快照真正变化过的叶子**合并回 store（只合并变化的叶子，避免把同时发生在
 * 其它页面的无关改动回滚），然后显式 `$save()`；离开 SetBase（Index 卸载）即丢弃草稿。
 *
 * `tableBehavior` 不在草稿范围内：它在其它页面被频繁改写，且 SetBase 不提供它的编辑入口。
 */
export const SET_BASE_CONFIG_DRAFT_KEYS = [
  "lang",
  "theme",
  "autoToggleNavBarOnDisplayChange",
  "saveTableBehavior",
  "enableTableMultiSort",
  "contextMenus",
  "contentScript",
  "searchEntifyControl",
  "userInfo",
  "download",
  "searchEntity",
  "mediaServerEntity",
  "backup",
  "socialSiteInformation",
  "autoExtendCookies",
] as const satisfies readonly (keyof IConfigPiniaStorageSchema)[];

export type TSetBaseConfigDraftKey = (typeof SET_BASE_CONFIG_DRAFT_KEYS)[number];
export type TSetBaseConfigDraft = Ref<Pick<IConfigPiniaStorageSchema, TSetBaseConfigDraftKey>>;

/** 只保留 SetBase 可编辑的配置子树，并做深拷贝（脱离 store 的响应式引用） */
export function createSetBaseConfigDraft(state: object): TSetBaseConfigDraft["value"] {
  const draft = {} as TSetBaseConfigDraft["value"];
  const stateRecord = state as Record<string, unknown>;
  for (const key of SET_BASE_CONFIG_DRAFT_KEYS) {
    (draft as Record<string, unknown>)[key] = cloneDeep(stateRecord[key]);
  }
  return draft;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把「草稿相对初始快照发生变化的叶子」合并进目标值，返回合并后的值。
 *
 * - 只有 `draft !== baseline` 的叶子才会覆盖 `target`，因此不会回滚草稿期间其它上下文对同一子树的改动；
 * - 对象按 key 递归合并（保留目标侧未被本次编辑触碰的键）；
 * - 数组 / 原始值整体替换（数组的编辑语义就是整份替换）。
 */
function mergeChangedValue(target: unknown, draftValue: unknown, baselineValue: unknown): unknown {
  if (isPlainRecord(draftValue) && isPlainRecord(baselineValue)) {
    const result: Record<string, unknown> = isPlainRecord(target) ? target : {};
    const keys = new Set([...Object.keys(draftValue), ...Object.keys(baselineValue)]);
    for (const key of keys) {
      const merged = mergeChangedValue(result[key], draftValue[key], baselineValue[key]);
      if (merged !== result[key]) {
        result[key] = merged;
      }
    }
    return result;
  }

  return isEqual(draftValue, baselineValue) ? target : cloneDeep(draftValue);
}

/** 把草稿里真正改动过的叶子写回 store（不触发落盘，调用方随后自行 `$save()`） */
export function applySetBaseConfigDraft(
  store: object,
  draft: TSetBaseConfigDraft["value"],
  baseline: TSetBaseConfigDraft["value"],
): void {
  const storeRecord = store as Record<string, unknown>;
  const draftRecord = draft as unknown as Record<string, unknown>;
  const baselineRecord = baseline as unknown as Record<string, unknown>;

  for (const key of SET_BASE_CONFIG_DRAFT_KEYS) {
    const merged = mergeChangedValue(storeRecord[key], draftRecord[key], baselineRecord[key]);
    if (merged !== storeRecord[key]) {
      storeRecord[key] = merged;
    }
  }
}

const setBaseConfigDraftKey: InjectionKey<TSetBaseConfigDraft> = Symbol("setBaseConfigDraft");

export function provideSetBaseConfigDraft(draft: TSetBaseConfigDraft): void {
  provide(setBaseConfigDraftKey, draft);
}

/**
 * 取当前 SetBase 草稿。
 *
 * 页签组件也可能被单独挂载（单测、未来的复用入口），此时没有 provide；退回 `ref(configStore.$state)`，
 * 即保持历史上「直接编辑 store」的行为，组件本身不需要感知两种模式。
 */
export function useSetBaseConfigDraft(): TSetBaseConfigDraft {
  const injected = inject(setBaseConfigDraftKey, null);
  if (injected) {
    return injected;
  }

  const configStore = useConfigStore();
  return ref(configStore.$state) as unknown as TSetBaseConfigDraft;
}

/**
 * OUI-3：重置草稿的钩子。
 *
 * 「重置系统设置」（ResetWindow 的 `configStore.$reset()`）与「冷启动水合完成」都会让 store 的
 * 内容整体变化，但 SetBase 的 draft / baseline 是进入页面时的一次性快照 —— 不重建的话：
 * - 重置后页签仍显示重置前的值（用户以为重置没生效）；
 * - 重置前未保存的草稿编辑会在之后点保存时被合并写回，部分撤销这次重置。
 *
 * 由 SetBase/Index.vue 提供（同时重建 draft + baseline），ResetWindow 在 `$reset()` 后调用。
 */
const setBaseConfigDraftResetKey: InjectionKey<() => void> = Symbol("setBaseConfigDraftReset");

export function provideSetBaseConfigDraftReset(reset: () => void): void {
  provide(setBaseConfigDraftResetKey, reset);
}

/** 取「重建草稿」钩子；页签被单独挂载（单测）时没有 provide，返回 undefined。 */
export function useSetBaseConfigDraftReset(): (() => void) | undefined {
  return inject(setBaseConfigDraftResetKey, undefined);
}
