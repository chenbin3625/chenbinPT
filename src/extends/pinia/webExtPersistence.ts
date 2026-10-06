/**
 * this plugin is edit from ohmree/pinia-plugin-webext-storage
 */
import type { Ref } from "vue";
import { getCurrentScope, onScopeDispose, ref, unref } from "vue";
import { MutationType, PiniaPluginContext } from "pinia";
import { message } from "ant-design-vue";

import { toSerializable } from "@/shared/messagesSerializable.ts";
import { i18n } from "@/options/plugins/i18n.ts";

/**
 * 取可用的 storage 区域；宿主没有完整扩展 API 时返回 null。
 *
 * 为什么必须探测而不是直接 `chrome.storage[storage].set(...)`：
 * 本模块会被 options 页与 content-script **共享**，而这两者都可能跑在
 * 「没有扩展 storage」的宿主里 —— 本地 vite 预览页（宿主只提供 `window.chrome.storage.local`，
 * 或干脆只有浏览器原生的 `window.chrome = {loadTimes, csi, app}`）、以及在普通网页里
 * 单独调试 options 入口的场景。此时 `chrome.storage[area]` 是 undefined，
 * 直接调用会在**挂载阶段**同步抛出，把整个应用一起带走（按钮全部失效）。
 * 所以这里把「没有 storage」当作正常的降级路径：内存态照常工作，只是不落盘。
 */
function getUsableStorageArea(storage: chrome.storage.AreaName): chrome.storage.StorageArea | null {
  try {
    return globalThis.chrome?.storage?.[storage] ?? null;
  } catch {
    // 某些宿主用 getter 抛错代替返回 undefined
    return null;
  }
}

/** 取可监听的 storage 变更事件；宿主 getter 或能力检测异常时安全降级。 */
function getUsableStorageChangeEvent(): typeof chrome.storage.onChanged | null {
  try {
    const event = globalThis.chrome?.storage?.onChanged;
    return typeof event?.addListener === "function" ? event : null;
  } catch {
    return null;
  }
}

/**
 * 写入 chrome.storage。
 *
 * 早期实现是 `JSON.parse(JSON.stringify(newValue))`（整份字符串 + 二次拷贝，
 * 见 docs/performance-audit.md P1-5），现改为只做递归解代理，
 * 由 chrome.storage 自身的结构化克隆完成复制。
 *
 * 注意：本函数是**整份写**，只用于 `restore()` 在 storage 里还没有值时的「写默认值」
 * （此时没有可合并的现值，也不存在与其它上下文并发读改写的窗口）。
 * store 的 `$save()` 走 `doWrite()` → `mergeBeforeWrite()`，落盘前会与 storage 现值合并（B-10）。
 */
export async function persistent<T>(key: string, newValue: T, storage: chrome.storage.AreaName = "local") {
  await writeSerializedSnapshot(key, toSerializable(newValue), storage);
}

/** 解代理为可写入 storage 的普通对象（同步，供插件在写盘前先登记回声快照） */
function toWriteSnapshot<T>(newValue: T): T {
  return toSerializable(newValue) as T;
}

/** 真正写盘。拆成独立函数是为了让插件能在调用它之前先登记本次写入的内容快照 */
async function writeSerializedSnapshot<T>(key: string, serialized: T, storage: chrome.storage.AreaName): Promise<void> {
  await getUsableStorageArea(storage)?.set({ [key]: serialized });
}

/**
 * 普通对象判定（不含数组 / null / 类实例）。
 * 「最小 patch」与「落盘前合并」的递归边界都由它决定：数组与其它值一律当作不可再分的叶子。
 *
 * 同时作为**类型谓词**：`chrome.storage.get()` 读回来的是 `unknown`（见 mergeBeforeWrite），
 * 落盘前合并要就地改写这棵对象树，必须在调用处完成收窄 —— 判定与收窄共用同一个函数，
 * 不额外引入 `as any` 这类会骗过编译器的断言。
 */
