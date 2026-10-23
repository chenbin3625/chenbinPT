/**
 * 此函数用于处理 Cloudflare 阻止请求的情况。
 */

import { pick } from "es-toolkit";
import { sendMessage } from "@/messages.ts";
import type { AxiosError, AxiosInstance, AxiosResponse, AxiosStatic, AxiosRequestConfig } from "axios";

const cloudflareBlocked5xxCodes = [
  521, // used by cloudflare to signal the original webserver is refusing the connection
  522, // used by cloudflare to signal the original webserver is not reachable at all (timeout)
  523, // used by cloudflare to signal the original webserver is not reachable at all (Origin is unreachable)
];

export function isCloudflareBlocked(response: AxiosResponse): boolean {
  if (!response) {
    return false;
  }

  try {
    // https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/#detect-a-challenge-page-response
    if (response.headers?.["cf-mitigated"] === "challenge") {
      return true;
    }

    if (cloudflareBlocked5xxCodes.includes(response.status)) {
      return true;
    }

    // 其他 403 需进一步判断
    if (response.status === 403) {
      const request = response.request as XMLHttpRequest;
      const responseText =
        request.responseType === "document" ? request.responseXML?.documentElement?.outerHTML : request.responseText;
      if (typeof responseText === "undefined") {
        return false; // 检查最终的Text，如果什么都没有, bypass
      } else if (/Enable JavaScript and cookies to continue/.test(responseText)) {
        return true; // 包含关键字，说明被封锁
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[CFBlockCheck] An error occurred while checking CF block status:", e);
  }

  return false;
}

interface AxiosRetryWhenCloudflareBlockInstance extends AxiosInstance {
  // 防重标志位挂在实例对象上而非 defaults（EXTENDSI18N-6）：
  // axios.create() 会通过 mergeConfig 继承 defaults，把标志写在 defaults 上会让任何从已配置实例
  // 派生出来的新实例一出生就带标志位、被守卫静默跳过（拦截器不注册，CF 挑战不再重试）；
  // 实例自身的属性不会被 create() 继承，因此派生实例仍能正常注册重试拦截器。
  retryWhenCloudflareSetup?: boolean;
}

function fixConfig(axiosInstance: AxiosInstance | AxiosStatic, config: AxiosRequestConfig) {
  // @ts-expect-error agent 是 node 适配器专属字段，axios 浏览器端类型未声明
  if (axiosInstance.defaults.agent === config.agent) {
    // @ts-expect-error 同上：浏览器端类型未声明 agent 字段
    delete config.agent;
  }
  if (axiosInstance.defaults.httpAgent === config.httpAgent) {
    delete config.httpAgent;
  }
  if (axiosInstance.defaults.httpsAgent === config.httpsAgent) {
    delete config.httpsAgent;
  }
}

const cookieRetryChains = new Map<string, Promise<void>>();

/**
 * 租约排队的最长等待时间（缺陷清单 G1）。
 *
 * `cookieRetryChains` 按 cf_clearance 的 `storeId|domain|path|name` 串行化
 * 「临时 cookie set → 重试请求 → 复原」。旧实现的排队是裸 `await previous`：
 * 只要前一个重试的 socket / 消息通道永久挂起（站点 hang、SW 在消息在途时被杀、代理不返回），
 * `release()` 就永不执行，**同站点后续所有 CF 重试都停在 `await previous`**，
 * 且 Map 里留下一条永不 resolve 的 pending entry（模块级 Map 只有上下文销毁才清空）。
 *
 * 取 35s：大于站点请求的默认超时（`AbstractBittorrentSite.request` 的 `timeout = 30e3`），
 * 因此正常情况下排队总会先等到前一个重试自己超时退出，不会误伤正常串行；
 * 只有「前一个任务彻底挂死」时才会触发，属于兜底的活性保障。
 */
const COOKIE_RETRY_LEASE_WAIT_TIMEOUT = 35_000;

/**
 * 重试请求自身在 `config.timeout` 缺失/为 0 时的兜底超时（G1）。
 *
 * 本模块不给 axios 实例设置 timeout：正常路径由调用方实例的默认超时（默认 30s）兜底。
 * 但站点设置里的 `requestTimeout` 允许填 0（axios 语义 = 不限时），或将来把拦截器装到
 * 没有默认超时的实例上 —— 那样重试会永久挂起，并把上面的租约一起拖住。
 * 只在**没有正数 timeout** 时补一个有限值，不改变正常请求（已有 30s）的语义。
 */
const COOKIE_RETRY_REQUEST_TIMEOUT = 30_000;

/** 等待前一个租约，超过 {@link COOKIE_RETRY_LEASE_WAIT_TIMEOUT} 直接失败（不无限排队） */
function waitForCookieRetryLease(previous: Promise<void> | undefined, key: string): Promise<void> {
  if (!previous) {
    return Promise.resolve();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    previous,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `[PTD] timed out waiting for the CF retry lease (${key}) after ${COOKIE_RETRY_LEASE_WAIT_TIMEOUT}ms`,
          ),
        );
      }, COOKIE_RETRY_LEASE_WAIT_TIMEOUT);
    }),
  ]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

