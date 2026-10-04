/**
 * 在 browser 环境中，我们有很多的 headers 是不能设置的，这里为 axios 提供一个方法来替换掉这些 headers
 */
import type { AxiosInstance, AxiosRequestConfig } from "axios";
import { sendMessage } from "@/messages.ts";

export const unsafeHeaders: { [key: string]: boolean } = {
  "user-agent": true,
  cookie: true,
  "accept-charset": true,
  "accept-encoding": true,
  "access-control-request-headers": true,
  "access-control-request-method": true,
  connection: true,
  "content-length": true,
  date: true,
  dnt: true,
  expect: true,
  "feature-policy": true,
  host: true,
  "keep-alive": true,
  origin: true,
  referer: true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
  via: true,
};

interface AxiosAllowUnsafeHeaderInstance extends AxiosInstance {
  // 防重标志位挂在实例对象上而非 defaults：
  // axios.create() 会通过 mergeConfig 继承 defaults，挂在 defaults 会让新实例一出生就带上标志位，
  // 被守卫跳过导致拦截器不注册；实例自身的属性不会被 create() 继承。
  allowUnsafeHeader?: boolean;
}

/** DNR 会话规则的在途复用缓存：key = URL + method + 需要改写的请求头 */
interface DnrRuleEntry {
  ruleId: number;
  /** 仍在途（尚未收到响应/错误）的请求数；归零即按 id 删除规则 */
  inflight: number;
  /** 正在进行的安装；并发同 key 请求共享同一次安装，避免重复 install */
  installing: Promise<void> | null;
}

const dnrRuleCache = new Map<string, DnrRuleEntry>();

/**
 * 挂在 config 上的「本次请求需要交给 DNR 改写的请求头」记录（缺陷清单 B-17）。
 *
 * 请求拦截器会把不安全请求头从 `config.headers` 里**剥掉**，改由 DNR 会话规则注入
 * （浏览器不允许扩展/页面请求自行设置 `Referer`/`Origin`/`User-Agent` 等头）。
 * 而 Cloudflare 重试复用**同一个 config**（axios 的 `mergeConfig` 从被剥离后的 headers 重建），
 * 于是重试时 `config.headers` 里已经没有这些头 —— 旧实现在这种情况下得到空的提取结果、
 * 一条规则都不装，重试请求因此**不带** `Referer`/`Origin`/`User-Agent`，与首次请求不是同一个请求
 * （受影响站点：gtnet / mteam / huno / bangumi）。
 *
 * 因此把首次尝试提取出的 `ModifyHeaderInfo` 列表保留在 config 上，之后每次尝试（含 CF 重试）
 * 都用它重建并重装规则。列表里的 `remove` 操作同样被保留，语义与提取时一致。
 */
interface TUnsafeHeaderCarrier {
  dnrRequestHeaders?: chrome.declarativeNetRequest.ModifyHeaderInfo[];
}

/**
 * 规则 id 由 cacheKey 确定性派生（FNV-1a 32 位 → [1, 2^31-1]）。
 *
 * 早期实现用 `Math.floor(Math.random() * 1e7)`：同一扩展里 offscreen 的 axios 与
 * socialRecommendations 各持一份缓存，随机 id 可能撞号，删除时会误删别人的规则；
 * 确定性哈希保证「同内容 → 同 id（可用 removeRuleIds 覆盖式重装）、不同内容 → 不同 id」，
 * 从而能按 id 精确删除自己装的规则（见 docs/performance-audit.md P1-9）。
 */
export function dnrRuleIdForCacheKey(cacheKey: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < cacheKey.length; i++) {
    hash ^= cacheKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 0x7fffffff) + 1;
}

