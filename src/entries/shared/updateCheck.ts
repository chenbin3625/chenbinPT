export const UPDATE_REPO_OWNER = "chenbin3625";
export const UPDATE_REPO_NAME = "chenbinPT";
export const UPDATE_REPO_SLUG = `${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}`;
export const UPDATE_RELEASES_PAGE_URL = `https://github.com/${UPDATE_REPO_SLUG}/releases/latest`;
export const UPDATE_RELEASE_MANIFEST_URL = `https://github.com/${UPDATE_REPO_SLUG}/releases/latest/download/latest.json`;
export const UPDATE_RELEASE_API_URL = `https://api.github.com/repos/${UPDATE_REPO_SLUG}/releases/latest`;

export const UPDATE_CHECK_STATE_STORAGE_KEY = "ptd_update_check_state";
export const UPDATE_CHECK_INTERVAL_OPTIONS = [6, 12, 24, 72, 168] as const;

export type TUpdateBrowserTarget = "chrome" | "firefox";

export interface IUpdateCheckConfig {
  /** 是否开启定期自动检测新版本 */
  enabled: boolean;
  /** 自动检查周期（小时） */
  intervalHours: number;
  /** 发现新版本时是否发送系统桌面通知 */
  notifyBrowser: boolean;
  /** 用户选择忽略的版本号（规范化数字版本，如 "0.0.28"） */
  ignoredVersion: string;
}

export const DEFAULT_UPDATE_CHECK_CONFIG: IUpdateCheckConfig = {
  enabled: true,
  intervalHours: 24,
  notifyBrowser: true,
  ignoredVersion: "",
};

export interface IUpdateReleaseAsset {
  name: string;
  url: string;
  size?: number;
  sha256?: string;
}

export interface IUpdateReleaseInfo {
  /** 规范化数字版本，例如 "0.0.28" */
  version: string;
  /** 原始 Release tag，例如 "v0.0.28" */
  tagName: string;
  /** 发布标题 */
  name: string;
  /** GitHub Release 页面链接 */
  releaseUrl: string;
  /** ISO 发布时间 */
  publishedAt?: string;
  /** 纯文本/Markdown 原文更新说明（UI 必须按纯文本渲染，禁止 v-html） */
  notes: string;
  /** 数据来源 */
  source: "manifest" | "github-api";
  /** 匹配当前浏览器的首选安装包 */
  asset?: IUpdateReleaseAsset;
  /** 本次发布附带的全部可信安装包 */
  allAssets: IUpdateReleaseAsset[];
}

export type TUpdateCheckStatus = "idle" | "up-to-date" | "update-available" | "error";

export interface IUpdateCheckState {
  currentVersion: string;
  checkedAt: number;
  status: TUpdateCheckStatus;
  latest?: IUpdateReleaseInfo;
  error?: string;
  lastNotifiedVersion?: string;
}

export interface IDownloadUpdateResult {
  downloadId: number;
  filename: string;
}

export interface IOpenExtensionsPageResult {
  opened: boolean;
  url: string;
}

/**
 * 从版本串里取出数字版本：兼容现行的三段版本（`v0.0.10+d8d0628`）与旧的四段版本（`v0.0.7.1962+abc`）。
 *
 * M-14：原正则 `/v(\d+\.\d+\.\d+\.\d+)/` 只认四段，版本号改为三段后恒返回 null，
 * compareVersion 随之恒为 null —— 「用旧版扩展恢复新版备份」的警示从此永远不弹。
 */
export function extractVersion(str: string = ""): string | null {
  const match = str.match(/v?(\d+(?:\.\d+){2,3})/);
  return match ? match[1] : null;
}

/**
 * 比较两个版本号字符串：inputV1 < inputV2 返回 -1，相等返回 0，大于返回 1；任一无法解析返回 null。
 * 段数不同时缺失段按 0 处理（`0.0.7.1962` > `0.0.7`，`0.0.8` > `0.0.7.1962`）。
 */