async function withCookieRetryLease<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = cookieRetryChains.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  cookieRetryChains.set(key, current);
  try {
    await waitForCookieRetryLease(previous, key);
  } catch (error) {
    // 排队超时：本次请求不再执行 task，并把自己从链上摘掉。
    // 取舍（G1）：此时前一个租约很可能已经挂死，继续让后续请求排在它后面等于永久阻塞；
    // 摘掉自己后，后续请求看到的是「没有前一个租约」而直接执行（并发写临时 cookie 的窗口
    // 只存在于「前一个任务已经挂死」这一异常场景，且规则内容对同一请求幂等）。
    release();
    if (cookieRetryChains.get(key) === current) {
      cookieRetryChains.delete(key);
    }
    throw error;
  }
  try {
    return await task();
  } finally {
    release();
    if (cookieRetryChains.get(key) === current) cookieRetryChains.delete(key);
  }
}

type CookieSetDetails = chrome.cookies.SetDetails & { hostOnly?: boolean };

function cookieDetails(cookie: chrome.cookies.Cookie): CookieSetDetails {
  return pick(cookie, [
    "domain",
    "expirationDate",
    "name",
    "path",
    "sameSite",
    "secure",
    "storeId",
    "value",
    "httpOnly",
    "hostOnly",
  ]) as CookieSetDetails;
}

async function restoreCloudflareCookie(
  temporary: CookieSetDetails,
  original: chrome.cookies.Cookie | null,
): Promise<void> {
  try {
    await sendMessage("removeCookie", temporary);
    if (original && !(await sendMessage("setCookie", cookieDetails(original)))) {
      // eslint-disable-next-line no-console
      console.warn("[PTD] failed to restore original cf_clearance cookie");
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[PTD] failed to restore original cf_clearance cookie:", e);
  }
}

export function setupRetryWhenCloudflareBlock(axios: AxiosInstance): AxiosRetryWhenCloudflareBlockInstance {
  const axiosRetryWhenCloudflareBlockInstance = axios as AxiosRetryWhenCloudflareBlockInstance;

  if (axiosRetryWhenCloudflareBlockInstance.retryWhenCloudflareSetup) {
    // eslint-disable-next-line no-console
    console.debug("setupRetryWhenCloudflareBlock() should be called only once");
    return axiosRetryWhenCloudflareBlockInstance;
  }
  axiosRetryWhenCloudflareBlockInstance.retryWhenCloudflareSetup = true;

  // 临时 cookie 由外层重试的 finally 清理，不能在内层响应拦截器中提前删除。
  axiosRetryWhenCloudflareBlockInstance.interceptors.response.use(
    async (response) => response,
    async (error: AxiosError) => {
      const isCFBlocked = isCloudflareBlocked(error.response!);

      const { config } = error;

      // If we have no information to retry the request
      if (!config) {
        return Promise.reject(error);
      }

      // 如果请求参数中没有 isCfBlockedRetry 标记，说明是第一次被 Cloudflare 阻止的请求
      if (isCFBlocked && (config as any)?.isCfBlockedRetry !== true) {
        // 尝试获取到 cf_clearance
        const fullRequestUrl = axiosRetryWhenCloudflareBlockInstance.getUri(config);
        const parsedUrl = new URL(fullRequestUrl, "http://localhost");
        const partitionSiteKey = `${parsedUrl.protocol}//${parsedUrl.hostname}`;

        const cfCookie = await sendMessage("getAllCookies", {
          url: fullRequestUrl,
          name: "cf_clearance",
          partitionKey: { topLevelSite: partitionSiteKey },
        });

        if (cfCookie && cfCookie.length > 0) {
          // 强行设置一个新的但是没有 partitionKey 属性的 cf_clearance 以便于fetch时能使用
          const newCfCookie = cookieDetails(cfCookie[0]);
          const cookieKey = [newCfCookie.storeId, newCfCookie.domain, newCfCookie.path, newCfCookie.name].join("|");
          return withCookieRetryLease(cookieKey, async () => {
            const original = await sendMessage("getCookie", {
              url: fullRequestUrl,
              name: "cf_clearance",
              storeId: newCfCookie.storeId,
            });
            if (!(await sendMessage("setCookie", newCfCookie))) {
              return Promise.reject(error);
            }
            try {
              (config as any).isCfBlockedRetry = true;
              await new Promise((resolve) => setTimeout(resolve, 800));
              fixConfig(axiosRetryWhenCloudflareBlockInstance, config);
              // 重试请求必须有上限（G1，见 COOKIE_RETRY_REQUEST_TIMEOUT）：
              // 正常路径沿用调用方实例的 timeout（默认 30s），只有缺失/为 0 时才补兜底值。
              if (typeof config.timeout !== "number" || config.timeout <= 0) {
                config.timeout = COOKIE_RETRY_REQUEST_TIMEOUT;
              }
              return await axiosRetryWhenCloudflareBlockInstance(config);
            } finally {
              await restoreCloudflareCookie(newCfCookie, original);
            }
          });
        }
      }

      return Promise.reject(error);
    },
  );

  return axiosRetryWhenCloudflareBlockInstance;
}