function isPlain(value: any): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 结构相等（JSON 语义：普通对象 / 数组 / 原始值；持久化的 store state 都是无环 JSON 数据）。
 *
 * 为什么不能用引用比较：`chrome.storage` 读回来的是**新反序列化**的对象树 ——
 * 数组与嵌套对象每次都是新引用。用引用比较会把「内容根本没变」误判成「外部改动了」，
 * 于是每次 `$save()` 都走合并路径、每次 onChanged 都产生一棵庞大的嵌套 patch
 * （正是 P0-3 要消除的级联重算）。
 */
function isDeepEqual(a: any, b: any): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (isPlain(a) && isPlain(b)) {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) {
      return false;
    }
    for (const key of aKeys) {
      if (!Object.hasOwn(b, key) || !isDeepEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * 路径级变更。`remove: true` 表示删除该路径，否则把 `value` 写到该路径。
 * 路径只由**普通对象的键**组成（数组整体替换，不会出现在路径中间），
 * 因此可以用同一套逻辑服务于 chrome.storage 的读改写与 pinia 的最小 patch。
 */
interface IPathChange {
  path: string[];
  remove?: boolean;
  value?: any;
}

/**
 * 计算 `base → next` 的路径级差异（结构比较，见 isDeepEqual）。
 * - 普通对象：递归到键一级，得到「真正变了」的最小路径集合；
 * - 数组 / 原始值 / 类型不同的值：整块替换；
 * - base 中存在、next 中消失的键：`remove`。
 */
function collectPathChanges(base: any, next: any, path: string[], out: IPathChange[]): void {
  if (isPlain(base) && isPlain(next)) {
    for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
      const inBase = Object.hasOwn(base, key);
      const inNext = Object.hasOwn(next, key);
      if (inBase && !inNext) {
        out.push({ path: [...path, key], remove: true });
      } else if (!inBase && inNext) {
        out.push({ path: [...path, key], value: next[key] });
      } else if (!isDeepEqual(base[key], next[key])) {
        collectPathChanges(base[key], next[key], [...path, key], out);
      }
    }
    return;
  }

  if (!isDeepEqual(base, next)) {
    out.push({ path, value: next });
  }
}

/** 把 `collectPathChanges` 的结果写进一个**可安全就地修改**的目标对象（落盘前合并用） */
function applyPathChanges(target: Record<string, any>, changes: IPathChange[]): void {
  for (const change of changes) {
    if (change.path.some((s) => s === "__proto__" || s === "constructor" || s === "prototype")) continue;
    let cursor: any = target;
    for (let i = 0; i < change.path.length - 1; i++) {
      const segment = change.path[i];
      if (!isPlain(cursor[segment])) {
        // 现值里缺中间容器（外部删过、或两边改动落在同一子树）：按需重建。
        // 取舍：同一路径既被外部改又被本地改时**本地改动优先**（这里只重放本地改动）。
        cursor[segment] = {};
      }
      cursor = cursor[segment];
    }
    const last = change.path[change.path.length - 1];
    if (change.remove) {
      delete cursor[last];
    } else {
      cursor[last] = change.value;
    }
  }
}

/**
 * 沿路径取「待写入/待删除键的父容器」；中途遇到非普通对象（含数组）或缺失时返回 undefined。
 * 用于把路径级变更落到 store state 上 —— 结构已被改成别的形状时跳过（本地为准），而不是抛错。
 */
function resolvePathContainer(root: Record<string, any>, path: string[]): Record<string, any> | undefined {
  let cursor: any = root;
  for (let i = 0; i < path.length - 1; i++) {
    cursor = cursor?.[path[i]];
    if (!isPlain(cursor)) {
      return undefined;
    }
  }
  return cursor;
}

/**
 * 递归计算 `prev → next` 的最小赋值 patch（`patchOut`）与需要**原地删除**的路径（`removalsOut`）。
 *
 * 返回值表示「这棵子树里是否有需要赋值的字段」；删除通过 `removalsOut` 单独表达
 * （pinia 的对象式 patch 只能赋值、无法表达删除，见 applyMinimalPatch 内的说明）。
 *
 * 修复 L-9：删除必须递归到每一层。旧实现只在顶层容器的直接子键上算 `removedKeys`，
 * 而变更子对象走 `$patch` 深合并 ⇒ 恢复备份后，备份里不存在、本地存在的**孙级**字段
 * 会留在 store 里，并在下一次 `$save()` 时被写回 —— 「恢复」实际没把配置变成备份的样子。
 */
function buildMinimalPatch(
  prev: Record<string, any>,
  next: Record<string, any>,
  path: string[],
  patchOut: Record<string, any>,
  removalsOut: string[][],
): boolean {
  let changed = false;

  for (const key of Object.keys(next)) {
    const prevValue = prev[key];
    const nextValue = next[key];

    if (isDeepEqual(prevValue, nextValue)) {
      continue; // 内容相同（引用可能不同，见 isDeepEqual）：不必赋值，避免无谓的响应式级联
    }

    if (isPlain(prevValue) && isPlain(nextValue)) {
      const nestedPatch: Record<string, any> = {};
      if (buildMinimalPatch(prevValue, nextValue, [...path, key], nestedPatch, removalsOut)) {
        patchOut[key] = nestedPatch;
        changed = true;
      }
    } else {
      patchOut[key] = nextValue;
      changed = true;
    }
  }

  // 外部删除：prev 中存在、next 中已消失的键（递归到每一层）
  for (const key of Object.keys(prev)) {
    if (!Object.hasOwn(next, key)) {
      removalsOut.push([...path, key]);
    }
  }

  return changed;
}

export interface restoreOptions<T = any> {
  initialValue?: T | Ref<T>;
  storage?: chrome.storage.AreaName;
  writeDefaults?: boolean;
  onError?: null | ((e: any) => void);
}

export async function restore<T>(key: string, options: restoreOptions<T> = {}): Promise<T> {
  const { initialValue, storage = "local", writeDefaults = true, onError = null } = options;

  const rawInit: T = unref(initialValue)!;

  try {
    console.debug("Restoring state for key:", key, "from storage:", storage);
    const usableStorage = getUsableStorageArea(storage);
    if (!usableStorage) {
      // 非扩展宿主（本地预览等）：没有可读的持久层，直接用初始值，写入侧同样静默降级
      return rawInit;
    }
    const { [key]: fromStorage } = await usableStorage.get(key);
    if (fromStorage) {
      return fromStorage as T;
    } else {
      if (writeDefaults && rawInit !== null) {
        await persistent(key, rawInit, storage);
      }
      return rawInit;
    }
  } catch (e) {
    onError?.(e);
    return rawInit;
  }
}

export interface PersistedStateOptions {
  /**
   * Storage key to use.
   * @default $store.id
   */
  key?: string;

  /**
   * Where to store persisted state.
   * @default 'local'
   */
  storageArea?: chrome.storage.AreaName;

  writeDefaultState?: boolean;
  autoSaveType?: boolean | MutationType[];

  /**
   * Hook called before state is hydrated from storage.
   * @default undefined
   */
  beforeRestore?: (context: PiniaPluginContext) => void;

  /**
   * Hook called after state is hydrated from storage.
   * @default undefined
   */
  afterRestore?: (context: PiniaPluginContext) => void;

  onRestoreError?: (e: any) => void;
}

declare module "pinia" {
  export interface DefineStoreOptionsBase<S, Store> {
    /**
     * Persist store in storage.
     */
    persistWebExt?: boolean | PersistedStateOptions;
  }

  export interface PiniaCustomProperties {
    readonly $ready: Ref<boolean>;

    $save(): Promise<void>;
    $onReady(callback?: () => void): Promise<void>;
    /**
     * 释放本插件注册的资源（chrome.storage.onChanged 监听），并调用 pinia 内建 `$dispose`。
     *
     * 刻意不叫 `$dispose`：pinia 在插件之后 `assign(store, extensions)`，用 `$dispose`
     * 作导出名会覆盖内建实现（自递归爆栈）；不导出则监听器无处释放。见 P1 缺陷修复。
     */
    $disposePersist(): void;
  }
}

export function piniaWebExtPersistencePlugin(context: PiniaPluginContext) {
  const {
    options: { persistWebExt },
    store,
  } = context;

  if (!persistWebExt) {
    return {};
  }

  const {
    key = store.$id,
    storageArea = "local",
    writeDefaultState = true,
    autoSaveType = false,
    beforeRestore = null,
    afterRestore = null,
    onRestoreError = null,
  } = typeof persistWebExt !== "boolean" ? persistWebExt : {};

  const $ready = ref(false);

  /**
   * 「落盘前与 storage 现值合并」的基线（缺陷清单 B-10 / 持久化侧）。
   *
   * 它记录**我们确信 storage 里当前是什么**：restore 读到的值、自己刚写入的值、
   * 或 onChanged 应用过的外部值。`$save()` 时用「基线 → 本地 state」算出**本地改了什么**，
   * 再把这份改动重放到**重新读回的 storage 现值**上，而不是整份覆盖。
   *
   * 为 null 表示还没有可信基线（restore 未完成就 $save）：此时退回旧的整份写语义。
   */
  let syncedSnapshot: any = null;

  beforeRestore?.(context);
  let restorePromise = restore(key, {
    initialValue: store.$state,
    storage: storageArea,
    writeDefaults: writeDefaultState,
    onError: onRestoreError,
  }).then((value) => {
    // 建立「storage 现值」基线：`restore()` 返回的就是 storage 里的内容
    // （storage 为空时返回初始值，此刻 writeDefaults 刚好把它写进去）。
    // B-10 的三方合并依赖这条基线来判断"本地改了什么、外部改了什么"。
    syncedSnapshot = toWriteSnapshot(value);
    store.$patch(value as unknown as typeof store.$state);
    $ready.value = true;
    afterRestore?.(context);
  });

  const $onReady = async (callback?: () => void) => {
    const promise = restorePromise || Promise.resolve();
    if (callback) {
      promise.then(callback);
    }
    return promise;
  };

  /**
   * 把外部写入合并进本地 store 时，只下发「真正变化的最小字段集」。
   *
   * 早期实现直接 `store.$patch(整份 newValue)`：等于整体替换 state，
   * 会让所有以 state 为依赖的 effect（例如 `Object.entries(sites)` 型 getter、
   * 深层 watch）全部重算，在 metadata 较大时造成级联卡顿（见 docs/performance-audit.md P0-3）。
   *
   * 这里用 `buildMinimalPatch` 做**结构比较**（`isDeepEqual`，而不是引用比较）：
   * chrome.storage 回传的新值总是全新反序列化的对象树，引用比较会把「内容没变」也当成变化，
   * 于是每次外部写入都产生一棵庞大的嵌套 patch、把等值的数组/子对象重新赋一遍 —— 同样是级联重算。
   *
   * 修复 P0-3 遗留（外部删除丢失）：旧实现只遍历 `Object.keys(next)`，
   * 于是 `prev` 里有、`next` 中已被外部删掉的子 key 永远留在了本地 store
   * （例如另一上下文删掉 sites.siteB 后，本地 `Object.entries(sites)` 仍能看到它），
   * 之后 options 页 `$save` 会把这份过期 state 整份写回，把外部删除"复活"。
   *
   * 修复 L-9（孙级字段删不掉）：删除现在**递归到每一层**，路径形如
   * `["sites","siteA","merge","custom"]`。旧实现只在顶层容器的直接子键上算删除，
   * 而变更子对象走 `$patch` 深合并 ⇒ 恢复备份后，备份里不存在、本地存在的孙级字段
   * 会留在 store 里，并在下一次 `$save()` 时被写回 —— 「恢复」实际没把配置变成备份的样子。
   */
  function applyMinimalPatch(newValue: any) {
    if (!isPlain(newValue)) {
      return;
    }

    const current = store.$state as Record<string, any>;
    const patch: Record<string, any> = {};
    /**
     * 需要原地删除的**路径**。
     * pinia 的对象形式 patch 走 `mergeReactiveObjects`，只能赋值、无法表达"删除"
     * （赋 undefined 会留下一个值为 undefined 的 key，`Object.entries(sites)` 依旧会遍历到它），
     * 因此删除单独用函数形式 patch 完成。
     */
    const removals: string[][] = [];

    for (const topKey of Object.keys(newValue)) {
      const next = newValue[topKey];
      const prev = current[topKey];

      if (isDeepEqual(prev, next)) {
        continue;
      }

      if (isPlain(prev) && isPlain(next)) {
        const nestedPatch: Record<string, any> = {};
        if (buildMinimalPatch(prev, next, [topKey], nestedPatch, removals)) {
          patch[topKey] = nestedPatch;
        }
      } else {
        patch[topKey] = next;
      }
    }

    if (Object.keys(patch).length > 0) {
      store.$patch(patch as Parameters<typeof store.$patch>[0]);
    }

    if (removals.length > 0) {
      store.$patch((state) => {
        const stateRecord = state as unknown as Record<string, any>;
        for (const path of removals) {
          // 父路径可能已被同一批删除中的祖先带走（或本地结构已变成别的形状）：跳过而不是抛错
          const container = resolvePathContainer(stateRecord, path);
          if (!container) {
            continue;
          }
          delete container[path[path.length - 1]];
        }
      });
    }
  }

  /**
   * 自身写入回声抑制（见 docs/performance-audit.md P0-3）。
   *
   * `persistent()` 会把 state 解代理后写盘，`onChanged` 回传的是**全新反序列化**的对象，
   * 引用比较无法识别出这是我们自己刚写的回声。若把它当成外部写入处理，有两点代价：
   * - 正确性：回声内容就是「刚落盘的内容」，而本地可能在这之后又改了同一字段 ——
   *   回灌会把用户的新编辑**回退**成刚落盘的值；
   * - 性能：每次 `$save()` 之后都要为 MB 级的 metadata 做一次全树结构比较（见 isDeepEqual）。
   * 因此仍需按内容比对来识别并抑制回声。
   *
   * 修复 P0-3 遗留（回声窗口吞掉真实外部写入）：早期实现只看时间窗口，
   * 写入开始/结束各延长 500ms，这 500ms 内**任何**上下文对同一 key 的 onChanged
   * 都被当成回声直接忽略 —— 而 options 页与 offscreen 也会写同一个 key，
   * 外部写入一旦落在这个窗口里就会被静默丢弃。
   *
   * 现在窗口只用来界定"需要比对"的时间范围，是否忽略由**内容**决定：
   * - 与自身刚写入的解代理快照逐字节一致（JSON 往返语义）→ 是回声，忽略；
   * - 没有可以匹配的自身写入快照，或内容不一致 → 是真实外部写入，照常走最小 patch。
   *
   * 快照本身零额外成本：就是 `$save()` 这次要写盘的那个解代理结果，且**在调用
   * chrome.storage.set 之前**登记（set 有可能在 promise resolve 之前就触发 onChanged，
   * 登记晚了会把自己的回声误判成外部写入）。指纹（JSON 字符串）只在窗口内真的有
   * onChanged 到达时才惰性计算一次，写路径上没有额外序列化开销。
   *
   * 保留最近几次快照：`$save()` 的密集调用会顺序落盘多次，只留最后一份会把更早的回声
   * 误判成"外部写入"（进而把本地回退到旧内容）。快照在整个窗口内都可用于比对，
   * 不做"命中即消费" —— 同一次自身写入的 onChanged 可能不止一次到达，
   * 而"内容与本上下文刚写入的内容逐字节相同"的变更即便来自其它上下文也不会改变任何字段。
   *
   * 残余取舍：若 chrome.storage 没有为本次写入派发 onChanged，窗口内到达的**不同内容**写入仍会被正常应用；
   * 只有"内容与最近一次自身写入完全一致"的窗口内变更会被当作回声忽略。
   */
  const SELF_WRITE_ECHO_WINDOW = 500;
  let selfWriteUntil = 0;
  /** 是否仍在自身写入的时间窗内（窗口只界定需要内容比对的范围，见 isSelfWriteEcho） */
  function isWithinSelfWriteEchoWindow(): boolean {
    return Date.now() < selfWriteUntil;
  }
  const SELF_WRITE_ECHO_MAX_SNAPSHOTS = 8;

  type TSelfWriteSnapshot = { value: any; fingerprint?: string | null };

  let selfWriteSnapshots: TSelfWriteSnapshot[] = [];

  function rememberSelfWrite(value: any) {
    selfWriteUntil = Date.now() + SELF_WRITE_ECHO_WINDOW;
    selfWriteSnapshots.push({ value });
    if (selfWriteSnapshots.length > SELF_WRITE_ECHO_MAX_SNAPSHOTS) {
      selfWriteSnapshots.splice(0, selfWriteSnapshots.length - SELF_WRITE_ECHO_MAX_SNAPSHOTS);
    }
  }

  function isSelfWriteEcho(newValue: any): boolean {
    if (!isWithinSelfWriteEchoWindow()) {
      selfWriteSnapshots = [];
      return false; // 窗口外：只可能是外部写入
    }

    if (selfWriteSnapshots.length === 0) {
      return false; // 窗口内但没有待比对的自身写入 → 只能是外部写入，绝不能吞
    }

    let newValueFingerprint: string | null;
    try {
      newValueFingerprint = JSON.stringify(newValue);
    } catch {
      newValueFingerprint = null;
    }

    for (let i = 0; i < selfWriteSnapshots.length; i++) {
      const snapshot = selfWriteSnapshots[i];
      if (snapshot.fingerprint === undefined) {
        try {
          snapshot.fingerprint = JSON.stringify(snapshot.value);
        } catch {
          snapshot.fingerprint = null; // 无法比对（正常数据不会走到这里）
        }
      }
      if (snapshot.fingerprint === null || newValueFingerprint === null) {
        continue;
      }
      if (snapshot.fingerprint === newValueFingerprint) {
        return true;
      }
    }

    return false;
  }

  function onChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
    if (areaName !== storageArea || !Object.hasOwn(changes, key)) {
      return;
    }

    // storage 现在的内容就是它（无论是不是回声）：作为下一次 $save 做三方合并的基线（B-10）
    syncedSnapshot = changes[key].newValue;

    if (isSelfWriteEcho(changes[key].newValue)) {
      // 自身写入的回声：内容与本上下文一致，无需 patch
      return;
    }

    applyMinimalPatch(changes[key].newValue);
  }

  /**
   * 把「外部并发改动中存活下来的那部分」落到本地 store。
   *
   * 只下发 `localSnapshot → merged` 的差异（而不是整份 merged）：
   * - 冲突路径（外部与本地改了同一路径）在合并结果里取的是**本地值**，差异里自然不含它，
   *   因此不会覆盖用户正在编辑的内容；
   * - 与 applyMinimalPatch 一样保持容器对象身份、避免整棵子树重建。
   */
  function applyExternalChangesToStore(changes: IPathChange[]) {
    store.$patch((state) => {
      const stateRecord = state as unknown as Record<string, any>;
      for (const change of changes) {
        const container = resolvePathContainer(stateRecord, change.path);
        if (!container) {
          continue; // 本地结构已变成别的形状：以本地为准
        }
        const last = change.path[change.path.length - 1];
        if (change.remove) {
          delete container[last];
        } else {
          container[last] = change.value;
        }
      }
    });
  }

  /**
   * 计算本次真正要落盘的内容：读回 storage 现值，把「本地相对基线的改动」重放到现值上。
   *
   * 为什么需要这样做（B-10）：本插件用 `chrome.storage.local.set({ [key]: 整份 state })` 写入
   * `metadata` / `config`，而 service worker 侧的用户信息刷新走 `patchExtStoragePathLocal`
   * 的「读 → 改路径 → 写回」。两者并发时，落在 SW「读 → 写回」窗口里的整份写会**静默回滚**
   * 对方的改动（`entries/background/utils/base.ts` 里「SW 是唯一写者」的断言不成立，
   * 因为本插件完全绕过了 SW 的 writeChain）。
   *
   * 合并规则（三方合并，基线 = syncedSnapshot）：
   * - 只保留**本地真正改动过**的路径（相对基线），其余字段一律采用 storage 现值；
   * - 同一路径既被外部改又被本地改 → **本地改动优先**（用户当前操作可见，冲突可预期）；
   * - 合并结果与本地 state 的差异会回灌到 store，避免下一次 `$save()` 把这次保住的外部改动
   *   误判成「本地删除」再写回去（那样只是把回滚推迟一轮）。
   *
   * 残留窗口（如实说明）：`get` 与 `set` 之间到达的外部写入仍可能被覆盖 ——
   * 窗口从「本页上次读取 storage 到本次写盘」（可能横跨整个页面会话）缩短为一次 get + set，
   * 但没有引入版本号/CAS，跨标签页的高频并发写仍非严格线性化。
   * 另一条残余：非扩展宿主（本地预览页等）没有 storage，直接走整份写；此时没有第二个写者，无影响。
   */
  async function mergeBeforeWrite(localSnapshot: any): Promise<any> {
    const usableStorage = getUsableStorageArea(storageArea);
    const base = syncedSnapshot;

    if (!usableStorage || base === null) {
      return localSnapshot; // 无 storage / 无基线：保持旧的整份写语义
    }

    const { [key]: stored } = await usableStorage.get(key);

    // 现值不是普通对象（被清空、被别的写者换成了别的形态）：没有可合并的内容，整份写
    if (!isPlain(stored) || !isPlain(base)) {
      return localSnapshot;
    }

    const externalChanges: IPathChange[] = [];
    collectPathChanges(base, stored, [], externalChanges);
    if (externalChanges.length === 0) {
      // 常见路径：$save 的间隙里没有其它写者 → 与旧实现完全一致（代价是多一次 get）
      return localSnapshot;
    }

    const localChanges: IPathChange[] = [];
    collectPathChanges(base, localSnapshot, [], localChanges);

    const merged = stored; // 刚反序列化出来的新对象，可以安全就地合并
    applyPathChanges(merged, localChanges);

    const survivingExternalChanges: IPathChange[] = [];
    collectPathChanges(localSnapshot, merged, [], survivingExternalChanges);
    if (survivingExternalChanges.length > 0) {
      applyExternalChangesToStore(survivingExternalChanges);
    }

    return merged;
  }

  /**
   * 监听器生命周期（修复 P1：全局监听泄漏）。
   *
   * 早期实现为「每个启用持久化的 store 各注册一个 chrome.storage.onChanged 全局监听」，
   * 且只在自定义的 `$dispose` 中移除，而该函数没有任何调用点 —— 监听器会随页面/SW 会话
   * 永久驻留（store 数量 × 全局回调）。
   *
   * 这里把移除绑定到 pinia 为该 store 创建的 effectScope：`store.$dispose()` 即 `scope.stop()`，
   * 会触发 scope 内的 onScopeDispose 回调。插件本身正是在 `scope.run(...)` 内被调用的
   * （见 pinia createSetupStore 的 `pinia._p.forEach`），因此 getCurrentScope() 可用。
   * 若 scope 不可用（插件被以非标准方式调用），仍可用 `$disposePersist()` 手动释放。
   *
   * 扩展上下文探测（补的是**可用性**，而非上面的生命周期）：
   *
   * `chrome.storage` 存在不等于 `chrome.storage.onChanged` 存在：本地预览页只 mock 了
   * `storage.local/session/sync`，普通网页里的 `window.chrome` 更是浏览器原生的
   * `{loadTimes, csi, app}`。此时若直接 `chrome.storage.onChanged.addListener(...)`，
   * 抛出的 TypeError 发生在 pinia 插件（即 store 创建）阶段 —— 也就是根组件 setup 内 ——
   * Vue 会把整个组件树挂载失败，表现为「所有按钮都失效」。
   * 因此监听注册整体按「宿主是否提供该能力」降级，绝不因此中断挂载。
   */
  const storageOnChanged = getUsableStorageChangeEvent();
  let storageListenerRegistered = false;

  const removeStorageListener = () => {
    if (!storageListenerRegistered || typeof storageOnChanged?.removeListener !== "function") {
      return;
    }
    try {
      storageOnChanged.removeListener(onChanged);
    } catch {
      // 宿主拒绝移除监听时不应影响 store / 页面卸载
    } finally {
      storageListenerRegistered = false;
    }
  };

  if (storageOnChanged) {
    if (getCurrentScope()) {
      onScopeDispose(removeStorageListener);
    }
    try {
      storageOnChanged.addListener(onChanged);
      storageListenerRegistered = true;
    } catch {
      // 非标准宿主可能暴露同名方法但调用时抛错，按无监听能力降级
    }
  }

  /**
   * 写入合并（见 docs/performance-audit.md P1-5）。
   *
   * 保持原有语义：`await store.$save()` 返回时数据已经落盘（不做延迟写）。
   * 但把"写入进行中"期间到达的多次调用合并成**一次**尾部写入：
   * - 第一次调用立即写；
   * - 期间到达的调用只记录"待写"，等当前写入结束后用最新 state 补写一次，
   *   所有等待者在该次补写完成后一起 resolve。
   * 这样连续开关/批量编辑（例如勾选多个域名一次设置）不会产生 N 次全量序列化。
   */
  let inFlight: Promise<void> | null = null;
  let queuedStateGetter: (() => any) | null = null;
  let queuedWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  async function doWrite(getState: () => any) {
    // 标记"接下来的写入是本上下文发起的"，并**在写盘之前**登记本次写入的内容快照：
    // chrome.storage.set 可能在 promise resolve 之前就触发 onChanged，
    // 登记晚了会把自己的回声误判成外部写入（进而白 patch 一遍，正是 P0-3 要消除的级联）。
    selfWriteUntil = Date.now() + SELF_WRITE_ECHO_WINDOW;
    try {
      const snapshot = toWriteSnapshot(getState());
      // 落盘前先与 storage 现值合并（B-10）：真正写下的内容可能包含其它上下文的并发改动，
      // 因此回声快照必须登记**合并后**的内容（否则对方改动带来的 onChanged 会被当成外部写入）。
      const toWrite = await mergeBeforeWrite(snapshot);
      rememberSelfWrite(toWrite);
      await writeSerializedSnapshot(key, toWrite, storageArea);
      syncedSnapshot = toWrite;
      selfWriteUntil = Date.now() + SELF_WRITE_ECHO_WINDOW;
    } catch (error) {
      // 修复 P1-5「保存失败完全静默」：给出可诊断信息（store id + storage key）。
      console.error(`[PTD] failed to persist store "${store.$id}" (storage key: ${key})`, error);
      try {
        message.open({ type: "error", content: i18n.t("common.saveFailed") });
      } catch {
        // 提示层不可用时仍以原始写盘错误为准。
      }
      throw error;
    }
  }

  function flushQueued() {
    if (!queuedStateGetter) {
      return;
    }
    const getState = queuedStateGetter;
    const waiters = queuedWaiters;
    queuedStateGetter = null;
    queuedWaiters = [];

    const task = doWrite(getState);
    inFlight = task.finally(() => {
      inFlight = null;
      flushQueued();
    });
    void inFlight.then(
      () => waiters.forEach(({ resolve }) => resolve()),
      (error) => waiters.forEach(({ reject }) => reject(error)),
    );
  }

  const $save = (newState = store.$state): Promise<void> => {
    if (inFlight) {
      // 已有写入在飞行中：只登记最新状态，等它结束后合并补写一次
      queuedStateGetter = () => newState;
      const queued = new Promise<void>((resolve, reject) => {
        queuedWaiters.push({ resolve, reject });
      });
      void queued.catch(() => undefined);
      return queued;
    }

    const task = doWrite(() => newState);
    inFlight = task.finally(() => {
      inFlight = null;
      flushQueued();
    });
    void inFlight.catch(() => undefined);
    return inFlight;
  };

  if (autoSaveType && Array.isArray(autoSaveType)) {
    store.$subscribe((mutation, state: any) => {
      console?.log("Store `" + store.$id + "` change subscribed: ", mutation);
      if (autoSaveType.includes(mutation.type)) {
        void $save(state).catch(() => undefined);
      }
    });
  }

  /**
   * 插件级释放入口。**不要改名回 `$dispose`**：
   * pinia 会在所有插件执行完后 `assign(store, extensions)`，用 `$dispose` 作键会覆盖
   * pinia 内建的 `$dispose`（即 `scope.stop()` 的唯一入口），调用时自递归爆栈；
   * 而若因此不导出任何释放函数，onChanged 监听器又永远无法释放。
   */
  const $disposePersist = () => {
    // 先捕获内建实现再释放本插件资源，避免依赖 `assign(store, extensions)` 的赋值顺序；
    // 正常情况下 store.$dispose 仍是 pinia 内建版本（本插件不再占用该键名）。
    const nativeDispose = store.$dispose;
    removeStorageListener(); // 幂等：未注册过的监听器 removeListener 为空操作
    if (typeof nativeDispose === "function" && nativeDispose !== $disposePersist) {
      nativeDispose.call(store);
    }
  };

  return { $disposePersist, $save, $ready, $onReady };
}