export function compareVersion(inputV1?: string, inputV2?: string): -1 | 0 | 1 | null {
  const v1 = extractVersion(inputV1);
  const v2 = extractVersion(inputV2);
  if (!v1 || !v2) return null;

  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

const TRUSTED_REPO_PREFIX = `/${UPDATE_REPO_OWNER.toLowerCase()}/${UPDATE_REPO_NAME.toLowerCase()}/`;
const TRUSTED_ASSET_CDN_HOSTS = new Set(["objects.githubusercontent.com", "release-assets.githubusercontent.com"]);

/**
 * 校验更新相关链接是否指向官方仓库或其 GitHub Release 资产 CDN。
 * 仅允许 https 协议，避免被篡改清单诱导下载任意站点文件或执行非 http(s) 协议。
 */
export function isTrustedUpdateUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw.trim()) return false;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    const pathLower = parsed.pathname.toLowerCase();
    if (host === "github.com" || host === "raw.githubusercontent.com") {
      return pathLower === TRUSTED_REPO_PREFIX.slice(0, -1) || pathLower.startsWith(TRUSTED_REPO_PREFIX);
    }
    if (TRUSTED_ASSET_CDN_HOSTS.has(host)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 规范化下载文件名：去除路径分隔符与非法字符，避免路径穿越写入浏览器下载目录之外。
 */
export function sanitizeUpdateFilename(rawName: string | undefined, fallbackVersion?: string): string {
  const base = (rawName ?? "")
    .replace(/[\\/]+/g, "_")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 120);
  if (base && /\.(zip|crx|xpi)$/i.test(base)) {
    return base;
  }
  const safeVer = extractVersion(fallbackVersion ?? "") ?? "latest";
  return `chenbinPT-v${safeVer}.zip`;
}

/**
 * 为下载包生成带版本号的友好文件名，避免多次升级时浏览器下载目录里全是 `extension-chrome (1).zip`。
 */
export function buildSuggestedDownloadFilename(assetName: string | undefined, version: string): string {
  const cleanAsset = sanitizeUpdateFilename(assetName, version);
  const safeVer = extractVersion(version);
  if (!safeVer) return cleanAsset;
  if (cleanAsset.includes(safeVer)) return cleanAsset;
  return sanitizeUpdateFilename(`chenbinPT-v${safeVer}-${cleanAsset}`, safeVer);
}

function normalizeSha256(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(trimmed) ? trimmed : undefined;
}

function normalizeAsset(raw: unknown): IUpdateReleaseAsset | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const urlCandidate =
    typeof record.browser_download_url === "string"
      ? record.browser_download_url
      : typeof record.url === "string"
        ? record.url
        : "";
  if (!name || !isTrustedUpdateUrl(urlCandidate)) return null;
  const size =
    typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0 ? record.size : undefined;
  const sha256 = normalizeSha256(record.sha256 ?? record.digest?.toString().replace(/^sha256:/i, ""));
  return {
    name,
    url: urlCandidate.trim(),
    ...(size !== undefined ? { size } : {}),
    ...(sha256 ? { sha256 } : {}),
  };
}

/**
 * 从资产列表中挑选最适合当前目标浏览器的安装包。
 * - chrome：优先 `extension-chrome.zip`（与 README 解压覆盖升级说明一致），其次任意含 chrome 的 zip；
 * - firefox：优先 `extension-firefox.zip`，其次含 firefox 的 zip 或 xpi。
 */
export function selectAssetForBrowser(
  assets: readonly IUpdateReleaseAsset[],
  target: TUpdateBrowserTarget,
): IUpdateReleaseAsset | undefined {
  if (assets.length === 0) return undefined;
  const lower = (a: IUpdateReleaseAsset) => a.name.toLowerCase();

  if (target === "firefox") {
    return (
      assets.find((a) => lower(a) === "extension-firefox.zip") ??
      assets.find((a) => lower(a).includes("firefox") && lower(a).endsWith(".zip")) ??
      assets.find((a) => lower(a).includes("firefox") && lower(a).endsWith(".xpi"))
    );
  }

  return (
    assets.find((a) => lower(a) === "extension-chrome.zip") ??
    assets.find((a) => lower(a).includes("chrome") && lower(a).endsWith(".zip")) ??
    assets.find((a) => !lower(a).includes("firefox") && lower(a).endsWith(".zip"))
  );
}

/**
 * 解析静态发版清单 `latest.json`（可选，由本地发版脚本附带上传，可避开 GitHub API 匿名限流）。
 */
