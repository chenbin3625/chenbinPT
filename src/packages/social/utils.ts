export function commonParseFactory(urlPatterns: (string | RegExp)[]): (query: string) => string {
  return (query: string): string => {
    for (const regExp of urlPatterns) {
      const match = query.match(regExp);
      if (match) {
        return match[1] as string;
      }
    }
    return query; // 如果没有匹配，返回原始查询
  };
}

/** 本机 / 私网 / 链路本地 / CGNAT 地址（用于拒绝把社交海报 URL 指向内网，见 C2-S-3） */
function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // IPv6 ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // IPv6 link-local fe80::/10

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }

  return false;
}

/**
 * 归一化/校验社交媒体信息里的海报 URL（C2-S-3）。
 *
 * `poster` 来自第三方 JSON（PtGen / 豆瓣接口 / 页面 ld+json），会被写入 IndexedDB、经消息传到
 * offscreen，最终被扩展以自身身份请求（offscreen/utils/socialRecommendations.ts 的 fetchPosterDataUrl）。
 * 因此这里至少拦掉非 http(s) 协议、以及指向本机/私网/链路本地的地址（SSRF/内网探测）。
 *
 * 说明：没有做「图床域名白名单」，因为 PtGen 端点可由用户自定义（海报可能来自任意自建图床）；
 * 更严格的允许列表应由下游请求汇点（offscreen 侧）配合实现。
 */
export function normalizeSocialPosterUrl(url?: string | null): string | undefined {
  if (typeof url !== "string") return undefined;
  const value = url.trim();
  if (!value) return undefined;

  // 已解出的 data URL（个别来源会直接返回 base64）保持原样
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(value)) return value;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (isPrivateOrLocalHostname(parsed.hostname)) return undefined;

  return value;
}
