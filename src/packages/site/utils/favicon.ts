/**
 * 获取站点图标的方法
 *
 * 我们不用很在意 Favicon 的本地缓存情况，因为这部分可以随时重新获取，所以直接用 localforage 就行了
 * 程序按照如下顺序获取Favicon：
 *   1. '../icons' 目录中是否存在对应 png 或 ico 文件 `${config.id}.${"png" | "ico"}`
       注意：1. 主要方便 以解压缩形式安装的用户覆写 以及部分教育网站点可能需要特殊方法访问的情况
            2. 此时，ISiteMetadata 中定义的 favicon 字段配置项不起作用，强制刷新缓存不起作用（本地硬配置优先）
 *   2. localforage 中已有的 base64 缓存（根据站点的 host 值）
 *   3. ISiteMetadata 中定义的 favicon 字段
 *   4. 请求网站首页，并从返回的html中解析所需要的 favicon 字段
 *   5. 使用 NO_IMAGE 替代
 *
 * special thanks to: https://github.com/spro/get-website-favicon/tree/master/lib/origin
 */

import { logMessage } from "./adapter";
import { isHostTrusted } from "./trustedHost";
import type { ISiteMetadata } from "../types";

// from: https://stackoverflow.com/a/9967193/8824471
// from: http://proger.i-forge.net/%D0%9A%D0%BE%D0%BC%D0%BF%D1%8C%D1%8E%D1%82%D0%B5%D1%80/[20121112]%20The%20smallest%20transparent%20pixel.html
export const NO_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=";

const FAVICON_FROM_LINK = [
  "link[rel='icon' i][href]",
  "link[rel='shortcut icon' i][href]",
  "link[rel='apple-touch-icon' i][href]",
  "link[rel='apple-touch-icon-precomposed' i][href]",
  "link[rel='apple-touch-startup-image' i][href]",
  "link[rel='fluid-icon' i][href]",
  // "meta[name='msapplication-TileImage' i][content]"
];

interface IParsedFavicon {
  href: string;
  sizes: string | `${string}x${string}`;
  source: "manifest" | "link" | "favicon";
  blob?: Blob;
}

/**
 * 候选图标评分（分数越高越优先）。
 *
 * N4：原实现按「source ×100、ext ×10、sizes ×1」加权后降序取第一，但 source / ext 的分值
 * 方向使默认的 `/favicon.ico`（source=favicon、ext=ico）恒排第一 —— 站点同时提供 manifest
 * 里的 512×512 PNG 时仍会缓存 16×16 的 ico。这里改成显式档位：
 * - source：manifest（站点显式声明的多尺寸图标集合）> `<link rel=icon>` > `/favicon.ico` 默认；
 * - ext：svg/webp > png > jpeg > ico（无扩展名按 0）；
 * - sizes：方形图标优先，≥32 最高，16~31 次之，过小/非方形/未知最低。
 */