export function parseReleaseManifest(payload: unknown, target: TUpdateBrowserTarget): IUpdateReleaseInfo | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const rawTag =
    typeof record.tagName === "string"
      ? record.tagName.trim()
      : typeof record.tag === "string"
        ? record.tag.trim()
        : typeof record.version === "string"
          ? record.version.trim()
          : "";
  const version = extractVersion(typeof record.version === "string" ? record.version : rawTag);
  if (!version) return null;

  const tagName = rawTag || `v${version}`;
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : tagName;
  const releaseUrl = isTrustedUpdateUrl(record.releaseUrl) ? record.releaseUrl.trim() : UPDATE_RELEASES_PAGE_URL;
  const publishedAt =
    typeof record.publishedAt === "string" && record.publishedAt.trim() ? record.publishedAt.trim() : undefined;
  const notes = typeof record.notes === "string" ? record.notes.trim() : "";

  const allAssets: IUpdateReleaseAsset[] = [];
  let preferredAsset: IUpdateReleaseAsset | undefined;

  if (Array.isArray(record.assets)) {
    for (const item of record.assets) {
      const normalized = normalizeAsset(item);
      if (normalized) allAssets.push(normalized);
    }
    preferredAsset = selectAssetForBrowser(allAssets, target);
  } else if (record.assets && typeof record.assets === "object") {
    const assetsMap = record.assets as Record<string, unknown>;
    for (const [key, item] of Object.entries(assetsMap)) {
      const normalized = normalizeAsset(item);
      if (!normalized) continue;
      allAssets.push(normalized);
      if (key === target && !preferredAsset) {
        preferredAsset = normalized;
      }
    }
    preferredAsset ??= selectAssetForBrowser(allAssets, target);
  }

  return {
    version,
    tagName,
    name,
    releaseUrl,
    ...(publishedAt ? { publishedAt } : {}),
    notes,
    source: "manifest",
    ...(preferredAsset ? { asset: preferredAsset } : {}),
    allAssets,
  };
}

/**
 * 解析 GitHub Releases API `/releases/latest` 响应。
 */
export function parseGitHubReleaseApi(payload: unknown, target: TUpdateBrowserTarget): IUpdateReleaseInfo | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.draft === true) return null;

  const rawTag = typeof record.tag_name === "string" ? record.tag_name.trim() : "";
  const rawName = typeof record.name === "string" ? record.name.trim() : "";
  const version = extractVersion(rawTag) ?? extractVersion(rawName);
  if (!version) return null;

  const tagName = rawTag || `v${version}`;
  const name = rawName || tagName;
  const releaseUrl = isTrustedUpdateUrl(record.html_url) ? record.html_url.trim() : UPDATE_RELEASES_PAGE_URL;
  const publishedAt =
    typeof record.published_at === "string" && record.published_at.trim() ? record.published_at.trim() : undefined;
  const notes = typeof record.body === "string" ? record.body.trim() : "";

  const rawAssets = Array.isArray(record.assets) ? record.assets : [];
  const allAssets = rawAssets
    .map((item) => normalizeAsset(item))
    .filter((item): item is IUpdateReleaseAsset => item !== null)
    .filter((item) => /\.(zip|crx|xpi)$/i.test(item.name));

  const preferredAsset = selectAssetForBrowser(allAssets, target);

  return {
    version,
    tagName,
    name,
    releaseUrl,
    ...(publishedAt ? { publishedAt } : {}),
    notes,
    source: "github-api",
    ...(preferredAsset ? { asset: preferredAsset } : {}),
    allAssets,
  };
}

/**
 * 根据当前运行版本重算检测状态的 status，避免用户手动升级覆盖并重载后仍展示过期的「有新版本」缓存。
 */
export function reconcileUpdateCheckState(
  state: IUpdateCheckState | null | undefined,
  currentVersion: string,
): IUpdateCheckState {
  const normalizedCurrent = extractVersion(currentVersion) ?? currentVersion;
  if (!state) {
    return {
      currentVersion: normalizedCurrent,
      checkedAt: 0,
      status: "idle",
    };
  }

  if (state.status === "error") {
    return {
      ...state,
      currentVersion: normalizedCurrent,
    };
  }

  if (!state.latest) {
    return {
      ...state,
      currentVersion: normalizedCurrent,
      status: state.checkedAt > 0 ? "up-to-date" : "idle",
    };
  }

  const cmp = compareVersion(state.latest.version, normalizedCurrent);
  const status: TUpdateCheckStatus = cmp === 1 ? "update-available" : "up-to-date";
  return {
    ...state,
    currentVersion: normalizedCurrent,
    status,
  };
}

/**
 * 是否存在「应当向用户主动提示」的未忽略新版本。
 */
export function hasUnignoredUpdate(state: IUpdateCheckState | null | undefined, ignoredVersion?: string): boolean {
  if (!state || state.status !== "update-available" || !state.latest) return false;
  const ignored = extractVersion(ignoredVersion ?? "");
  if (ignored && compareVersion(state.latest.version, ignored) === 0) {
    return false;
  }
  return true;
}

/**
 * 推导当前浏览器的扩展管理页面地址（供一键打开或复制引导）。
 */
export function getBrowserExtensionsPageUrl(target: TUpdateBrowserTarget, userAgent = ""): string {
  if (target === "firefox") {
    return "about:debugging#/runtime/this-firefox";
  }
  if (userAgent.includes("Edg/")) {
    return "edge://extensions";
  }
  return "chrome://extensions";
}
