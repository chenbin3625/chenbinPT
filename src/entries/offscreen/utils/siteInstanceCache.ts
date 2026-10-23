/**
 * 站点实例缓存（见审查报告 OS-5）。
 *
 * 背景：offscreen 每条消息都 `new SiteClass(...)`，而 `createSiteInstance` 里会
 * `cloneDeep(siteMetadata)`（定义可能很大）。同一批搜索/下载会为同一站点反复克隆并构造实例；
 * 更关键的是站点定义里的请求节流器若将来提升为实例级，只有实例复用才能让间隔跨请求生效
 * （当前 `createRequestThrottle` 仍按方法调用新建，跨调用间隔由 per-site 串行兜底，见 `site.ts`）。
 *
 * 缓存 key 由 `site.ts` 计算（用户配置 + 是否 merge），配置变化自然失效；
 * 备份恢复等整份重写 metadata 的场景调用 `clearSiteInstanceCache()` 主动失效。
 */
import type { ISiteUserConfig, TSiteID } from "@ptd/site";

type TSiteInstanceCache = {
  cacheKey: string;
  instance: unknown;
};

const siteInstanceCache = new Map<TSiteID, TSiteInstanceCache>();

export function getCachedSiteInstance<T>(siteId: TSiteID, cacheKey: string): T | undefined {
  const cached = siteInstanceCache.get(siteId);
  if (cached && cached.cacheKey === cacheKey) {
    return cached.instance as T;
  }
  return undefined;
}

export function setCachedSiteInstance<T>(siteId: TSiteID, cacheKey: string, instance: T): T {
  siteInstanceCache.set(siteId, { cacheKey, instance });
  return instance;
}

/**
 * 计算站点实例缓存 key。
 *
 * `runtimeSettings` 由实例自身在请求过程中写入（`storeRuntimeSettings` 会同时更新实例内存与 storage），
 * 把它算进来会让「首次抓取用户信息后缓存立刻失效」；它本质上是凭据缓存而非连接配置，
 * 由实例自己持有并更新，因此从 key 中排除。整份重写 metadata（备份恢复）时调用方必须显式清缓存。
 */
/**
 * 稳定序列化（键名递归排序）—— 2026-10-24 并行审查 P2-7。
 *
 * `userConfig` 来自 `chrome.storage.local` 反序列化 / 各上下文写入，同一个对象在不同上下文/不同
 * 写入历史下**键序可能不同**（`JSON.stringify` 输出随之不同）。旧实现直接 `JSON.stringify`，
 * 于是「内容等价但键序不同」的配置会让缓存 key 变化 → 实例被反复重建（缓存抖动），
 * 每次都要重新动态 import + `cloneDeep(metadata)`（站点定义可能很大）。
 *
 * 这里按「对象键排序、数组保序、标量按 JSON 语义」序列化；`Date`/`RegExp` 等非普通对象在
 * userConfig 里不存在（存储层只能存 JSON 值），出现时按 JSON 语义降级（Date→ISO? 不做特判，保持简单）。
 */
function stableSerialize(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null || typeof value === "undefined") {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return JSON.stringify(String(value));
    case "function":
    case "symbol":
      return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
  }
  if (seen.has(value)) {
    return JSON.stringify("[Circular]");
  }
  seen.add(value);
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`)
    .join(",");
  seen.delete(value);
  return `{${body}}`;
}

export function getSiteInstanceCacheKey(
  siteId: TSiteID,
  userConfig: ISiteUserConfig,
  mergeUserConfig: boolean,
): string {
  const { runtimeSettings: _runtimeSettings, ...configWithoutRuntimeSettings } = userConfig ?? {};
  return stableSerialize({ siteId, mergeUserConfig, config: configWithoutRuntimeSettings });
}

export function clearSiteInstanceCache(siteId?: TSiteID): void {
  if (typeof siteId === "undefined") {
    siteInstanceCache.clear();
    return;
  }
  siteInstanceCache.delete(siteId);
}