function rankFavicon(item: IParsedFavicon): number {
  const sourceRank = item.source === "manifest" ? 3 : item.source === "link" ? 2 : 1;

  let extRank = 0;
  if (/\.(svg|webp)(\?|#|$)/i.test(item.href)) {
    extRank = 4;
  } else if (/\.png(\?|#|$)/i.test(item.href)) {
    extRank = 3;
  } else if (/\.jpe?g(\?|#|$)/i.test(item.href)) {
    extRank = 2;
  } else if (/\.ico(\?|#|$)/i.test(item.href)) {
    extRank = 1;
  }

  let sizeRank = 0;
  const [width, height] = String(item.sizes ?? "")
    .toLowerCase()
    .split("x")
    .map((value) => parseInt(value, 10));
  if (Number.isFinite(width) && width === height) {
    if (width >= 32) {
      sizeRank = 3;
    } else if (width >= 16) {
      sizeRank = 2;
    } else {
      sizeRank = 1;
    }
  }

  return sourceRank * 1_000_000 + extRank * 10_000 + sizeRank;
}

/**
 * E21（残余）：判断下载到的 Blob 能否作为图标 —— 接受 `image/*`。
 *
 * 早期实现只对默认 `/favicon.ico` 校验 MIME，`<link rel=icon>` / manifest 里声明的候选
 * 直接转 base64，站点对「未登录请求」返回 200 登录页/HTML 时会把 `data:text/html;base64,…`
 * 缓存成图标。因此这里拒绝明确的非图片类型（如 `text/html`、`application/json`）。
 *
 * L-4（第二轮复检）：很多站点把 `.ico` / `.png` 标成 `application/octet-stream` /
 * `binary/octet-stream`，此前会被当成「非图片」误杀（旧实现对 link/manifest 候选不做 MIME 校验）。
 * 现在只对「无 MIME」或「通用二进制 MIME」按 URL 扩展名兜底；`text/html` 等明确类型仍然拒绝。
 */
function isUsableIconBlob(blob: Blob, href: string): boolean {
  const type = (blob.type || "").toLowerCase();
  if (type.startsWith("image/")) {
    return true;
  }
  if (type && type !== "application/octet-stream" && type !== "binary/octet-stream") {
    return false;
  }
  return /\.(ico|png|jpe?g|gif|svg|webp)(\?|#|$)/i.test(href);
}

// FIXME 转成公共函数 BlobToBase64
function transformBlob(blob: Blob): Promise<any> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("loadend", () => {
      if (reader.result) {
        resolve(reader.result);
      } else {
        reject(new Error("Error when parse favicon Blob"));
      }
    });

    reader.readAsDataURL(blob);
  });
}

function trustedIconUrl(href: string, base: string, trustedHosts: readonly string[]): string | undefined {
  try {
    if (!href.trim()) return undefined;
    const target = new URL(href, base);
    if (
      (target.protocol === "https:" || target.protocol === "http:") &&
      // L-3：与 request()/sender 共用同一套主机比较规则（全等或子域、`www.` 归一化）。
      // 旧实现的 `trustedHosts.has(hostname)` 是**精确相等**，会把 `static.` / `cdn.` 子域
      // 或 page 用 `www.` 而 href 用裸域的候选图标全部跳过；两处语义统一后保留同一信任边界。
      isHostTrusted(target.hostname, trustedHosts)
    ) {
      return target.href;
    }
  } catch {
    // Invalid and non-HTTP URLs are not fetchable icon candidates.
  }
  return undefined;
}

/**
 * 抓取图标相关资源（首页 HTML / manifest / 图标 Blob），返回**跟随重定向后的**响应与最终 URL。
 *
 * L-3（第二轮复检）：旧实现 `redirect:"error"` 会让「站点首页 301 到 https / www / 镜像域」
 * 的图标抓取整体失败并回落 `NO_IMAGE`（HEAD 的 axios 会跟随重定向）。现在改为跟随重定向，
 * 但**必须校验最终响应地址仍落在可信 host**（防开放重定向把内容换成外站 HTML/图标）。
 *
 * 残余风险与缓解：
 * - 浏览器 fetch 无法在跟随前读取 `Location`（`redirect:"manual"` 返回不可读的 opaqueredirect），
 *   因此重定向目标会在校验前被请求一次（盲 SSRF 面）；这里用 `credentials:"same-origin"`
 *   保证跨站重定向目标**收不到站点 cookie**（与旧 axios 默认行为一致），且最终内容只要 host 不可信
 *   就直接丢弃。后续如需要进一步收紧，应改为由后台代发请求并做逐跳校验。
 */
async function fetchTrustedIconResource(
  url: string,
  trustedHosts: readonly string[],
): Promise<{ response: Response; url: string }> {
  const trustedUrl = trustedIconUrl(url, url, trustedHosts);
  if (!trustedUrl) throw new Error("Icon URL is not on a trusted site host");

  const response = await fetch(trustedUrl, { credentials: "same-origin", redirect: "follow" });
  const finalUrl = response.url || trustedUrl;
  let parsedFinal: URL;
  try {
    parsedFinal = new URL(finalUrl);
  } catch {
    throw new Error("Icon request returned an invalid final URL");
  }
  if (
    (parsedFinal.protocol !== "https:" && parsedFinal.protocol !== "http:") ||
    !isHostTrusted(parsedFinal.hostname, trustedHosts)
  ) {
    throw new Error("Icon request was redirected to an untrusted host");
  }
  if (!response.ok) throw new Error(`Icon request failed with HTTP ${response.status}`);
  return { response, url: parsedFinal.href };
}

async function getFaviconFromUrl(url: string, trustedHosts: readonly string[]): Promise<Blob> {
  const siteUrl = trustedIconUrl(url, url, trustedHosts);
  if (!siteUrl) throw new Error("Site URL is not a trusted HTTP(S) URL");

  const pageResource = await fetchTrustedIconResource(siteUrl, trustedHosts);
  // 以「跟随重定向后的实际页面地址」作为相对图标/manifest 的解析基址
  const pageUrl = pageResource.url;
  const doc = new DOMParser().parseFromString(await pageResource.response.text(), "text/html");

  const favicons: IParsedFavicon[] = [];

  // 1. Parse from head
  FAVICON_FROM_LINK.forEach((selector) => {
    const element = doc.querySelector(selector) as HTMLLinkElement;
    if (element) {
      const href = trustedIconUrl(element.getAttribute("href") ?? "", pageUrl, trustedHosts);
      if (href) {
        favicons.push({
          href,
          sizes: element.sizes?.toString() || "",
          source: "link",
        });
      }
    }
  });

  // 2. Parse from manifest
  const manifestElement = doc.querySelector('head link[rel="manifest" i]') as HTMLLinkElement;
  if (manifestElement) {
    const manifestUrl = trustedIconUrl(manifestElement.getAttribute("href") ?? "", pageUrl, trustedHosts);
    if (manifestUrl) {
      try {
        const manifestResource = await fetchTrustedIconResource(manifestUrl, trustedHosts);
        const manifest = (await manifestResource.response.json()) as {
          icons?: Array<{ sizes?: string; src?: string; type?: string }>;
        };

        // manifest 可能是 `{"name":"x"}` 这类没有 icons（或 icons 不是数组）的合法 JSON：
        // 这里必须降级而不是抛 TypeError —— 否则第 1 步已收集到的 <link rel=icon> 会一起丢失（A-19）
        if (Array.isArray(manifest?.icons)) {
          manifest.icons.forEach((icon) => {
            // M-32：不能在参数里直接解构 —— `icons: [null]` 会在进入函数体之前就抛 TypeError，
            // 中止循环并让第 1 步已收集的图标一起作废（正是 A-19 想避免的）
            const { sizes, src } = icon && typeof icon === "object" ? icon : ({} as { sizes?: string; src?: string });
            if (typeof src !== "string" || !src.trim()) {
              logMessage(`[Favicon] manifest 中存在缺少 src 的图标条目，已跳过`, {
                url: manifestResource.url,
                sizes,
              });
              return;
            }
            // manifest 内相对 src 按「manifest 实际地址（跟随重定向后）」解析
            const href = trustedIconUrl(src, manifestResource.url, trustedHosts);
            if (href) {
              favicons.push({
                href,
                sizes: typeof sizes === "string" ? sizes : "",
                source: "manifest",
              });
            }
          });
        } else {
          logMessage(`[Favicon] manifest 中缺少合法的 icons 数组，跳过该步骤`, {
            url: manifestResource.url,
          });
        }
      } catch (e) {
        logMessage(`[Favicon] manifest 获取失败：${manifestUrl}`, {
          url: manifestUrl,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // 3. Default /favicon.ico（按跟随重定向后的页面 origin）
  const pageOrigin = new URL(pageUrl).origin;
  try {
    const faviconResource = await fetchTrustedIconResource(`${pageOrigin}/favicon.ico`, trustedHosts);
    const faviconIco = await faviconResource.response.blob();
    // E21：只接受图片类型；.ico 的 IANA 注册类型是 image/vnd.microsoft.icon，image/x-icon 是事实标准，
    // 服务器也可能把 ico 标成 image/png 等，这里统一按 image/* 判断（见 isUsableIconBlob）
    if (isUsableIconBlob(faviconIco, faviconResource.url)) {
      favicons.push({
        href: faviconResource.url,
        sizes: "",
        source: "favicon",
        blob: faviconIco,
      } as IParsedFavicon);
    } else {
      logMessage(`[Favicon] ${pageOrigin}/favicon.ico 不是图片，已跳过`, {
        url: pageOrigin,
        type: faviconIco.type,
      });
    }
  } catch (e) {
    // P1-5：站点没有 /favicon.ico 属于常见情况，这里不中断流程，但把原因记录下来便于排查
    logMessage(`[Favicon] ${pageOrigin}/favicon.ico 获取失败`, {
      url: pageOrigin,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // 如果前面获取到足够的 favicons，我们需要比较下哪个更合适，并排序
  if (favicons.length > 0) {
    const rankedFavicons: Array<IParsedFavicon & { rank: number }> = favicons
      .map((icon) => ({ ...icon, rank: rankFavicon(icon) }))
      .sort((a, b) => b.rank - a.rank);

    // 选择排序后第一个图标作为我们需要的图标
    for (const usedFavicons of rankedFavicons) {
      if (usedFavicons.blob) {
        return usedFavicons.blob;
      } else {
        try {
          const iconResource = await fetchTrustedIconResource(usedFavicons.href, trustedHosts);
          const blob = await iconResource.response.blob();
          // E21：候选图标同样必须是图片，否则继续尝试下一个候选
          if (isUsableIconBlob(blob, iconResource.url)) {
            return blob;
          }
          logMessage(`[Favicon] 候选图标的 Content-Type 不是图片，已跳过`, {
            href: usedFavicons.href,
            type: blob.type,
          });
        } catch (e) {
          // 单个候选图标下载失败是预期内的降级路径，继续尝试下一个候选
          logMessage(`[Favicon] 候选图标下载失败：${usedFavicons.href}`, {
            href: usedFavicons.href,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  }

  throw new Error("Can't find any favicons from this site");
}

export type getFaviconMetadata = Required<Pick<ISiteMetadata, "id" | "urls">> &
  Pick<ISiteMetadata, "favicon" | "legacyUrls">;

export async function getFavicon(site: getFaviconMetadata): Promise<string> {
  const { id: siteId, urls: siteUrls, favicon: siteFavicon } = site;
  // L-3：可信主机列表改为数组并交给 isHostTrusted（全等或子域、www 归一化），
  // 与 request()/sender 的 host 判定统一；`legacyUrls` 同样参与（迁移域名后旧域图标仍可抓取）。
  const trustedHosts: string[] = [];
  for (const url of [...siteUrls, ...(site.legacyUrls ?? [])]) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") trustedHosts.push(parsed.hostname.toLowerCase());
    } catch {
      // Ignore malformed site URLs.
    }
  }

  // 1. 检查本地icons目录是否存在对应文件
  let checkLocalIconPaths = [`${siteId}.png`, `${siteId}.ico`, `${siteId}.svg`];

  if (siteFavicon) {
    if (siteFavicon.startsWith("data:image/")) {
      return siteFavicon; // base64直接返回就行了
    } else if (siteFavicon.startsWith("./")) {
      checkLocalIconPaths = [siteFavicon.replace(/^\.\//, ""), ...checkLocalIconPaths]; // 优先使用 已定义的 favicon
    }
  }

  for (const checkLocalIconPath of checkLocalIconPaths) {
    if (__RESOURCE_SITE_ICONS__.includes(checkLocalIconPath)) {
      return `/icons/site/${checkLocalIconPath}`;
    }
  }

  // 2. 检查网站是否有对应icon
  let faviconMeta;

  // 2.1 ISiteMetadata 中定义的 favicon 字段为一个链接
  if (siteFavicon && siteFavicon.startsWith("http")) {
    try {
      const iconUrl = trustedIconUrl(siteFavicon, siteUrls[0], trustedHosts);
      if (!iconUrl) {
        throw new Error("Icon URL is not on a trusted site host");
      }
      const iconResource = await fetchTrustedIconResource(iconUrl, trustedHosts);
      const blob = await iconResource.response.blob();
      // E21：metadata 声明的链接同样可能是 200 返回的登录页/HTML，必须校验内容类型
      if (!isUsableIconBlob(blob, iconResource.url)) {
        throw new Error(`Icon content-type is not an image: ${blob.type}`);
      }
      faviconMeta = blob;
    } catch (e) {
      // 站点元数据中声明的 favicon 链接可能已失效，回落到请求首页解析
      logMessage(`[Favicon] metadata 声明的 favicon 获取失败：${siteFavicon}`, {
        siteId,
        url: siteFavicon,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 2.2 请求网站首页，并从返回的html中解析所需要的 favicon 字段
  if (!faviconMeta) {
    for (const url of siteUrls) {
      try {
        faviconMeta = await getFaviconFromUrl(url, trustedHosts);
        break;
      } catch (e) {
        // 单个站点地址解析失败时继续尝试下一个地址，全部失败后回落到 NO_IMAGE
        logMessage(`[Favicon] 从首页解析 favicon 失败：${url}`, {
          siteId,
          url,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // 将请求结果转为 base64
  let faviconBase64;
  if (typeof faviconMeta !== "undefined") {
    faviconBase64 = await transformBlob(faviconMeta); // 将 faviconMeta 转成 base64，并缓存
  }

  // 3. fallback 使用 NO_IMAGE 替代
  faviconBase64 ??= NO_IMAGE;

  return faviconBase64;
}