/**
 * 把完整 URL 转成 DNR 的 regexFilter（精确匹配）。
 *
 * 不能直接把 URL 塞进 urlFilter：DNR 的 urlFilter 里 `|` 是左右锚点、`||` 是域名锚点、
 * `*` 是通配符、`^` 是分隔符（匹配除字母/数字/`_`/`-`/`.`/`%` 外的任意字符），
 * 且 urlFilter **没有转义机制**。URL 里出现这些字符时会被当成过滤器语法，轻则匹配范围扩大、
 * 重则规则安装失败。这里改用 regexFilter：先用 URL 规则归一化（host punycode、非 ASCII 百分号编码），
 * 再逐个转义 RE2 元字符，最后用 ^...$ 锚定；额外允许 `?`/`#`/`&` 后缀，
 * 与旧 urlFilter 的「子串匹配」语义保持兼容。
 */
export function toExactUrlRegexFilter(url: string): string {
  let normalized: string;
  try {
    normalized = new URL(url).href;
  } catch {
    normalized = encodeURI(url);
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${escaped}(?:[?&#].*)?$`;
}

function installDnrRule(cacheKey: string, rule: chrome.declarativeNetRequest.Rule): Promise<number> {
  const entry: DnrRuleEntry = { ruleId: rule.id as number, inflight: 1, installing: null };
  const installing = sendMessage("updateDNRSessionRules", { rule }).then(
    () => {
      entry.installing = null;
    },
    (e) => {
      // 安装失败：立刻清掉缓存项，后续请求会重新安装。
      // （旧实现先写缓存再 await 安装，失败后 30s 内命中缓存直接返回 → unsafe header 静默丢失）
      dnrRuleCache.delete(cacheKey);
      throw e;
    },
  );
  entry.installing = installing;
  dnrRuleCache.set(cacheKey, entry);
  return installing.then(() => entry.ruleId);
}

async function acquireDnrRule(cacheKey: string, rule: chrome.declarativeNetRequest.Rule): Promise<number> {
  const existing = dnrRuleCache.get(cacheKey);
  if (existing) {
    const installing = existing.installing;
    if (installing) {
      await installing; // 并发同 key 请求共享同一次安装，失败则本次请求同样失败并允许下次重试
    }
    const current = dnrRuleCache.get(cacheKey); // 安装失败时 entry 已被删除
    if (current) {
      current.inflight++;
      return current.ruleId;
    }
  }
  return installDnrRule(cacheKey, rule);
}

/**
 * 请求结束/失败后释放一次在途计数：最后一个在途请求结束即按 id 删除规则。
 * 规则不再靠 30s 空闲 TTL 存活，避免会话级规则长期改写所有匹配的扩展请求；
 * 并发批量请求仍共享同一条规则（P1-9 的复用收益保留）。
 */
function releaseDnrRule(config: AxiosRequestConfig | undefined): void {
  const cacheKey = (config as { dnrRuleCacheKey?: string } | undefined)?.dnrRuleCacheKey;
  if (!cacheKey) {
    return;
  }
  const entry = dnrRuleCache.get(cacheKey);
  if (!entry) {
    return;
  }
  entry.inflight--;
  if (entry.inflight > 0) {
    return;
  }
  dnrRuleCache.delete(cacheKey);
  // 删除失败不改变控制流（规则会随会话结束清理），但保留可诊断日志
  sendMessage("removeDNRSessionRuleById", entry.ruleId).catch((e) =>
    console.warn(`[PTD] failed to remove DNR session rule ${entry.ruleId}:`, e),
  );
}

export function setupReplaceUnsafeHeader(axios: AxiosInstance): AxiosAllowUnsafeHeaderInstance {
  const axiosAllowUnsafeHeaderInstance = axios as AxiosAllowUnsafeHeaderInstance;

  if (axiosAllowUnsafeHeaderInstance.allowUnsafeHeader) {
    console.debug("setupReplaceUnsafeHeader() should be called only once");
    return axiosAllowUnsafeHeaderInstance;
  }
  axiosAllowUnsafeHeaderInstance.allowUnsafeHeader = true;

  // Add a request interceptor
  axiosAllowUnsafeHeaderInstance.interceptors.request.use(async function (config) {
    const carrier = config as AxiosRequestConfig & TUnsafeHeaderCarrier;
    let requestHeaders = carrier.dnrRequestHeaders;

    // 只在首次尝试时扫描 config.headers：此刻还没有被剥离，能拿到调用方原始设置的值。
    // 之后的尝试（Cloudflare 重试复用同一个 config）直接用记录在 config 上的列表重建规则。
    if (!requestHeaders && config.headers) {
      // 准备扔给 chrome.declarativeNetRequest 的请求头
      const extracted = [] as chrome.declarativeNetRequest.ModifyHeaderInfo[];

      for (const [key, value] of config.headers) {
        const lowerKey = key.toLowerCase();
        if (unsafeHeaders[lowerKey] || lowerKey.startsWith("sec-") || lowerKey.startsWith("proxy-")) {
          // 值为假值（null/undefined/空字符串）时视为"移除该请求头"（如 qBittorrent 绕过 CSRF 校验需要移除 Origin），
          // 而不是设置一个空值。注意不能用 null 作哨兵：AxiosHeaders 在构造/合并阶段就会丢弃 null 值，
          // 拦截器里看不到，空字符串可以存活到拦截器。
          extracted.push(
            !value
              ? {
                  header: key,
                  operation: "remove" as chrome.declarativeNetRequest.HeaderOperation.REMOVE,
                }
              : {
                  header: key,
                  operation: "set" as chrome.declarativeNetRequest.HeaderOperation.SET,
                  value: String(value),
                },
          );
          config.headers.delete(key);
        }
      }

      if (extracted.length > 0) {
        carrier.dnrRequestHeaders = requestHeaders = extracted;
      }
    }

    if (requestHeaders) {
      // 带上 params：getUri 返回的才是 axios 真正会请求的 URL（regexFilter 是精确匹配，不能再省略查询串）
      const requestUrl = axios.getUri({ baseURL: config.baseURL, url: config.url, params: config.params });
      const method = (config.method || "GET").toUpperCase();
      const cacheKey = JSON.stringify({ url: requestUrl, method, requestHeaders });
      const ruleId = dnrRuleIdForCacheKey(cacheKey);

      /**
       * DNR 会话规则在途复用（见 docs/performance-audit.md P1-9）。
       *
       * 早期实现每个请求都要 install + 响应后 remove；本轮重构改成 30s 空闲 TTL 复用，
       * 却引入了三个回归：安装失败也写缓存（后续命中缓存不再重试）、并发请求不断推后过期时间、
       * 规则 id 随机可能撞号。现在改为「按内容确定性 id + 在途计数」：
       * 并发同 key 请求共享一条规则，最后一个请求结束/失败立即删除规则，语义回到「请求结束即清理」，
       * 同时保留并发批量请求的复用收益。
       *
       * ⚠️ 每一次尝试都必须走到这里重新安装规则（B-17）：response 拦截器在**上一次尝试结束时**
       * 已经按 id 删除了规则（`releaseDnrRule` 先于 CF 重试执行：axios 的 request 拦截器用 `unshift`
       * 逆序、response 拦截器用 `push` 正序，而 setupReplaceUnsafeHeader 先注册），
       * 所以重试请求必须自己再装一次，否则就会丢掉 Referer/Origin/User-Agent。
       * 同一份 headers 的 cacheKey 与 id 都是确定性的，重装只是把同一条规则按 id 覆盖回去。
       */
      (config as any).dnrRuleCacheKey = cacheKey;
      (config as any).dummyHeaderRequestId = ruleId;

      const rule = {
        id: ruleId,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders,
        },
        condition: {
          regexFilter: toExactUrlRegexFilter(requestUrl),
          resourceTypes: ["xmlhttprequest" as chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
          requestMethods: [method.toLowerCase() as chrome.declarativeNetRequest.RequestMethod],
        },
      } as chrome.declarativeNetRequest.Rule;

      await acquireDnrRule(cacheKey, rule);
    }

    return config;
  });

  // 请求结束/失败后释放规则：最后一个在途请求结束时按 id 删除自己装的 DNR 规则
  axiosAllowUnsafeHeaderInstance.interceptors.response.use(
    function (response) {
      releaseDnrRule(response.config);
      return response;
    },
    function (error) {
      releaseDnrRule(error?.config);
      return Promise.reject(error);
    },
  );

  return axiosAllowUnsafeHeaderInstance;
}
